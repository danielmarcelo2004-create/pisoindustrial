// Conciliação bancária — partes sem acesso ao banco (tipos, sugestão automática e tipo provável),
// separadas para poderem ser testadas sozinhas (tests/conciliacao.test.mts).

export type Classificacao = "tarifa" | "aplicacao" | "entrada" | "transferencia" | "cartao" | "imposto" | "emprestimo" | "outro";
export const CLASSIFICACOES: Record<Classificacao, string> = {
  tarifa: "Tarifa bancária",
  aplicacao: "Aplicação / resgate",
  entrada: "Entrada recebida",
  transferencia: "Transferência entre contas",
  cartao: "Cartão de crédito",
  imposto: "Imposto / tributo",
  emprestimo: "Empréstimo / consórcio / capitalização",
  outro: "Outro",
};

export type LinhaExtrato = {
  id: string;
  data: string;
  valor: number;
  descricao: string;
  tipo: string;
  situacao: "pendente" | "conciliada" | "arquivada";
  classificacao: Classificacao | null;
  observacao: string | null;
  encargos: number | null;
};

export type Candidato = {
  chave: string; // pag:<id> ou parc:<id>
  tipo: "pagamento" | "parcela";
  id: string;
  pagamentoId: string;
  numero: number;
  parcela: string | null; // "2/3"
  favorecido: string;
  fornecedor: string | null;
  documento: string | null; // CPF/CNPJ do fornecedor (só dígitos)
  descricao: string;
  obra: string;
  categoria: string | null;
  forma: string;
  contaId: string | null; // conta bancária da despesa
  contaNome: string | null;
  valor: number; // a pagar (em aberto) ou o valor pago
  data: string; // vencimento (em aberto) ou data do pagamento
  pago: boolean;
};

export type Sugestao =
  | { tipo: "conta"; candidato: Candidato; nivel: "encontramos" | "quase"; motivo: string; diferenca: number }
  | { tipo: "classificar"; classificacao: Classificacao };

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const dias = (a: string, b: string) => Math.round(Math.abs(new Date(a + "T12:00:00Z").getTime() - new Date(b + "T12:00:00Z").getTime()) / 86400000);
const iguais = (a: number, b: number) => Math.abs(a - b) < 0.005;
// Palavras que não identificam ninguém: termos de empresa e os que o próprio banco escreve na descrição
const PALAVRAS_VAZIAS = new Set([
  "LTDA", "EIRELI", "COMERCIO", "SERVICO", "SERVICOS", "MATERIAIS", "CONSTRUCAO", "CONSTRUCOES", "DISTRIBUIDORA", "INDUSTRIA", "EMPRESA", "BRASIL", "FORNECEDOR",
  "BOLETO", "PAGAMENTO", "PAGTO", "ENVIADO", "ENVIADA", "RECEBIDO", "RECEBIDA", "CHAVE", "TRANSF", "TRANSFERENCIA", "TRANSFERIDO", "DEBITO", "CREDITO",
  "CONTA", "TARIFA", "COMPRA", "CARTAO", "INTERNET", "DEPOSITO", "SAQUE", "TITULO", "CONVENIO", "IMPOSTO", "IMPOSTOS",
]);

/** O nome ou o CPF/CNPJ do favorecido aparece na descrição do banco? (O BB informa; a Caixa não.) */
function nomeConfere(desc: string, c: Candidato) {
  const d = semAcento(desc);
  const digitos = d.replace(/\D/g, "");
  if (c.documento && c.documento.length >= 11 && digitos.includes(c.documento)) return true;
  for (const nome of [c.favorecido, c.fornecedor ?? ""]) {
    const palavras = semAcento(nome)
      .split(/[^A-Z0-9]+/)
      .filter((p) => p.length >= 4 && !PALAVRAS_VAZIAS.has(p));
    if (palavras.length && palavras.slice(0, 2).some((p) => new RegExp(`\\b${p}`).test(d))) return true;
  }
  return false;
}

/** Tipo provável de linhas que não são contas a pagar. */
export function classificacaoProvavel(descricao: string, valor: number): Classificacao | null {
  const d = semAcento(descricao);
  if (/RENDE FACIL|APLICACAO|APLIC\b|RESGATE|POUPANCA|INVEST/.test(d)) return "aplicacao";
  if (/^TAR\b|\bTARIFA|TAR PIX|CESTA SERVICO|PACOTE DE SERVICO|MENSALIDADE CESTA|IOF\b/.test(d)) return "tarifa";
  // Pagamento de FATURA não recebe tipo: costuma ser conciliado com várias compras no cartão (uma saída → várias contas)
  if (/PAGTO CARTAO|PAGAMENTO CARTAO|FATURA/.test(d)) return null;
  if (/COMPRA COM CARTAO|COMPRA C\/CARTAO|COMPRA CARTAO/.test(d)) return "cartao";
  if (/CONSORCIO|CAPITALIZACAO|EMPRESTIMO|FINANCIAMENTO/.test(d)) return "emprestimo";
  if (valor > 0) return "entrada";
  return null;
}

