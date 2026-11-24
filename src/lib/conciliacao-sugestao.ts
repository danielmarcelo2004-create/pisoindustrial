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
  transferencia_id?: string | null;
  estorno_linha?: string | null;
  recebimento_id?: string | null;
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

export type TransferenciaAberta = { id: string; contaOrigem: string; contaDestino: string; outraConta: string; valor: number; data: string; descricao: string };

export type Sugestao =
  | { tipo: "conta"; candidato: Candidato; nivel: "encontramos" | "quase"; motivo: string; diferenca: number }
  | { tipo: "classificar"; classificacao: Classificacao }
  | { tipo: "transferencia"; transferencia: TransferenciaAberta }
  | { tipo: "estorno"; saida: SaidaEstornavel }
  | { tipo: "aplicacao" } // aplicação/resgate automático (BB Rende Fácil) conciliado na própria conta
  | { tipo: "receita"; receita: ReceitaAberta; liquido: boolean }; // entrada = receita em aberto (ou receita − imposto retido)

/** Receita em aberto em Contas a receber; "retido" é o imposto retido da medição ainda a pagar. */
export type ReceitaAberta = { id: string; numero: number; cliente: string; descricao: string; obra: string; valor: number; retido: number; vencimento: string };

/** Saída da mesma conta que um estorno pode devolver (pendente, ou já conciliada com uma conta paga). */
export type SaidaEstornavel = { id: string; data: string; valor: number; descricao: string; situacao: "pendente" | "conciliada"; conciliadaCom: string | null };

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const dias = (a: string, b: string) => Math.round(Math.abs(new Date(a + "T12:00:00Z").getTime() - new Date(b + "T12:00:00Z").getTime()) / 86400000);
const iguais = (a: number, b: number) => Math.abs(a - b) < 0.005;
// Palavras que não identificam ninguém: termos de empresa e os que o próprio banco escreve na descrição
const PALAVRAS_VAZIAS = new Set([
  "LTDA", "EIRELI", "COMERCIO", "SERVICO", "SERVICOS", "MATERIAIS", "CONSTRUCAO", "CONSTRUCOES", "DISTRIBUIDORA", "INDUSTRIA", "EMPRESA", "BRASIL", "FORNECEDOR",
  "BOLETO", "PAGAMENTO", "PAGTO", "ENVIADO", "ENVIADA", "RECEBIDO", "RECEBIDA", "CHAVE", "TRANSF", "TRANSFERENCIA", "TRANSFERIDO", "DEBITO", "CREDITO",
  "CONTA", "TARIFA", "COMPRA", "CARTAO", "INTERNET", "DEPOSITO", "SAQUE", "TITULO", "CONVENIO", "IMPOSTO", "IMPOSTOS",
]);

/** Algum dos nomes (ou o CPF/CNPJ) aparece na descrição do banco? (O BB informa; a Caixa não.) */
export function nomesConferem(desc: string, nomes: (string | null | undefined)[], documento?: string | null) {
  const d = semAcento(desc);
  const digitos = d.replace(/\D/g, "");
  if (documento && documento.length >= 11 && digitos.includes(documento)) return true;
  for (const nome of nomes) {
    const palavras = semAcento(nome ?? "")
      .split(/[^A-Z0-9]+/)
      .filter((p) => p.length >= 4 && !PALAVRAS_VAZIAS.has(p));
    if (palavras.length && palavras.slice(0, 2).some((p) => new RegExp(`\\b${p}`).test(d))) return true;
  }
  return false;
}
const nomeConfere = (desc: string, c: Candidato) => nomesConferem(desc, [c.favorecido, c.fornecedor], c.documento);

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
  // Aplicação/resgate automático (BB Rende Fácil, poupança): conciliado na própria conta, como no Conta Azul
  for (const l of linhas) {
    if (l.situacao === "pendente" && !res.has(l.id) && classificacaoProvavel(l.descricao, l.valor) === "aplicacao") res.set(l.id, { tipo: "aplicacao" });
  }
  // Sem dica de arquivar: aplicação/resgate ficam na conta, tarifa/IOF/empréstimo e compra no cartão viram
  // novo lançamento de despesa, entrada vira recebimento (Contas a receber) e estorno se concilia com a saída.
  return res;
}


/**
 * Transferência já registrada na outra conta que espera esta movimentação: mesmo valor, sentido certo
 * (saída na origem / entrada no destino) e data até 5 dias de diferença. Uma transferência por linha.
 */
