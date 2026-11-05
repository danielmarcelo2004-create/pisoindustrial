"use server";

import { revalidatePath } from "next/cache";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { lerValor } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function criarProvisao(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  const obra = t(fd, "obra_id");
  const descricao = t(fd, "descricao");
  const mes = t(fd, "mes_referencia");
  const venc = t(fd, "vencimento");
  const valorTxt = t(fd, "valor_estimado");
  if (!UUID.test(obra)) return { erro: "Selecione o centro de custo." };
  if (!descricao) return { erro: "Informe a descrição (ex.: Conta de luz da casa alugada)." };
  if (mes && !/^\d{4}-\d{2}$/.test(mes)) return { erro: "Mês de referência inválido (use AAAA-MM)." };
  if (venc && !/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Vencimento inválido." };
  const valor = valorTxt ? lerValor(valorTxt) : null;
  if (valorTxt && valor === null) return { erro: "Valor estimado inválido." };

  const supabase = await createClient();
  const { error } = await supabase.from("provisoes").insert({
    obra_id: obra,
    descricao,
    mes_referencia: mes || null,
    vencimento: venc || null,
    valor_estimado: valor,
    observacoes: t(fd, "observacoes") || null,
  });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/provisoes");
  revalidatePath("/agenda");
  return { ok: "Provisão registrada. Ela aparece na agenda, mas não entra nos totais a pagar." };
}

export async function alterarProvisao(id: string, status: "convertida" | "cancelada", _: Estado): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(id)) return { erro: "Provisão não encontrada." };
  const supabase = await createClient();
  const { error } = await supabase.from("provisoes").update({ status }).eq("id", id);
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/provisoes");
  revalidatePath("/agenda");
  return { ok: status === "convertida" ? "Provisão marcada como lançada." : "Provisão cancelada." };
}
