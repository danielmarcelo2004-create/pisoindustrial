import "server-only";
import { createClient } from "@/lib/supabase/server";

export async function responsaveisAtivos() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, nome, perfil")
    .eq("ativo", true)
    .in("perfil", ["engenheiro", "administrador"])
    .order("nome");
  return {
    engenheiros: (data ?? []).filter((p) => p.perfil === "engenheiro"),
    administradores: (data ?? []).filter((p) => p.perfil === "administrador"),
  };
}