/** Tolerância de "valor muito próximo": até 5% da conta (mínimo de R$ 1,00) — juros, multa, desconto, centavos. */
export const tolerancia = (valor: number) => Math.max(1, Math.round(valor * 5) / 100);

/**
 * SÓ SUGERE — nada é conciliado sem o clique do Financeiro.
 * Saídas: procura a conta a pagar com valor igual (ou muito próximo) e a data mais próxima (vencimento, se em aberto;
 * data da baixa, se já paga), com bônus quando o nome/CNPJ aparece na descrição (o BB informa; a Caixa não).
 * "Encontramos" (verde): valor igual e já paga na mesma data (±1 dia), em aberto vencendo até 5 dias de diferença,
 * ou nome confere até 30 dias. "Quase lá" (amarelo): valor igual até 45 dias, ou valor muito próximo (tolerância).
 * Cada conta é sugerida para uma linha só; valor igual sempre tem preferência.
 */
export function sugerir(linhas: LinhaExtrato[], candidatos: Candidato[], contaId: string | null = null): Map<string, Sugestao> {
  const pares: { linha: LinhaExtrato; c: Candidato; nivel: "encontramos" | "quase"; nome: boolean; d: number; dif: number; outraConta: boolean }[] = [];
  for (const l of linhas) {
    if (l.situacao !== "pendente" || l.valor >= 0) continue;
    for (const c of candidatos) {
      const dif = Math.round((-l.valor - c.valor) * 100) / 100;
      const exato = iguais(dif, 0);
      if (!exato && (c.pago || Math.abs(dif) > tolerancia(c.valor))) continue; // já paga: só com o valor exato
      const d = dias(c.data, l.data);
      if (d > 45) continue;
      const nome = nomeConfere(l.descricao, c);
      // Prioridade para despesas desta conta bancária ou sem conta; de outra conta, no máximo "Quase lá"
      const outraConta = Boolean(contaId && c.contaId && c.contaId !== contaId);
      const verde = !outraConta && exato && ((c.pago && d <= 1) || (!c.pago && d <= 5) || (nome && d <= 30));
      pares.push({ linha: l, c, nivel: verde ? "encontramos" : "quase", nome, d, dif: exato ? 0 : dif, outraConta });
    }
  }
  pares.sort(
    (a, b) =>
      (a.nivel === b.nivel ? 0 : a.nivel === "encontramos" ? -1 : 1) ||
      Number(a.outraConta) - Number(b.outraConta) ||
      Number(a.dif !== 0) - Number(b.dif !== 0) ||
      Number(b.nome) - Number(a.nome) ||
      Math.abs(a.dif) - Math.abs(b.dif) ||
      a.d - b.d ||
      Number(b.c.pago) - Number(a.c.pago),
  );
  const res = new Map<string, Sugestao>();
  const usados = new Set<string>();
  const br = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const p of pares) {
    if (res.has(p.linha.id) || usados.has(p.c.chave)) continue;
    usados.add(p.c.chave);
    const quando = p.c.pago ? `pago em ${p.c.data.split("-").reverse().join("/")}` : `vence em ${p.c.data.split("-").reverse().join("/")}`;
    const valor = p.dif === 0 ? "Mesmo valor" : `Valor próximo: o banco pagou R$ ${br(Math.abs(p.dif))} a ${p.dif > 0 ? "mais" : "menos"}`;
    res.set(p.linha.id, {
      tipo: "conta",
      candidato: p.c,
      nivel: p.nivel,
      diferenca: p.dif,
      motivo: `${valor}${p.nome ? ", nome confere" : ""} · ${quando}${p.d ? ` (${p.d} dia${p.d > 1 ? "s" : ""} de diferença)` : " (mesma data)"}${p.outraConta ? ` · lançada em outra conta (${p.c.contaNome}); ao conciliar, passa para esta` : ""}`,
    });
  }
  for (const l of linhas) {
    if (l.situacao !== "pendente" || res.has(l.id)) continue;
    const c = classificacaoProvavel(l.descricao, l.valor);
    if (c) res.set(l.id, { tipo: "classificar", classificacao: c });
  }
  return res;
}
