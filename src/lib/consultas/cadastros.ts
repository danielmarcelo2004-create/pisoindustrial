import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Usuario } from "@/lib/auth";

export async function fornecedoresAtivos() {
  const supabase = await createClient();
  // CPF/CNPJ só pela visão liberada ao Financeiro/Suprimentos/master; quem não a vê escolhe o fornecedor pelo nome
  const { data } = await supabase.from("fornecedores_dados").select("id, nome, cpf_cnpj").eq("ativo", true).order("nome");
  if (data?.length) return data;
  const { data: nomes } = await supabase.from("fornecedores").select("id, nome").eq("ativo", true).order("nome");
  return (nomes ?? []).map((f) => ({ ...f, cpf_cnpj: null as string | null }));
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
