// Extrato do Relatórios: receitas (Contas a receber) e despesas (Contas a pagar) juntas, no período e nos filtros escolhidos,
// com os totais "em aberto" e "realizadas" de cada lado e o saldo do período.
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { STATUS_EM_ABERTO, STATUS_PAGAMENTO, type StatusPagamento } from "@/lib/rotulos";
import { hojeISO } from "@/lib/formato";
import type { FiltrosRelatorio } from "@/lib/consultas/relatorios";
import type { CorSituacao } from "@/lib/relatorio-tabela";

export type LinhaExtrato = {
  chave: string; // pag:<id> ou rec:<id>
  tipo: "receita" | "despesa";
  /** Data usada no período (conforme "Considerar a data de"). */
  data: string | null;
  vencimento: string;
  numero: number | null;
  descricao: string;
  parte: string; // fornecedor/favorecido ou cliente
  categoria: string | null;
  obra: string | null;
  obraId: string | null;
  categoriaId: string | null;
  situacao: string;
  cor: CorSituacao;
  /** Com sinal: receita positiva, despesa negativa. */
  valor: number;
  aberta: boolean;
  cancelada: boolean;
  pagamentoId: string | null;
};

export type TotaisExtrato = { receitasAbertas: number; receitasRealizadas: number; despesasAbertas: number; despesasRealizadas: number; saldo: number; qtd: number };

const LIMITE = 5000;
const UUID = /^[0-9a-f-]{36}$/i;
const um = <T,>(x: T | T[] | null): T | null => (Array.isArray(x) ? (x[0] ?? null) : x);
const arred = (n: number) => Math.round(n * 100) / 100;

export function corDoStatus(status: string, vencido: boolean): CorSituacao {
  if (status === "pago" || status === "recebido") return "verde";
  if (status === "cancelado") return "cinza";
  if (vencido || status === "rejeitado") return "vermelho";
  if (status === "aguardando_pagamento" || status === "aberto") return "azul";
  return "ambar";
}

