import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Usuario } from "@/lib/auth";

export async function fornecedoresAtivos() {
  const supabase = await createClient();
  const { data } = await supabase.from("fornecedores").select("id, nome, cpf_cnpj").eq("ativo", true).order("nome");
  return data ?? [];
}

/** Obras ativas em que o usuário pode cadastrar pagamentos. */
export async function obrasParaCadastro(u: Usuario) {
  const supabase = await createClient();
  let q = supabase.from("obras").select("id, nome, cidade, uf, fluxo").eq("status", "ativa").order("nome");
  if (u.perfil === "suprimentos") {
    const { data: acessos } = await supabase.from("obra_acessos").select("obra_id").eq("user_id", u.id);
    q = q.in("id", (acessos ?? []).map((a) => a.obra_id));
  } else if (u.perfil !== "financeiro") {
    return [];
  }
  const { data } = await q;
  return data ?? [];
}
