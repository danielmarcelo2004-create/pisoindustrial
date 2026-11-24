"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { lerValor } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Soma meses a uma data AAAA-MM-DD, mantendo o dia (ou o último dia do mês, quando não existe). */
function somarMeses(iso: string, meses: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(y, m - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const dia = Math.min(d, ultimoDia);
  return new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth(), dia)).toISOString().slice(0, 10);
}

export async function criarProvisao(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  const obra = t(fd, "obra_id");
  const descricao = t(fd, "descricao");
  const venc = t(fd, "vencimento");
  const valorTxt = t(fd, "valor_estimado");
  const mesesTxt = t(fd, "meses") || "1";
  if (!UUID.test(obra)) return { erro: "Selecione o centro de custo." };
  if (!descricao) return { erro: "Informe a descrição (ex.: Conta de luz da casa alugada)." };
  if (venc && !/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Vencimento inválido." };
  const meses = Number(mesesTxt);
  if (!Number.isInteger(meses) || meses < 1 || meses > 60) return { erro: "Informe de 1 a 60 meses." };
  if (meses > 1 && !venc) return { erro: "Para várias parcelas, informe o primeiro vencimento." };
  const valor = valorTxt ? lerValor(valorTxt) : null;
  if (valorTxt && valor === null) return { erro: "Valor estimado inválido." };

  // Uma linha por parcela: vencimento mensal a partir do primeiro, com a mesma descrição numerada.
  const linhas = Array.from({ length: meses }, (_, i) => {
    const vencParcela = venc ? somarMeses(venc, i) : null;
    return {
      obra_id: obra,
      descricao: meses > 1 ? `${descricao} (${i + 1}/${meses})` : descricao,
      mes_referencia: vencParcela ? vencParcela.slice(0, 7) : null,
      vencimento: vencParcela,
      valor_estimado: valor,
      observacoes: t(fd, "observacoes") || null,
    };
  });

  const supabase = await createClient();
  const { error } = await supabase.from("provisoes").insert(linhas);
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/provisoes");
  revalidatePath("/");
  return {
    ok: meses > 1
      ? `${meses} provisões criadas, uma por mês a partir de ${venc.split("-").reverse().join("/")}. Elas aparecem na agenda, mas não entram nos totais a pagar.`
      : "Provisão registrada. Ela aparece na agenda, mas não entra nos totais a pagar.",
  };
}

export async function alterarProvisao(id: string, status: "convertida" | "cancelada", _: Estado): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  if (!UUID.test(id)) return { erro: "Provisão não encontrada." };
  const supabase = await createClient();
  // Suprimentos só altera as provisões que criou (regra do banco); nenhuma linha alterada = sem permissão
  const { data, error } = await supabase.from("provisoes").update({ status }).eq("id", id).select("id");
  if (error) return { erro: mensagemErro(error) };
  if (!data?.length) return { erro: "Você só pode alterar as provisões que cadastrou." };
  revalidatePath("/provisoes");
  revalidatePath("/");
  // A linha sai da situação "provisionada": volta à lista com a confirmação visível.
  // Se era a última parcela de uma série, a página pergunta se deseja adicionar mais.
  const { data: pv } = await supabase.from("provisoes").select("descricao").eq("id", id).single();
  const m = pv?.descricao.match(/ \((\d+)\/(\d+)\)$/);
  if (status === "convertida" && m && m[1] === m[2]) redirect(`/provisoes?aviso=ultima&prov=${id}`);
  redirect(`/provisoes?aviso=${status}`);
}

/** Cancela esta provisão e as próximas da mesma série (repetição de um pagamento ou provisão de vários meses). */
export async function cancelarProximasProvisoes(id: string, _: Estado): Promise<Estado> {
  const u = await exigirPerfil("financeiro", "suprimentos");
  if (!UUID.test(id)) return { erro: "Provisão não encontrada." };
  const supabase = await createClient();
  const { data: p } = await supabase
    .from("provisoes")
    .select("id, obra_id, descricao, vencimento, status, created_by, pagamento_origem_id")
    .eq("id", id)
    .maybeSingle();
  if (!p || p.status !== "provisionada") return { erro: "Provisão não encontrada ou já encerrada." };
  if (u.perfil === "suprimentos" && p.created_by !== u.id && !p.pagamento_origem_id) return { erro: "Você só pode alterar as provisões que cadastrou." };

  let qtd = 0;
  if (p.pagamento_origem_id) {
    // Repetição de pagamento: a partir do vencimento desta (inclusive)
    const { data, error } = await supabase.rpc("cancelar_serie", {
      p_pagamento_id: p.pagamento_origem_id,
      p_a_partir: (p.vencimento ?? "1900-01-01") as string,
    });
    if (error) return { erro: mensagemErro(error) };
    qtd = data ?? 0;
  } else {
    // Provisão de vários meses: mesma descrição-base "(k/N)", mesmo centro de custo e quem cadastrou
    const m = p.descricao.match(/^(.*) \((\d+)\/(\d+)\)$/);
    if (!m) return alterarProvisao(id, "cancelada", _);
    const [, base, , total] = m;
    const { data: irmas } = await supabase
      .from("provisoes")
      .select("id, descricao, vencimento")
      .eq("obra_id", p.obra_id)
      .eq("created_by", p.created_by)
      .eq("status", "provisionada")
      .like("descricao", `${base.replace(/[%_\\]/g, (c) => "\\" + c)} (%/${total})`);
    const ids = (irmas ?? [])
      .filter((x) => x.descricao.match(/ \((\d+)\/\d+\)$/) && (!p.vencimento || !x.vencimento || x.vencimento >= p.vencimento))
      .map((x) => x.id);
    if (!ids.includes(p.id)) ids.push(p.id);
    const { data, error } = await supabase.from("provisoes").update({ status: "cancelada" }).in("id", ids).select("id");
    if (error) return { erro: mensagemErro(error) };
    if (!data?.length) return { erro: "Você só pode alterar as provisões que cadastrou." };
    qtd = data.length;
  }
  revalidatePath("/provisoes");
  revalidatePath("/");
  revalidatePath("/");
  redirect(`/provisoes?aviso=serie&qtd=${qtd}`);
}

/** Última parcela da série: adiciona mais parcelas (mesmo intervalo, valor e categoria) e renumera a série. */
export async function adicionarParcelasProvisao(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  if (!UUID.test(id)) return { erro: "Provisão não encontrada." };
  const qtd = Number(t(fd, "quantidade"));
  if (!Number.isInteger(qtd) || qtd < 1 || qtd > 60) return { erro: "Informe de 1 a 60 parcelas." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("estender_serie_provisao", { p_provisao_id: id, p_quantidade: qtd });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/provisoes");
  revalidatePath("/");
  revalidatePath("/");
  redirect(`/provisoes?aviso=estendida&qtd=${qtd}`);
}

/** Janela "Lançar despesa" (Contas a pagar e Agenda): marca como lançada ou cancela sem sair da tela. */
export async function marcarProvisao(id: string, status: "convertida" | "cancelada"): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  if (!UUID.test(id) || !["convertida", "cancelada"].includes(status)) return { erro: "Provisão não encontrada." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("provisoes").update({ status }).eq("id", id).eq("status", "provisionada").select("id");
  if (error) return { erro: mensagemErro(error) };
  if (!data?.length) return { erro: "Você só pode alterar as provisões que cadastrou (ou ela já foi lançada/cancelada)." };
  revalidatePath("/", "layout");
  return { ok: status === "convertida" ? "Provisão marcada como lançada." : "Provisão cancelada." };
}
