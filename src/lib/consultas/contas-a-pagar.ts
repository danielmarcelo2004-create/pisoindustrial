import "server-only";
import { hojeISO } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import type { FormaPagamento, StatusPagamento } from "@/lib/rotulos";

// Lista de "Contas a pagar": uma linha por conta — pagamento à vista ou cada parcela no seu vencimento —
// mais as provisões do período (só informativas). Os cartões de totais usam as mesmas linhas.

export type Situacao = "pago" | "vencido" | "hoje" | "a_pagar" | "aprovacao" | "rejeitado" | "cancelado" | "provisao";
export type FiltroCartao = "vencidos" | "hoje" | "avencer" | "aprovacao" | "pagos" | "liberados" | "abertos" | "";

export type LinhaConta = {
  chave: string;
  tipo: "pagamento" | "parcela" | "provisao";
  pagamentoId: string | null;
  parcelaId: string | null;
  ordemId: string | null;
  numero: number | null;
  favorecido: string;
  descricao: string;
  categoria: string | null;
  obra: string | null;
  forma: FormaPagamento | null;
  /** Conta bancária de onde sai o pagamento. */
  conta: string | null;
  lancadoConciliacao: boolean;
  vencimento: string | null;
  pagoEm: string | null;
  valor: number;
  aPagar: number;
  situacao: Situacao;
  statusPagamento: StatusPagamento | null;
  parcela: { n: number; total: number } | null;
  repeticao: string | null;
  temAnexo: boolean;
  baixavel: boolean;
  criadoPor: string | null;
  /** Provisão (para a janela "Lançar despesa"). */
  provisao?: { id: string; descricao: string; obra: string | null; vencimento: string | null; valor: number | null; serie: boolean };
  /** Grupo do cartão de totais (mutuamente exclusivos). */
  grupo: "pagos" | "vencidos" | "hoje" | "aprovacao" | "avencer" | "cancelado" | "provisao";
};

export type FiltrosContas = {
  mes: string; // AAAA-MM ou "todos"
  de?: string;
  ate?: string;
  busca?: string;
  obra?: string;
  forma?: string;
  categoria?: string;
  conta?: string;
  fornecedor?: string;
  cartao?: FiltroCartao;
  cancelados?: boolean;
  /** Só as despesas lançadas direto pela conciliação bancária. */
  lancados?: boolean;
};

const SEL_PAG =
  "id, numero, favorecido, descricao, valor, vencimento, status, forma_pagamento, pago_em, valor_pago, ordem_id, created_by, obra_id, categoria_id, fornecedor_id, conta_bancaria_id, lancado_conciliacao, categoria:categorias(nome), obra:obras(nome), conta_bancaria:contas_bancarias(nome), documentos(ativo), parcelas:pagamento_parcelas(id)";

function intervalo(f: FiltrosContas): [string | null, string | null] {
  if (f.de || f.ate) return [f.de || null, f.ate || null];
  if (f.mes === "todos") return [null, null];
  const [a, m] = f.mes.split("-").map(Number);
  const fim = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return [`${f.mes}-01`, `${f.mes}-${String(fim).padStart(2, "0")}`];
}

function grupoDe(situacao: Situacao, venc: string | null, hoje: string): LinhaConta["grupo"] {
  if (situacao === "pago") return "pagos";
  if (situacao === "cancelado") return "cancelado";
  if (situacao === "provisao") return "provisao";
  if (situacao === "aprovacao" || situacao === "rejeitado") return "aprovacao";
  if (venc && venc < hoje) return "vencidos";
  if (venc === hoje) return "hoje";
  return "avencer";
}

function situacaoAberta(status: StatusPagamento, venc: string | null, hoje: string): Situacao {
  if (status === "aguardando_engenheiro" || status === "aguardando_administrador") return "aprovacao";
  if (status === "rejeitado") return "rejeitado";
  if (status === "cancelado") return "cancelado";
  if (status === "pago") return "pago";
  return venc && venc < hoje ? "vencido" : venc === hoje ? "hoje" : "a_pagar";
}

