"use server";

import { revalidatePath } from "next/cache";
import { getUsuario } from "@/lib/auth";
import type { Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";

export async function marcarTodasLidas(_: Estado): Promise<Estado> {
  await getUsuario();
  const supabase = await createClient();
  const { error } = await supabase.rpc("marcar_notificacoes_lidas", {});
  if (error) return { erro: "Não foi possível marcar as notificações como lidas. Tente de novo." };
  revalidatePath("/", "layout");
  return { ok: "Todas as notificações foram marcadas como lidas." };
}