export function sugerirTransferencias(linhas: LinhaExtrato[], abertas: TransferenciaAberta[], contaId: string): Map<string, TransferenciaAberta> {
  const res = new Map<string, TransferenciaAberta>();
  const usadas = new Set<string>();
  const pares: { l: LinhaExtrato; t: TransferenciaAberta; d: number }[] = [];
  for (const l of linhas) {
    if (l.situacao !== "pendente") continue;
    for (const t of abertas) {
      if (!iguais(t.valor, Math.abs(l.valor))) continue;
      if (l.valor > 0 ? t.contaDestino !== contaId : t.contaOrigem !== contaId) continue;
      const d = dias(t.data, l.data);
      if (d <= 5) pares.push({ l, t, d });
    }
  }
  pares.sort((a, b) => a.d - b.d);
  for (const p of pares) {
    if (res.has(p.l.id) || usadas.has(p.t.id)) continue;
    usadas.add(p.t.id);
    res.set(p.l.id, p.t);
  }
  return res;
}

/** Lançamentos já feitos, para sugerir categoria/centro de custo/fornecedor de um novo lançamento. */
export type Historico = {
  memo: string | null; // descrição do banco, quando o lançamento foi conciliado
  favorecido: string;
  fornecedorId: string | null;
  fornecedor: string | null;
  documento: string | null;
  categoriaId: string | null;
  obraId: string;
  data: string; // mais recente vence
};
export type SugestaoLancamento = { descricao: string; categoriaId: string | null; obraId: string | null; fornecedorId: string | null; origem: "extrato" | "nome" | "palavra" | null };

/** Texto do banco sem datas, horas e números (o que se repete de um mês para outro). */
export function chaveMemo(desc: string) {
  return semAcento(desc)
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^A-Z]+/g, " ")
    .trim();
}

// Palavras do banco → nome de categoria provável (procura uma categoria com esse nome cadastrada)
const PALAVRAS_CATEGORIA: [RegExp, RegExp][] = [
  [/^TAR\b|\bTARIFA|TAR PIX|CESTA|PACOTE DE SERV|MENSALIDADE|\bIOF\b|ANUIDADE/, /TARIFA|BANCARI/],
  [/EMPRESTIMO|FINANCIAMENTO|CONSORCIO|CAPITALIZACAO/, /EMPRESTIMO|FINANCIAMENTO|CONSORCIO|CAPITALIZACAO/],
  [/DARF|IMPOSTO|RFB|SIMPLES NAC|\bINSS\b|\bFGTS\b|\bISS\b|\bGPS\b|SEFAZ|\bDAE\b|\bDAM\b/, /IMPOSTO|TRIBUT|ENCARGO/],
  [/SALARIO|FOLHA|ADIANT|PRO LABORE|PROLABORE/, /SALARIO|FOLHA|PESSOAL|PRO LABORE/],
  [/COMBUST|POSTO|GASOLINA|DIESEL|ETANOL/, /COMBUST/],
  [/ENERGIA|COELBA|NEOENERGIA|ENEL|CEMIG|COPEL|\bLUZ\b/, /ENERGIA|\bLUZ\b/],
  [/\bAGUA\b|EMBASA|SABESP|DESO|CASAN/, /\bAGUA\b/],
  [/ALUGUEL|LOCACAO/, /ALUGUEL|LOCACAO/],
  [/TELEFON|INTERNET|VIVO|CLARO|\bTIM\b|\bOI\b/, /TELEFON|INTERNET|COMUNICA/],
];

/**
 * Sugestão para "Novo lançamento" (o ⚡ do Conta Azul): 1) a mesma descrição do banco já conciliada antes;
 * 2) o nome/CNPJ de um favorecido ou fornecedor aparece na descrição; 3) palavras do banco (DARF, salário…)
 * apontam uma categoria cadastrada. A descrição vem do próprio banco. Só sugere: nada é gravado.
 */
export function sugerirLancamento(desc: string, historico: Historico[], categorias: { id: string; nome: string }[]): SugestaoLancamento {
  const descricao = desc.replace(/\s+/g, " ").trim();
  const recentes = [...historico].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  const chave = chaveMemo(desc);
  const mesmo = chave ? recentes.find((h) => h.memo && chaveMemo(h.memo) === chave) : undefined;
  if (mesmo) return { descricao, categoriaId: mesmo.categoriaId, obraId: mesmo.obraId, fornecedorId: mesmo.fornecedorId, origem: "extrato" };
  const porNome = recentes.find((h) => nomesConferem(desc, [h.fornecedor, h.favorecido], h.documento));
  if (porNome) return { descricao, categoriaId: porNome.categoriaId, obraId: porNome.obraId, fornecedorId: porNome.fornecedorId, origem: "nome" };
  const d = semAcento(desc);
  for (const [banco, cat] of PALAVRAS_CATEGORIA) {
    if (!banco.test(d)) continue;
    const c = categorias.find((x) => cat.test(semAcento(x.nome)));
    if (c) return { descricao, categoriaId: c.id, obraId: null, fornecedorId: null, origem: "palavra" };
  }
  return { descricao, categoriaId: null, obraId: null, fornecedorId: null, origem: null };
}


