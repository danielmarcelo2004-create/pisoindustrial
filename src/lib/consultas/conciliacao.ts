// Conciliação bancária: contas, linhas do extrato, contas a pagar candidatas e a sugestão automática.
import "server-only";
import { createClient } from "@/lib/supabase/server";

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

export async function contasBancarias() {
  const supabase = await createClient();
  const [{ data: contas }, { data: saldos }, { data: pend }] = await Promise.all([
    supabase.from("contas_bancarias").select("id, nome, banco, agencia, conta").eq("ativa", true).order("nome"),
    supabase.rpc("saldos_contas_bancarias"), // saldo: só Financeiro/master
    supabase.from("extrato_linhas").select("conta_id, valor").eq("situacao", "pendente").limit(50000),
  ]);
  const saldo = new Map((saldos ?? []).map((x) => [x.id, x]));
  const qtd = new Map<string, number>();
  const soma = new Map<string, number>();
  for (const l of pend ?? []) {
    qtd.set(l.conta_id, (qtd.get(l.conta_id) ?? 0) + 1);
    soma.set(l.conta_id, (soma.get(l.conta_id) ?? 0) + Number(l.valor));
  }
  return (contas ?? []).map((c) => {
    const s = saldo.get(c.id);
    return {
      ...c,
      saldo: s?.saldo === null || s?.saldo === undefined ? null : Number(s.saldo),
      saldo_em: s?.saldo_em ?? null,
      pendentes: qtd.get(c.id) ?? 0,
      valorPendente: Math.round((soma.get(c.id) ?? 0) * 100) / 100,
    };
  });
}

export type FiltroLinhas = { mes: string; busca: string; tipo: "" | "entradas" | "saidas"; ordem: "antigas" | "recentes" | "maior" };

/** Linhas da conta na situação, com mês (AAAA-MM ou "todos"), pesquisa (descrição ou valor), tipo e ordem. */
export async function linhasDaConta(contaId: string, situacao: LinhaExtrato["situacao"], f: FiltroLinhas = { mes: "todos", busca: "", tipo: "", ordem: "antigas" }) {
  const supabase = await createClient();
  let q = supabase.from("extrato_linhas").select("id, data, valor, descricao, tipo, situacao, classificacao, observacao, encargos").eq("conta_id", contaId).eq("situacao", situacao);
  if (/^\d{4}-\d{2}$/.test(f.mes)) {
    const [a, m] = f.mes.split("-").map(Number);
    q = q.gte("data", `${f.mes}-01`).lte("data", `${f.mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`);
  }
  if (f.tipo === "entradas") q = q.gt("valor", 0);
  if (f.tipo === "saidas") q = q.lt("valor", 0);
  const busca = f.busca.trim();
  if (busca) {
    const num = Number(busca.replace(/[R$\s]/g, "").replace(/\./g, "").replace(",", "."));
    q = Number.isFinite(num) && num > 0 && /\d/.test(busca) ? q.in("valor", [num, -num]) : q.ilike("descricao", `%${busca.replace(/[%_\\]/g, " ")}%`);
  }
  q = f.ordem === "maior" ? q.order("valor", { ascending: true }) : q.order("data", { ascending: f.ordem !== "recentes" ? situacao === "pendente" : false });
  const { data } = await q.order("created_at").limit(situacao === "pendente" ? 1000 : 300);
  return (data ?? []).map((l) => ({ ...l, valor: Number(l.valor), encargos: l.encargos === null ? null : Number(l.encargos) })) as LinhaExtrato[];
}

