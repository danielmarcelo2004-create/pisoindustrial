import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Link temporário da assinatura cadastrada do usuário (só para o engenheiro, que assina a OP e os anexos). */
export async function assinaturaDoUsuario(userId: string, ehEngenheiro: boolean): Promise<string | null> {
  if (!ehEngenheiro) return null;
  const supabase = await createClient();
  const { data: perfil } = await supabase.from("profiles").select("assinatura_path").eq("id", userId).single();
  const caminho = perfil?.assinatura_path;
  if (!caminho || !caminho.startsWith(`${userId}/`) || caminho.endsWith("/removida")) return null;
  const { data } = await supabase.storage.from("assinaturas").createSignedUrl(caminho, 600);
  return data?.signedUrl ?? null;
}