/** A descrição do banco indica devolução de uma saída (PIX devolvido, TED estornada, boleto rejeitado…)? */
export function pareceEstorno(desc: string) {
  return /ESTORN|DEVOLU|DEVOLVID|REJEITAD|RECUSAD|\bEST\b/.test(semAcento(desc));
}

/** Saídas que esta entrada pode estornar: mesmo valor, anteriores (até 30 dias); a mais próxima primeiro. */
export function saidasParaEstorno(credito: LinhaExtrato, saidas: SaidaEstornavel[], limiteDias = 30) {
  if (credito.valor <= 0) return [];
  return saidas
    .filter((s) => s.id !== credito.id && iguais(-s.valor, credito.valor) && s.data <= credito.data && dias(s.data, credito.data) <= limiteDias)
    .sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0) || Number(a.situacao === "conciliada") - Number(b.situacao === "conciliada"));
}

/**
 * Sugestão de estorno ("Encontramos"): entrada pendente com palavra de estorno/devolução e uma saída da mesma
 * conta com o mesmo valor até 10 dias antes. Cada saída é sugerida para um estorno só.
 */
export function sugerirEstornos(linhas: LinhaExtrato[], saidas: SaidaEstornavel[]): Map<string, SaidaEstornavel> {
  const res = new Map<string, SaidaEstornavel>();
  const usadas = new Set<string>();
  const creditos = linhas.filter((l) => l.situacao === "pendente" && l.valor > 0 && pareceEstorno(l.descricao)).sort((a, b) => (a.data < b.data ? -1 : 1));
  for (const c of creditos) {
    const s = saidasParaEstorno(c, saidas, 10).find((x) => !usadas.has(x.id));
    if (!s) continue;
    usadas.add(s.id);
    res.set(c.id, s);
  }
  return res;
}


/** Recebimentos já lançados, para sugerir centro de custo, categoria e cliente de uma nova entrada. */
export type HistoricoReceita = { memo: string | null; cliente: string; categoriaId: string | null; obraId: string; data: string };
export type SugestaoRecebimento = { descricao: string; categoriaId: string | null; obraId: string | null; cliente: string; origem: "extrato" | "nome" | "palavra" | null };

/** "Novo lançamento" de receita: mesma descrição do banco já lançada; cliente na descrição; "medição" → categoria de medição. */
export function sugerirRecebimento(desc: string, historico: HistoricoReceita[], categorias: { id: string; nome: string }[]): SugestaoRecebimento {
  const descricao = desc.replace(/\s+/g, " ").trim();
  const recentes = [...historico].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));
  const chave = chaveMemo(desc);
  const mesmo = chave ? recentes.find((h) => h.memo && chaveMemo(h.memo) === chave) : undefined;
  if (mesmo) return { descricao, categoriaId: mesmo.categoriaId, obraId: mesmo.obraId, cliente: mesmo.cliente, origem: "extrato" };
  const porNome = recentes.find((h) => nomesConferem(desc, [h.cliente]));
  if (porNome) return { descricao, categoriaId: porNome.categoriaId, obraId: porNome.obraId, cliente: porNome.cliente, origem: "nome" };
  if (/MEDIC/.test(semAcento(desc))) {
    const c = categorias.find((x) => /MEDIC/.test(semAcento(x.nome)));
    if (c) return { descricao, categoriaId: c.id, obraId: null, cliente: "", origem: "palavra" };
  }
  return { descricao, categoriaId: null, obraId: null, cliente: "", origem: null };
}

/**
 * Entrada do extrato × receita em aberto: valor igual ao total, ou igual ao total menos o imposto retido
 * (medição: o banco paga o líquido). Vencimento até 45 dias de diferença; o mais próximo primeiro;
 * cada receita para uma entrada só.
 */
export function sugerirReceitas(linhas: LinhaExtrato[], abertas: ReceitaAberta[]): Map<string, { receita: ReceitaAberta; liquido: boolean }> {
  const pares: { l: LinhaExtrato; r: ReceitaAberta; liquido: boolean; d: number }[] = [];
  for (const l of linhas) {
    if (l.situacao !== "pendente" || l.valor <= 0) continue;
    for (const r of abertas) {
      const total = iguais(l.valor, r.valor);
      const liquido = r.retido > 0 && iguais(l.valor, r.valor - r.retido);
      if (!total && !liquido) continue;
      const d = dias(r.vencimento, l.data);
      if (d <= 45) pares.push({ l, r, liquido: !total && liquido, d });
    }
  }
  pares.sort((a, b) => a.d - b.d);
  const res = new Map<string, { receita: ReceitaAberta; liquido: boolean }>();
  const usadas = new Set<string>();
  for (const p of pares) {
    if (res.has(p.l.id) || usadas.has(p.r.id)) continue;
    usadas.add(p.r.id);
    res.set(p.l.id, { receita: p.r, liquido: p.liquido });
  }
  return res;
}