/** Tipos de situação do filtro: "abertos", "realizados" (pagos/recebidos) ou um status de pagamento. */
export async function extratoRelatorio(f: FiltrosRelatorio): Promise<{ linhas: LinhaExtrato[]; totais: TotaisExtrato; truncado: boolean }> {
  const supabase = await createClient();
  const hoje = hojeISO();
  const busca = (f.busca ?? "").trim().replace(/[%,()*\\]/g, " ").slice(0, 80).trim();
  const queremDespesas = f.tipo !== "receitas";
  // Fornecedor só existe nas despesas; status específico de pagamento (aguardando, rejeitado...) também
  const statusSoDespesa = !!f.status && !["abertos", "realizados", "pago", "cancelado"].includes(f.status);
  const queremReceitas = f.tipo !== "despesas" && !f.fornecedor && !statusSoDespesa;
  const linhas: LinhaExtrato[] = [];
  let truncado = false;

  if (queremDespesas) {
    let q = supabase
      .from("pagamentos")
      .select("id, numero, favorecido, descricao, valor, valor_pago, vencimento, data_competencia, pago_em, status, created_at, categoria:categorias(id, nome), obra:obras(id, nome), fornecedor:fornecedores(id, nome)")
      .limit(LIMITE);
    if (f.base === "criacao") q = q.gte("created_at", `${f.de}T00:00:00-03:00`).lte("created_at", `${f.ate}T23:59:59.999-03:00`);
    else q = q.gte(f.base, f.de).lte(f.base, f.ate);
    if (f.obra && UUID.test(f.obra)) q = q.eq("obra_id", f.obra);
    if (f.fornecedor && UUID.test(f.fornecedor)) q = q.eq("fornecedor_id", f.fornecedor);
    if (f.categoria === "sem") q = q.is("categoria_id", null);
    else if (f.categoria && UUID.test(f.categoria)) q = q.eq("categoria_id", f.categoria);
    if (f.status === "abertos") q = q.in("status", STATUS_EM_ABERTO);
    else if (f.status === "realizados") q = q.eq("status", "pago");
    else if (f.status && f.status in STATUS_PAGAMENTO) q = q.eq("status", f.status as StatusPagamento);
    else if (!f.status) q = q.neq("status", "cancelado");
    if (busca) {
      const n = Number(busca.replace(/^n[ºo°]?\s*/i, ""));
      q = q.or(Number.isInteger(n) && n > 0 ? `numero.eq.${n},favorecido.ilike.%${busca}%,descricao.ilike.%${busca}%` : `favorecido.ilike.%${busca}%,descricao.ilike.%${busca}%`);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if ((data?.length ?? 0) >= LIMITE) truncado = true;
    for (const p of data ?? []) {
      const aberta = STATUS_EM_ABERTO.includes(p.status);
      const vencido = aberta && p.vencimento < hoje;
      const dataBase = f.base === "pago_em" ? p.pago_em : f.base === "criacao" ? p.created_at?.slice(0, 10) : f.base === "data_competencia" ? p.data_competencia : p.vencimento;
      linhas.push({
        chave: `pag:${p.id}`,
        tipo: "despesa",
        data: dataBase ?? null,
        vencimento: p.vencimento,
        numero: p.numero,
        descricao: p.descricao,
        parte: p.fornecedor?.nome ?? p.favorecido,
        categoria: p.categoria?.nome ?? null,
        obra: p.obra?.nome ?? null,
        obraId: p.obra?.id ?? null,
        categoriaId: p.categoria?.id ?? null,
        situacao: vencido ? "Vencido" : STATUS_PAGAMENTO[p.status].rotulo,
        cor: corDoStatus(p.status, vencido),
        valor: -Number(p.status === "pago" ? (p.valor_pago ?? p.valor) : p.valor),
        aberta,
        cancelada: p.status === "cancelado",
        pagamentoId: p.id,
      });
    }
  }

  if (queremReceitas) {
    let q = supabase
      .from("recebimentos")
      .select("id, numero, cliente, descricao, valor, valor_recebido, vencimento, data_competencia, recebido_em, status, created_at, categoria:categorias(id, nome), obra:obras(id, nome)")
      .limit(LIMITE);
    const colunaData = f.base === "pago_em" ? "recebido_em" : f.base === "data_competencia" ? "data_competencia" : f.base === "criacao" ? "created_at" : "vencimento";
    if (f.base === "criacao") q = q.gte("created_at", `${f.de}T00:00:00-03:00`).lte("created_at", `${f.ate}T23:59:59.999-03:00`);
    else q = q.gte(colunaData, f.de).lte(colunaData, f.ate);
    if (f.obra && UUID.test(f.obra)) q = q.eq("obra_id", f.obra);
    if (f.categoria === "sem") q = q.is("categoria_id", null);
    else if (f.categoria && UUID.test(f.categoria)) q = q.eq("categoria_id", f.categoria);
    if (f.status === "abertos") q = q.eq("status", "aberto");
    else if (f.status === "realizados" || f.status === "pago") q = q.eq("status", "recebido");
    else if (f.status === "cancelado") q = q.eq("status", "cancelado");
    else q = q.neq("status", "cancelado");
    if (busca) {
      const n = Number(busca.replace(/^n[ºo°]?\s*/i, ""));
      q = q.or(Number.isInteger(n) && n > 0 ? `numero.eq.${n},cliente.ilike.%${busca}%,descricao.ilike.%${busca}%` : `cliente.ilike.%${busca}%,descricao.ilike.%${busca}%`);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    if ((data?.length ?? 0) >= LIMITE) truncado = true;
    for (const r of data ?? []) {
      const aberta = r.status === "aberto";
      const vencida = aberta && r.vencimento < hoje;
      const dataBase = f.base === "pago_em" ? r.recebido_em : f.base === "criacao" ? r.created_at?.slice(0, 10) : f.base === "data_competencia" ? r.data_competencia : r.vencimento;
      const cat = um(r.categoria);
      const obra = um(r.obra);
      linhas.push({
        chave: `rec:${r.id}`,
        tipo: "receita",
        data: dataBase ?? null,
        vencimento: r.vencimento,
        numero: r.numero,
        descricao: r.descricao,
        parte: r.cliente,
        categoria: cat?.nome ?? null,
        obra: obra?.nome ?? null,
        obraId: obra?.id ?? null,
        categoriaId: cat?.id ?? null,
        situacao: r.status === "recebido" ? "Recebido" : r.status === "cancelado" ? "Cancelado" : vencida ? "Vencido" : r.vencimento === hoje ? "Vence hoje" : "A receber",
        cor: r.status === "cancelado" ? "cinza" : r.status === "recebido" ? "verde" : vencida ? "vermelho" : r.vencimento === hoje ? "ambar" : "azul",
        valor: Number(r.status === "recebido" ? (r.valor_recebido ?? r.valor) : r.valor),
        aberta,
        cancelada: r.status === "cancelado",
        pagamentoId: null,
      });
    }
  }

  linhas.sort((a, b) => (a.data ?? "9999").localeCompare(b.data ?? "9999") || a.tipo.localeCompare(b.tipo) || (a.numero ?? 0) - (b.numero ?? 0));

  const vivas = linhas.filter((l) => !l.cancelada);
  const soma = (xs: LinhaExtrato[]) => arred(xs.reduce((s, l) => s + l.valor, 0));
  const receitasAbertas = soma(vivas.filter((l) => l.tipo === "receita" && l.aberta));
  const receitasRealizadas = soma(vivas.filter((l) => l.tipo === "receita" && !l.aberta));
  const despesasAbertas = Math.abs(soma(vivas.filter((l) => l.tipo === "despesa" && l.aberta)));
  const despesasRealizadas = Math.abs(soma(vivas.filter((l) => l.tipo === "despesa" && !l.aberta)));
  return {
    linhas,
    totais: { receitasAbertas, receitasRealizadas, despesasAbertas, despesasRealizadas, saldo: arred(receitasAbertas + receitasRealizadas - despesasAbertas - despesasRealizadas), qtd: vivas.length },
    truncado,
  };
}
