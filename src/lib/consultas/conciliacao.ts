// Conciliação bancária: contas, linhas do extrato, contas a pagar candidatas e a sugestão automática.
import "server-only";
import { createClient } from "@/lib/supabase/server";

import type { Candidato, Historico, HistoricoReceita, LinhaExtrato, ReceitaAberta, SaidaEstornavel, TransferenciaAberta } from "@/lib/conciliacao-sugestao";
export { CLASSIFICACOES, classificacaoProvavel, pareceEstorno, saidasParaEstorno, sugerir, sugerirEstornos, sugerirLancamento, sugerirReceitas, sugerirRecebimento, sugerirTransferencias, tolerancia } from "@/lib/conciliacao-sugestao";
export type { Candidato, Classificacao, Historico, HistoricoReceita, LinhaExtrato, ReceitaAberta, SaidaEstornavel, Sugestao, SugestaoLancamento, SugestaoRecebimento, TransferenciaAberta } from "@/lib/conciliacao-sugestao";

export async function contasBancarias() {
  const supabase = await createClient();
  const [{ data: contas }, { data: saldos }, { data: aplic }, { data: pend }] = await Promise.all([
    supabase.from("contas_bancarias").select("id, nome, banco, agencia, conta, tipo").eq("ativa", true).neq("tipo", "manual").order("nome"), // "Baixa manual" não tem extrato
    supabase.rpc("saldos_contas_bancarias"), // saldo: só Financeiro/master
    supabase.rpc("aplicado_nas_contas"), // aplicado no Rende Fácil (aplicações − resgates conciliados)
    supabase.from("extrato_linhas").select("conta_id, valor").eq("situacao", "pendente").limit(50000),
  ]);
  const saldo = new Map((saldos ?? []).map((x) => [x.id, x]));
  const aplicado = new Map((aplic ?? []).map((x) => [x.conta_id, Number(x.aplicado)]));
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
      aplicado: aplicado.get(c.id) ?? 0,
      valorPendente: Math.round((soma.get(c.id) ?? 0) * 100) / 100,
    };
  });
}

export type FiltroLinhas = { mes: string; busca: string; tipo: "" | "entradas" | "saidas"; ordem: "antigas" | "recentes" | "maior" };