/** Datas para o cabeçalho: última importação e último lançamento importado. */
export async function datasDaConta(contaId: string) {
  const supabase = await createClient();
  const [{ data: imp }, { data: ult }] = await Promise.all([
    supabase.from("extrato_importacoes").select("created_at").eq("conta_id", contaId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("extrato_linhas").select("data").eq("conta_id", contaId).order("data", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return { importadoEm: imp?.created_at ?? null, ultimoLancamento: ult?.data ?? null };
}

export async function contagemPorSituacao(contaId: string) {
  const supabase = await createClient();
  const conta = async (s: string) => (await supabase.from("extrato_linhas").select("id", { count: "exact", head: true }).eq("conta_id", contaId).eq("situacao", s)).count ?? 0;
  const [pendente, conciliada, arquivada] = await Promise.all([conta("pendente"), conta("conciliada"), conta("arquivada")]);
  return { pendente, conciliada, arquivada };
}

/** Contas a pagar que podem ser conciliadas: liberadas em aberto (e parcelas) e as já pagas ainda sem conciliação. */
export async function candidatos(periodo: { de: string; ate: string } | null): Promise<Candidato[]> {
  const supabase = await createClient();
  const SEL = "id, numero, favorecido, descricao, valor, vencimento, status, forma_pagamento, conta_bancaria_id, conta_bancaria:contas_bancarias(nome), pago_em, valor_pago, obra:obras(nome), categoria:categorias(nome), fornecedor:fornecedores(nome, cpf_cnpj), parcelas:pagamento_parcelas(id, numero, valor_base, multa, juros, desconto, vencimento, status, pago_em, valor_pago)";
  const de = periodo ? new Date(new Date(periodo.de + "T12:00:00Z").getTime() - 60 * 86400000).toISOString().slice(0, 10) : null;
  const ate = periodo ? new Date(new Date(periodo.ate + "T12:00:00Z").getTime() + 60 * 86400000).toISOString().slice(0, 10) : null;
  let qPago = supabase.from("pagamentos").select(SEL).eq("status", "pago");
  if (de && ate) qPago = qPago.gte("pago_em", de).lte("pago_em", ate);
  const [{ data: abertos }, { data: pagos }, { data: ligados }] = await Promise.all([
    supabase.from("pagamentos").select(SEL).eq("status", "aguardando_pagamento").limit(2000),
    qPago.limit(3000),
    supabase.from("conciliacao_itens").select("pagamento_id, parcela_id").limit(50000),
  ]);
  const pagLigado = new Set((ligados ?? []).filter((x) => !x.parcela_id).map((x) => x.pagamento_id));
  const parcLigada = new Set((ligados ?? []).filter((x) => x.parcela_id).map((x) => x.parcela_id as string));
  const um = <T,>(x: T | T[] | null) => (Array.isArray(x) ? (x[0] ?? null) : x);
  const lista: Candidato[] = [];
  for (const p of [...(abertos ?? []), ...(pagos ?? [])]) {
    const obra = um(p.obra as { nome: string } | { nome: string }[] | null);
    const forn = um(p.fornecedor as { nome: string; cpf_cnpj: string | null } | { nome: string; cpf_cnpj: string | null }[] | null);
    const base = {
      pagamentoId: p.id,
      numero: Number(p.numero),
      favorecido: p.favorecido,
      fornecedor: forn?.nome ?? null,
      documento: forn?.cpf_cnpj ? forn.cpf_cnpj.replace(/\D/g, "") : null,
      descricao: p.descricao,
      obra: obra?.nome ?? "",
      categoria: um(p.categoria as { nome: string } | { nome: string }[] | null)?.nome ?? null,
      forma: p.forma_pagamento as string,
      contaId: (p.conta_bancaria_id as string | null) ?? null,
      contaNome: um(p.conta_bancaria as { nome: string } | { nome: string }[] | null)?.nome ?? null,
    };
    const parcelas = (p.parcelas ?? []) as { id: string; numero: number; valor_base: number; multa: number; juros: number; desconto: number; vencimento: string; status: string; pago_em: string | null; valor_pago: number | null }[];
    if (parcelas.length) {
      for (const pc of parcelas) {
        if (parcLigada.has(pc.id)) continue;
        const pago = pc.status === "pago";
        if (pago && de && ate && (!pc.pago_em || pc.pago_em < de || pc.pago_em > ate)) continue;
        if (!pago && p.status !== "aguardando_pagamento") continue;
        lista.push({
          ...base,
          chave: `parc:${pc.id}`,
          tipo: "parcela",
          id: pc.id,
          parcela: `${pc.numero}/${parcelas.length}`,
          valor: pago ? Number(pc.valor_pago) : Math.round((Number(pc.valor_base) + Number(pc.multa) + Number(pc.juros) - Number(pc.desconto)) * 100) / 100,
          data: pago ? (pc.pago_em as string) : pc.vencimento,
          pago,
        });
      }
      continue;
    }
    if (pagLigado.has(p.id)) continue;
    const pago = p.status === "pago";
    lista.push({ ...base, chave: `pag:${p.id}`, tipo: "pagamento", id: p.id, parcela: null, valor: Number(pago ? p.valor_pago : p.valor), data: pago ? (p.pago_em as string) : p.vencimento, pago });
  }
  // Parcelas de pagamentos já quitados aparecem pela consulta de pagos; evita repetir
  const vistos = new Set<string>();
  return lista.filter((c) => (vistos.has(c.chave) ? false : (vistos.add(c.chave), true)));
}

/** Contas ligadas a cada linha conciliada. */
export async function itensConciliados(linhaIds: string[]) {
  if (!linhaIds.length) return new Map<string, { pagamentoId: string; numero: number; favorecido: string; parcela: number | null; valor: number; baixou: boolean }[]>();
  const supabase = await createClient();
  const { data } = await supabase
    .from("conciliacao_itens")
    .select("linha_id, pagamento_id, valor, baixou, pagamento:pagamentos(numero, favorecido), parcela:pagamento_parcelas(numero)")
    .in("linha_id", linhaIds);
  const m = new Map<string, { pagamentoId: string; numero: number; favorecido: string; parcela: number | null; valor: number; baixou: boolean }[]>();
  for (const i of data ?? []) {
    const p = (Array.isArray(i.pagamento) ? i.pagamento[0] : i.pagamento) as { numero: number; favorecido: string } | null;
    const pc = (Array.isArray(i.parcela) ? i.parcela[0] : i.parcela) as { numero: number } | null;
    const arr = m.get(i.linha_id) ?? [];
    arr.push({ pagamentoId: i.pagamento_id, numero: Number(p?.numero), favorecido: p?.favorecido ?? "", parcela: pc?.numero ?? null, valor: Number(i.valor), baixou: i.baixou });
    m.set(i.linha_id, arr);
  }
  return m;
}
