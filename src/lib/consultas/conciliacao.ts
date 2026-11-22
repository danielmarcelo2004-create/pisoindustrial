// Conciliação bancária: contas, linhas do extrato, contas a pagar candidatas e a sugestão automática.
import "server-only";
import { createClient } from "@/lib/supabase/server";

import type { Candidato, LinhaExtrato } from "@/lib/conciliacao-sugestao";
export { CLASSIFICACOES, classificacaoProvavel, sugerir, tolerancia } from "@/lib/conciliacao-sugestao";
export type { Candidato, Classificacao, LinhaExtrato, Sugestao } from "@/lib/conciliacao-sugestao";

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