export async function listarContas(f: FiltrosContas) {
  const supabase = await createClient();
  const hoje = hojeISO();
  const [de, ate] = intervalo(f);
  const busca = (f.busca ?? "").replace(/[%,()*\\]/g, " ").trim();
  const numBusca = /^\d+$/.test(busca) ? Number(busca) : null;

  // 1) Pagamentos (os parcelados viram linhas de parcela, abaixo)
  let qp = supabase.from("pagamentos").select(SEL_PAG);
  if (!f.cancelados) qp = qp.neq("status", "cancelado");
  if (de) qp = qp.gte("vencimento", de);
  if (ate) qp = qp.lte("vencimento", ate);
  if (f.obra) qp = qp.eq("obra_id", f.obra);
  if (f.forma) qp = qp.eq("forma_pagamento", f.forma as FormaPagamento);
  if (f.categoria) qp = qp.eq("categoria_id", f.categoria);
  if (f.conta) qp = qp.eq("conta_bancaria_id", f.conta);
  if (f.lancados) qp = qp.eq("lancado_conciliacao", true);
  if (f.fornecedor) qp = qp.eq("fornecedor_id", f.fornecedor);
  if (busca) qp = qp.or(numBusca !== null ? `numero.eq.${numBusca},favorecido.ilike.%${busca}%,descricao.ilike.%${busca}%` : `favorecido.ilike.%${busca}%,descricao.ilike.%${busca}%`);
  const consultaPags = qp.order("vencimento").limit(2000);

  // 2) Parcelas com vencimento no período
  let qc = supabase
    .from("pagamento_parcelas")
    .select(
      "id, numero, vencimento, valor_base, multa, juros, desconto, status, pago_em, valor_pago, pagamento:pagamentos!inner(id, numero, favorecido, descricao, status, forma_pagamento, ordem_id, created_by, obra_id, categoria_id, fornecedor_id, conta_bancaria_id, lancado_conciliacao, categoria:categorias(nome), obra:obras(nome), conta_bancaria:contas_bancarias(nome), documentos(ativo), parcelas:pagamento_parcelas(id))",
    );
  if (!f.cancelados) qc = qc.neq("pagamento.status", "cancelado");
  if (de) qc = qc.gte("vencimento", de);
  if (ate) qc = qc.lte("vencimento", ate);
  if (f.obra) qc = qc.eq("pagamento.obra_id", f.obra);
  if (f.forma) qc = qc.eq("pagamento.forma_pagamento", f.forma as FormaPagamento);
  if (f.categoria) qc = qc.eq("pagamento.categoria_id", f.categoria);
  if (f.conta) qc = qc.eq("pagamento.conta_bancaria_id", f.conta);
  if (f.lancados) qc = qc.eq("pagamento.lancado_conciliacao", true);
  if (f.fornecedor) qc = qc.eq("pagamento.fornecedor_id", f.fornecedor);
  if (busca) qc = qc.or(numBusca !== null ? `numero.eq.${numBusca},favorecido.ilike.%${busca}%,descricao.ilike.%${busca}%` : `favorecido.ilike.%${busca}%,descricao.ilike.%${busca}%`, { referencedTable: "pagamentos" });
  const consultaParcs = qc.order("vencimento").limit(2000);

  // 3) Provisões do período (não entram nos totais)
  let qv = supabase.from("provisoes").select("id, descricao, vencimento, valor_estimado, obra_id, created_by, pagamento_origem_id, obra:obras(nome), categoria:categorias(nome)").eq("status", "provisionada");
  if (de) qv = qv.gte("vencimento", de);
  if (ate) qv = qv.lte("vencimento", ate);
  if (f.obra) qv = qv.eq("obra_id", f.obra);
  if (f.categoria) qv = qv.eq("categoria_id", f.categoria);
  if (busca) qv = qv.ilike("descricao", `%${busca}%`);
  const semProvisoes = Boolean(f.forma || f.fornecedor || f.conta || f.lancados || f.mes === "todos");
  // As três consultas rodam em paralelo
  const [{ data: pags }, { data: pcs }, { data: provs }] = await Promise.all([
    consultaPags,
    consultaParcs,
    semProvisoes ? Promise.resolve({ data: [] as { id: string; descricao: string; vencimento: string | null; valor_estimado: number | null; created_by: string; pagamento_origem_id: string | null; obra: { nome: string } | null; categoria: { nome: string } | null }[] }) : qv.order("vencimento").limit(500),
  ]);

  const linhas: LinhaConta[] = [];
  for (const p of pags ?? []) {
    if ((p.parcelas?.length ?? 0) > 0) continue;
    const situacao = situacaoAberta(p.status, p.vencimento, hoje);
    linhas.push({
      chave: `pag:${p.id}`,
      tipo: "pagamento",
      pagamentoId: p.id,
      parcelaId: null,
      ordemId: p.ordem_id,
      numero: p.numero,
      favorecido: p.favorecido,
      descricao: p.descricao,
      categoria: p.categoria?.nome ?? null,
      obra: p.obra?.nome ?? null,
      forma: p.forma_pagamento,
      conta: (p as unknown as { conta_bancaria: { nome: string } | null }).conta_bancaria?.nome ?? null,
      lancadoConciliacao: Boolean((p as unknown as { lancado_conciliacao: boolean }).lancado_conciliacao),
      vencimento: p.vencimento,
      pagoEm: p.pago_em,
      valor: Number(p.valor),
      aPagar: p.status === "pago" ? 0 : Number(p.valor),
      situacao,
      statusPagamento: p.status,
      parcela: null,
      repeticao: null,
      temAnexo: (p.documentos ?? []).some((d) => d.ativo),
      baixavel: p.status === "aguardando_pagamento",
      criadoPor: p.created_by,
      grupo: grupoDe(situacao, p.vencimento, hoje),
    });
  }
  for (const pc of pcs ?? []) {
    const p = pc.pagamento as unknown as {
      id: string; numero: number; favorecido: string; descricao: string; status: StatusPagamento; forma_pagamento: FormaPagamento; ordem_id: string | null; created_by: string;
      categoria: { nome: string } | null; obra: { nome: string } | null; conta_bancaria: { nome: string } | null; lancado_conciliacao: boolean; documentos: { ativo: boolean }[] | null; parcelas: { id: string }[] | null;
    };
    const valor = Math.round((Number(pc.valor_base) + Number(pc.multa) + Number(pc.juros) - Number(pc.desconto)) * 100) / 100;
    const situacao: Situacao = pc.status === "pago" ? "pago" : situacaoAberta(p.status === "pago" ? "aguardando_pagamento" : p.status, pc.vencimento, hoje);
    linhas.push({
      chave: `parc:${pc.id}`,
      tipo: "parcela",
      pagamentoId: p.id,
      parcelaId: pc.id,
      ordemId: p.ordem_id,
      numero: p.numero,
      favorecido: p.favorecido,
      descricao: p.descricao,
      categoria: p.categoria?.nome ?? null,
      obra: p.obra?.nome ?? null,
      forma: p.forma_pagamento,
      conta: p.conta_bancaria?.nome ?? null,
      lancadoConciliacao: Boolean(p.lancado_conciliacao),
      vencimento: pc.vencimento,
      pagoEm: pc.pago_em,
      valor: pc.status === "pago" ? Number(pc.valor_pago ?? valor) : valor,
      aPagar: pc.status === "pago" ? 0 : valor,
      situacao,
      statusPagamento: p.status,
      parcela: { n: pc.numero, total: p.parcelas?.length ?? 1 },
      repeticao: null,
      temAnexo: (p.documentos ?? []).some((d) => d.ativo),
      baixavel: pc.status !== "pago" && p.status === "aguardando_pagamento",
      criadoPor: p.created_by,
      grupo: grupoDe(situacao, pc.vencimento, hoje),
    });
  }
  for (const v of provs ?? []) {
    const m = v.descricao.match(/ \((\d+\/\d+)\)$/);
    linhas.push({
      chave: `prov:${v.id}`,
      tipo: "provisao",
      pagamentoId: null,
      parcelaId: null,
      ordemId: null,
      numero: null,
      favorecido: m ? v.descricao.replace(/ \(\d+\/\d+\)$/, "") : v.descricao,
      descricao: "",
      categoria: v.categoria?.nome ?? null,
      obra: v.obra?.nome ?? null,
      forma: null,
      conta: null,
      lancadoConciliacao: false,
      vencimento: v.vencimento,
      pagoEm: null,
      valor: Number(v.valor_estimado ?? 0),
      aPagar: 0,
      situacao: "provisao",
      statusPagamento: null,
      parcela: null,
      repeticao: m ? m[1] : null,
      temAnexo: false,
      baixavel: false,
      criadoPor: v.created_by,
      provisao: { id: v.id, descricao: v.descricao, obra: v.obra?.nome ?? null, vencimento: v.vencimento, valor: v.valor_estimado === null ? null : Number(v.valor_estimado), serie: !!v.pagamento_origem_id || Boolean(m) },
      grupo: "provisao",
    });
  }
  linhas.sort((a, b) => (a.vencimento ?? "9999").localeCompare(b.vencimento ?? "9999") || (a.numero ?? 0) - (b.numero ?? 0));

  const soma = (g: LinhaConta["grupo"]) => linhas.filter((l) => l.grupo === g);
  const valorDe = (ls: LinhaConta[], campo: "valor" | "aPagar") => Math.round(ls.reduce((s, l) => s + l[campo], 0) * 100) / 100;
  const contas = linhas.filter((l) => l.tipo !== "provisao" && l.grupo !== "cancelado");
  const totais = {
    vencidos: { qtd: soma("vencidos").length, valor: valorDe(soma("vencidos"), "aPagar") },
    hoje: { qtd: soma("hoje").length, valor: valorDe(soma("hoje"), "aPagar") },
    avencer: { qtd: soma("avencer").length, valor: valorDe(soma("avencer"), "aPagar") },
    aprovacao: { qtd: soma("aprovacao").length, valor: valorDe(soma("aprovacao"), "aPagar") },
    pagos: { qtd: soma("pagos").length, valor: valorDe(soma("pagos"), "valor") },
    total: { qtd: contas.length, valor: valorDe(contas, "valor") },
  };

  const cartao = f.cartao ?? "";
  const filtradas =
    cartao === "vencidos" ? soma("vencidos")
    : cartao === "hoje" ? soma("hoje")
    : cartao === "avencer" ? soma("avencer")
    : cartao === "aprovacao" ? soma("aprovacao")
    : cartao === "pagos" ? soma("pagos")
    : cartao === "liberados" ? linhas.filter((l) => l.baixavel)
    : cartao === "abertos" ? linhas.filter((l) => !["pagos", "cancelado", "provisao"].includes(l.grupo))
    : linhas;
  return { linhas: filtradas, totais, periodo: { de, ate } };
}
