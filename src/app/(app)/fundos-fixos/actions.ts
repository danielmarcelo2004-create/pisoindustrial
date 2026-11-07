"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { hojeISO, lerValor } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function revalidar(id?: string) {
  revalidatePath("/fundos-fixos");
  if (id) revalidatePath(`/fundos-fixos/${id}`);
}

export async function criarFundo(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  const obra = t(fd, "obra_id");
  const pessoa = t(fd, "pessoa_id");
  const valor = lerValor(t(fd, "valor"));
  if (!UUID.test(obra)) return { erro: "Selecione o centro de custo." };
  if (!UUID.test(pessoa)) return { erro: "Selecione o engenheiro ou Suprimentos responsável pelo fundo." };
  if (valor === null || valor <= 0) return { erro: "Informe o valor do fundo." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("criar_fundo_fixo", { p_obra_id: obra, p_pessoa_id: pessoa, p_valor: valor });
  if (error) return { erro: mensagemErro(error) };
  revalidar();
  return { ok: "Fundo fixo criado. A pessoa já pode lançar gastos nele." };
}

export async function lancarGasto(fundoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("engenheiro", "suprimentos", "administrador", "administrador_master", "financeiro");
  if (!UUID.test(fundoId)) return { erro: "Fundo não encontrado." };
  const valor = lerValor(t(fd, "valor"));
  const data = t(fd, "data_gasto");
  const descricao = t(fd, "descricao");
  if (!descricao) return { erro: "Informe a descrição do gasto." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return { erro: "Informe a data do gasto." };
  if (valor === null || valor <= 0) return { erro: "Informe o valor do gasto." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("lancar_gasto_fundo", { p_fundo_id: fundoId, p_descricao: descricao, p_data: data, p_valor: valor });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  return { ok: "Gasto lançado. Anexe o comprovante e assine-o no próprio gasto." };
}

export async function decidirGasto(fundoId: string, gastoId: string, aprovar: boolean, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("administrador", "administrador_master");
  if (!UUID.test(gastoId)) return { erro: "Gasto não encontrado." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("decidir_gasto_fundo", {
    p_gasto_id: gastoId,
    p_aprovar: aprovar,
    p_motivo: aprovar ? undefined : t(fd, "motivo") || undefined,
  });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  // Após decidir, volta à lista: o formulário do gasto some e a confirmação aparece lá.
  redirect(`/fundos-fixos?decidido=${aprovar ? "aprovado" : "recusado"}`);
}

export async function fecharFundo(fundoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(fundoId)) return { erro: "Fundo não encontrado." };
  const venc = t(fd, "vencimento");
  if (venc && !/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Vencimento inválido." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fechar_fundo_fixo", { p_fundo_id: fundoId, p_vencimento: venc || hojeISO() });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  revalidatePath("/pagamentos");
  revalidatePath("/agenda");
  redirect(`/fundos-fixos?fechado=${data ? "pagamento" : "saldo"}`);
}
