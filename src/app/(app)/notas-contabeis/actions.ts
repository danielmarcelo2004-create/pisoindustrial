"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function marcarNotaEnviada(id: string, enviada: boolean, _: Estado): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(id)) return { erro: "Nota não encontrada." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("marcar_nota_contabil_enviada", { p_id: id, p_enviada: enviada });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/notas-contabeis");
  // A nota sai da lista "A enviar": volta à lista com a confirmação.
  redirect(`/notas-contabeis?aviso=${enviada ? "enviada" : "reaberta"}`);
}
