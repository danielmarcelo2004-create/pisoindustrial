import "server-only";
import { createClient } from "@/lib/supabase/server";
import { STATUS_EM_ABERTO, STATUS_PAGAMENTO, type StatusPagamento } from "@/lib/rotulos";
import { hojeISO } from "@/lib/formato";

export type FiltrosRelatorio = {
  base: "vencimento" | "pago_em" | "criacao";
  de: string;
  ate: string;
  obra?: string;
  fornecedor?: string;
  status?: string;
};

const dataOk = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export function lerFiltros(get: (k: string) => string | null): FiltrosRelatorio {
  const hoje = hojeISO();
  const base = get("base");
  return {
    base: base === "pago_em" || base === "criacao" ? base : "vencimento",
    de: dataOk(get("de")) ?? hoje.slice(0, 8) + "01",
    ate: dataOk(get("ate")) ?? hoje,
    obra: get("obra") ?? "",
    fornecedor: get("fornecedor") ?? "",
    status: get("status") ?? "",
  };
}

export async function dadosRelatorio(f: FiltrosRelatorio) {
  const supabase = await createClient();
  let q = supabase
    .from("pagamentos")
    .select(
      "id, numero, favorecido, descricao, valor, valor_pago, vencimento, pago_em, status, forma_pagamento, numero_documento, created_at, obra:obras(id, nome, cidade, uf), fornecedor:fornecedores(id, nome, cpf_cnpj), documentos(id, tipo, ativo)",
    )
    .limit(20000);
  if (f.base === "criacao") {
    q = q.gte("created_at", `${f.de}T00:00:00-03:00`).lte("created_at", `${f.ate}T23:59:59.999-03:00`);
  } else {
    q = q.gte(f.base, f.de).lte(f.base, f.ate);
  }
  if (f.obra && /^[0-9a-f-]{36}$/i.test(f.obra)) q = q.eq("obra_id", f.obra);
  if (f.fornecedor && /^[0-9a-f-]{36}$/i.test(f.fornecedor)) q = q.eq("fornecedor_id", f.fornecedor);
  if (f.status === "abertos") q = q.in("status", STATUS_EM_ABERTO);
  else if (f.status && f.status in STATUS_PAGAMENTO) q = q.eq("status", f.status as StatusPagamento);
  q = q.order(f.base === "criacao" ? "created_at" : f.base, { ascending: true }).order("numero");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const hoje = hojeISO();

  const itens = (data ?? []).map((p) => ({
    ...p,
    valor: Number(p.valor),
    valor_pago: p.valor_pago === null ? null : Number(p.valor_pago),
    vencido: STATUS_EM_ABERTO.includes(p.status) && p.vencimento < hoje,
    comprovante: p.documentos.find((d) => d.tipo === "comprovante" && d.ativo)?.id ?? null,
  }));

  const agrupar = (chave: (i: (typeof itens)[number]) => string, rotulo: (i: (typeof itens)[number]) => string) => {
    const m = new Map<string, { rotulo: string; qtd: number; total: number; pago: number; aberto: number; vencido: number }>();
    for (const i of itens) {
      const k = chave(i);
      const r = m.get(k) ?? { rotulo: rotulo(i), qtd: 0, total: 0, pago: 0, aberto: 0, vencido: 0 };
      r.qtd += 1;
      if (i.status !== "cancelado") r.total += i.valor;
      if (i.status === "pago") r.pago += i.valor_pago ?? i.valor;
      if (STATUS_EM_ABERTO.includes(i.status)) r.aberto += i.valor;
      if (i.vencido) r.vencido += i.valor;
      m.set(k, r);
    }
    return [...m.entries()].map(([k, v]) => ({ chave: k, ...v }));
  };

  const dataBase = (i: (typeof itens)[number]) =>
    (f.base === "pago_em" ? i.pago_em : f.base === "criacao" ? i.created_at : i.vencimento)?.slice(0, 7) ?? "";

  return {
    itens,
    porObra: agrupar((i) => i.obra?.id ?? "", (i) => i.obra?.nome ?? "—").sort((a, b) => b.total - a.total),
    porFornecedor: agrupar((i) => i.fornecedor?.id ?? `fav:${i.favorecido}`, (i) => i.fornecedor?.nome ?? i.favorecido).sort((a, b) => b.total - a.total),
    porMes: agrupar(dataBase, dataBase).sort((a, b) => a.chave.localeCompare(b.chave)),
    porStatus: agrupar((i) => i.status, (i) => STATUS_PAGAMENTO[i.status].rotulo),
    totais: {
      qtd: itens.length,
      total: itens.filter((i) => i.status !== "cancelado").reduce((s, i) => s + i.valor, 0),
      pago: itens.filter((i) => i.status === "pago").reduce((s, i) => s + (i.valor_pago ?? i.valor), 0),
      aberto: itens.filter((i) => STATUS_EM_ABERTO.includes(i.status)).reduce((s, i) => s + i.valor, 0),
      vencido: itens.filter((i) => i.vencido).reduce((s, i) => s + i.valor, 0),
    },
  };
}