/** Linhas da conta na situação, com mês (AAAA-MM ou "todos"), pesquisa (descrição ou valor), tipo e ordem. */
export async function linhasDaConta(contaId: string, situacao: LinhaExtrato["situacao"], f: FiltroLinhas = { mes: "todos", busca: "", tipo: "", ordem: "antigas" }) {
  const supabase = await createClient();
  let q = supabase.from("extrato_linhas").select("id, data, valor, descricao, tipo, situacao, classificacao, observacao, encargos, transferencia_id, estorno_linha, recebimento_id").eq("conta_id", contaId).eq("situacao", situacao);
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
  // Impostos da medição ficam fora: o retido é baixado com a receita e o devido já nasce pago (baixa manual)
  let qPago = supabase.from("pagamentos").select(SEL).eq("status", "pago").is("imposto_medicao", null);
  if (de && ate) qPago = qPago.gte("pago_em", de).lte("pago_em", ate);
  const [{ data: abertos }, { data: pagos }, { data: ligados }] = await Promise.all([
    supabase.from("pagamentos").select(SEL).eq("status", "aguardando_pagamento").is("imposto_medicao", null).limit(2000),
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
  type Item = { pagamentoId: string; numero: number; favorecido: string; parcela: number | null; valor: number; baixou: boolean; lancado: boolean };
  if (!linhaIds.length) return new Map<string, Item[]>();
  const supabase = await createClient();
  const { data } = await supabase
    .from("conciliacao_itens")
    .select("linha_id, pagamento_id, valor, baixou, pagamento:pagamentos(numero, favorecido, lancado_conciliacao), parcela:pagamento_parcelas(numero)")
    .in("linha_id", linhaIds);
  const m = new Map<string, Item[]>();
  for (const i of data ?? []) {
    const p = (Array.isArray(i.pagamento) ? i.pagamento[0] : i.pagamento) as { numero: number; favorecido: string; lancado_conciliacao: boolean } | null;
    const pc = (Array.isArray(i.parcela) ? i.parcela[0] : i.parcela) as { numero: number } | null;
    const arr = m.get(i.linha_id) ?? [];
    arr.push({ pagamentoId: i.pagamento_id, numero: Number(p?.numero), favorecido: p?.favorecido ?? "", parcela: pc?.numero ?? null, valor: Number(i.valor), baixou: i.baixou, lancado: Boolean(p?.lancado_conciliacao) });
    m.set(i.linha_id, arr);
  }
  return m;
}

/** Lançamentos já feitos (com a descrição do banco quando foram conciliados) para sugerir o "Novo lançamento". */
export async function historicoLancamentos(): Promise<Historico[]> {
  const supabase = await createClient();
  const [{ data: pags }, { data: conc }] = await Promise.all([
    supabase
      .from("pagamentos")
      .select("id, favorecido, fornecedor_id, categoria_id, obra_id, created_at, fornecedor:fornecedores(nome, cpf_cnpj)")
      .neq("status", "cancelado")
      .order("created_at", { ascending: false })
      .limit(3000),
    supabase.from("conciliacao_itens").select("pagamento_id, created_at, linha:extrato_linhas(descricao)").order("created_at", { ascending: false }).limit(3000),
  ]);
  const memo = new Map<string, { descricao: string; data: string }>();
  for (const c of conc ?? []) {
    const l = (Array.isArray(c.linha) ? c.linha[0] : c.linha) as { descricao: string } | null;
    if (l && !memo.has(c.pagamento_id)) memo.set(c.pagamento_id, { descricao: l.descricao, data: c.created_at });
  }
  return (pags ?? []).map((p) => {
    const f = (Array.isArray(p.fornecedor) ? p.fornecedor[0] : p.fornecedor) as { nome: string; cpf_cnpj: string | null } | null;
    const m = memo.get(p.id);
    return {
      memo: m?.descricao ?? null,
      favorecido: p.favorecido,
      fornecedorId: p.fornecedor_id,
      fornecedor: f?.nome ?? null,
      documento: f?.cpf_cnpj ? f.cpf_cnpj.replace(/\D/g, "") : null,
      categoriaId: p.categoria_id,
      obraId: p.obra_id,
      data: m?.data ?? p.created_at,
    };
  });
}

/** Transferências que ainda esperam a movimentação desta conta (entrada no destino ou saída na origem). */
export async function transferenciasAbertas(contaId: string): Promise<TransferenciaAberta[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("transferencias")
    .select("id, conta_origem, conta_destino, valor, data, descricao, linha_origem, linha_destino, origem:contas_bancarias!transferencias_conta_origem_fkey(nome), destino:contas_bancarias!transferencias_conta_destino_fkey(nome)")
    .or(`and(conta_destino.eq.${contaId},linha_destino.is.null),and(conta_origem.eq.${contaId},linha_origem.is.null)`)
    .limit(500);
  return (data ?? []).map((t) => {
    const o = (Array.isArray(t.origem) ? t.origem[0] : t.origem) as { nome: string } | null;
    const d = (Array.isArray(t.destino) ? t.destino[0] : t.destino) as { nome: string } | null;
    return { id: t.id, contaOrigem: t.conta_origem, contaDestino: t.conta_destino, outraConta: (t.conta_destino === contaId ? o?.nome : d?.nome) ?? "", valor: Number(t.valor), data: t.data, descricao: t.descricao };
  });
}

/** Transferências ligadas às linhas conciliadas (para a aba Movimentações). */
export async function transferenciasDasLinhas(ids: string[], contaId: string) {
  if (!ids.length) return new Map<string, { sentido: "para" | "de"; conta: string; outroLadoConciliado: boolean; investimento: boolean }>();
  const supabase = await createClient();
  const { data } = await supabase
    .from("transferencias")
    .select("id, conta_origem, conta_destino, linha_origem, linha_destino, origem:contas_bancarias!transferencias_conta_origem_fkey(nome, tipo), destino:contas_bancarias!transferencias_conta_destino_fkey(nome, tipo)")
    .in("id", ids);
  const m = new Map<string, { sentido: "para" | "de"; conta: string; outroLadoConciliado: boolean; investimento: boolean }>();
  for (const t of data ?? []) {
    const o = (Array.isArray(t.origem) ? t.origem[0] : t.origem) as { nome: string; tipo: string } | null;
    const d = (Array.isArray(t.destino) ? t.destino[0] : t.destino) as { nome: string; tipo: string } | null;
    const souOrigem = t.conta_origem === contaId;
    const outra = souOrigem ? d : o;
    m.set(t.id, { sentido: souOrigem ? "para" : "de", conta: outra?.nome ?? "", outroLadoConciliado: Boolean(souOrigem ? t.linha_destino : t.linha_origem), investimento: outra?.tipo === "investimento" });
  }
  return m;
}

/** Saídas da conta que um estorno pode devolver: pendentes ou conciliadas com contas a pagar, até 30 dias antes do período. */
export async function saidasEstornaveis(contaId: string, periodo: { de: string; ate: string } | null): Promise<SaidaEstornavel[]> {
  if (!periodo) return [];
  const supabase = await createClient();
  const de = new Date(new Date(periodo.de + "T12:00:00Z").getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from("extrato_linhas")
    .select("id, data, valor, descricao, situacao, itens:conciliacao_itens(pagamento:pagamentos(numero, favorecido))")
    .eq("conta_id", contaId)
    .lt("valor", 0)
    .in("situacao", ["pendente", "conciliada"])
    .is("estorno_linha", null)
    .is("transferencia_id", null)
    .gte("data", de)
    .lte("data", periodo.ate)
    .limit(2000);
  return (data ?? []).map((l) => {
    const pags = ((l.itens ?? []) as { pagamento: { numero: number; favorecido: string } | { numero: number; favorecido: string }[] | null }[])
      .map((i) => (Array.isArray(i.pagamento) ? i.pagamento[0] : i.pagamento))
      .filter(Boolean) as { numero: number; favorecido: string }[];
    return {
      id: l.id,
      data: l.data,
      valor: Number(l.valor),
      descricao: l.descricao,
      situacao: l.situacao as "pendente" | "conciliada",
      conciliadaCom: pags.length ? pags.map((p) => `nº ${p.numero} · ${p.favorecido}`).join(", ") : null,
    };
  });
}

/** A outra linha de cada par de estorno (para a aba Movimentações). */
export async function paresDeEstorno(ids: string[]) {
  const m = new Map<string, { data: string; descricao: string; valor: number }>();
  if (!ids.length) return m;
  const supabase = await createClient();
  const { data } = await supabase.from("extrato_linhas").select("id, data, descricao, valor").in("id", ids);
  for (const l of data ?? []) m.set(l.id, { data: l.data, descricao: l.descricao, valor: Number(l.valor) });
  return m;
}

/** Transferências de uma conta de investimento (não tem extrato: o saldo sai daqui). */
export async function movimentosInvestimento(contaId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("transferencias")
    .select("id, conta_origem, conta_destino, valor, data, descricao, origem:contas_bancarias!transferencias_conta_origem_fkey(nome), destino:contas_bancarias!transferencias_conta_destino_fkey(nome)")
    .or(`conta_origem.eq.${contaId},conta_destino.eq.${contaId}`)
    .order("data", { ascending: false })
    .limit(500);
  return (data ?? []).map((t) => {
    const o = (Array.isArray(t.origem) ? t.origem[0] : t.origem) as { nome: string } | null;
    const d = (Array.isArray(t.destino) ? t.destino[0] : t.destino) as { nome: string } | null;
    const aplicacao = t.conta_destino === contaId;
    return { id: t.id, data: t.data, descricao: t.descricao, aplicacao, outraConta: (aplicacao ? o?.nome : d?.nome) ?? "", valor: aplicacao ? Number(t.valor) : -Number(t.valor) };
  });
}

/** Recebimentos já lançados (com a descrição do banco) para sugerir o "Novo lançamento" de receita. */
export async function historicoRecebimentos(): Promise<HistoricoReceita[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("recebimentos")
    .select("cliente, categoria_id, obra_id, created_at, linha:extrato_linhas(descricao)")
    .neq("status", "cancelado")
    .order("created_at", { ascending: false })
    .limit(3000);
  return (data ?? []).map((r) => {
    const l = (Array.isArray(r.linha) ? r.linha[0] : r.linha) as { descricao: string } | null;
    return { memo: l?.descricao ?? null, cliente: r.cliente, categoriaId: r.categoria_id, obraId: r.obra_id, data: r.created_at };
  });
}

/** Recebimentos ligados às linhas conciliadas (aba Movimentações). */
export async function recebimentosDasLinhas(ids: string[]) {
  const m = new Map<string, { id: string; numero: number; cliente: string; lancado: boolean }>();
  if (!ids.length) return m;
  const supabase = await createClient();
  const { data } = await supabase.from("recebimentos").select("id, numero, cliente, lancado_conciliacao").in("id", ids);
  for (const r of data ?? []) m.set(r.id, { id: r.id, numero: Number(r.numero), cliente: r.cliente, lancado: r.lancado_conciliacao });
  return m;
}

/** Receitas em aberto (com o imposto retido da medição, se houver) para conciliar entradas do extrato. */
export async function receitasAbertas(): Promise<ReceitaAberta[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("recebimentos")
    .select("id, numero, cliente, descricao, valor, vencimento, obra:obras(nome), impostos:pagamentos!pagamentos_recebimento_id_fkey(valor, status, imposto_medicao)")
    .eq("status", "aberto")
    .limit(1000);
  return (data ?? []).map((r) => {
    const imp = (r.impostos ?? []) as { valor: number; status: string; imposto_medicao: string | null }[];
    const obra = (Array.isArray(r.obra) ? r.obra[0] : r.obra) as { nome: string } | null;
    return {
      id: r.id,
      numero: Number(r.numero),
      cliente: r.cliente,
      descricao: r.descricao,
      obra: obra?.nome ?? "",
      valor: Number(r.valor),
      retido: Math.round(imp.filter((i) => i.imposto_medicao === "retido" && i.status === "aguardando_pagamento").reduce((t, i) => t + Number(i.valor), 0) * 100) / 100,
      vencimento: r.vencimento,
    };
  });
}
