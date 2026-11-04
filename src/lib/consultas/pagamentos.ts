import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { StatusPagamento } from "@/lib/rotulos";

export const SELECAO_LISTA =
  "id, numero, favorecido, descricao, valor, vencimento, status, fluxo, versao, forma_pagamento, numero_documento, pago_em, valor_pago, created_at, obra:obras(id, nome, cidade, uf), fornecedor:fornecedores(id, nome)";

export type FiltrosPagamento = {
  busca?: string;
  obra?: string;
  fornecedor?: string;
  status?: string;
  de?: string;
  ate?: string;
};

export const POR_PAGINA = 50;

function dataValida(s?: string) {
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}
function uuidValido(s?: string) {
  return s && /^[0-9a-f-]{36}$/i.test(s) ? s : undefined;
}

export async function listarPagamentos(f: FiltrosPagamento, pagina = 1, limite: number | null = POR_PAGINA) {
  const supabase = await createClient();
  let q = supabase.from("pagamentos").select(SELECAO_LISTA, { count: "exact" });

  const obra = uuidValido(f.obra);
  if (obra) q = q.eq("obra_id", obra);
  const forn = uuidValido(f.fornecedor);
  if (forn) q = q.eq("fornecedor_id", forn);

  if (f.status === "abertos") q = q.in("status", ["aguardando_engenheiro", "aguardando_administrador", "aguardando_pagamento"]);
  else if (f.status === "em_aprovacao") q = q.in("status", ["aguardando_engenheiro", "aguardando_administrador"]);
  else if (f.status) q = q.eq("status", f.status as StatusPagamento);

  const de = dataValida(f.de);
  if (de) q = q.gte("vencimento", de);
  const ate = dataValida(f.ate);
  if (ate) q = q.lte("vencimento", ate);

  const busca = f.busca?.trim().replace(/[%,()*\\]/g, " ").trim();
  if (busca) {
    const num = /^\d+$/.test(busca) ? `,numero.eq.${busca}` : "";
    q = q.or(`favorecido.ilike.%${busca}%,descricao.ilike.%${busca}%,numero_documento.ilike.%${busca}%${num}`);
  }

  q = q.order("vencimento", { ascending: true }).order("numero", { ascending: true });
  if (limite) {
    const ini = (pagina - 1) * limite;
    q = q.range(ini, ini + limite - 1);
  }
  const { data, count, error } = await q;
  if (error) throw new Error(error.message);
  return { itens: data ?? [], total: count ?? 0 };
}

export type PagamentoLista = Awaited<ReturnType<typeof listarPagamentos>>["itens"][number];

/** Pagamentos em aberto (não pagos/cancelados/rejeitados) — base do painel e da agenda. */
export async function pagamentosEmAberto(de?: string, ate?: string) {
  const supabase = await createClient();
  let q = supabase
    .from("pagamentos")
    .select(SELECAO_LISTA)
    .in("status", ["aguardando_engenheiro", "aguardando_administrador", "aguardando_pagamento"])
    .order("vencimento")
    .order("numero");
  if (de) q = q.gte("vencimento", de);
  if (ate) q = q.lte("vencimento", ate);
  const { data, error } = await q.limit(5000);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export function somar(itens: { valor: number | string }[]) {
  return itens.reduce((s, i) => s + Number(i.valor), 0);
}
