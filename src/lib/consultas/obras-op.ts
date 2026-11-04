import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Obras ativas visíveis ao engenheiro (responsável ou vinculado). */
export async function obrasParaOP() {
  const supabase = await createClient();
  const { data } = await supabase.from("obras").select("id, nome, cidade, uf, administrador_id").eq("status", "ativa").order("nome");
  return (data ?? []).map((o) => ({ id: o.id, nome: o.nome, cidade: o.cidade, uf: o.uf, temAdministrador: !!o.administrador_id }));
}
