"use server";

import { revalidatePath } from "next/cache";
import { getUsuario } from "@/lib/auth";
import type { Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";

export async function marcarTodasLidas(_: Estado): Promise<Estado> {
  await getUsuario();
  const supabase = await createClient();
  await supabase.rpc("marcar_notificacoes_lidas", {});
  revalidatePath("/", "layout");
  return { ok: "Todas as notificações foram marcadas como lidas." };
}
