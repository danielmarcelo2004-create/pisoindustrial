import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Perfil } from "@/lib/rotulos";

export type Usuario = {
  id: string;
  nome: string;
  email: string;
  telefone: string | null;
  perfil: Perfil;
  trocaSenhaPendente: boolean;
};

/**
 * Usuário logado (uma consulta por requisição). Redireciona para o login se
 * não houver sessão válida ou se o usuário estiver desativado.
 */
export const getUsuario = cache(async (): Promise<Usuario> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const id = data?.claims?.sub;
  if (!id) redirect("/login");

  const { data: p } = await supabase
    .from("profiles")
    .select("id, nome, email, telefone, perfil, ativo, troca_senha_pendente")
    .eq("id", id)
    .maybeSingle();
  if (!p || !p.ativo) redirect("/sair?motivo=inativo");

  return {
    id: p.id,
    nome: p.nome,
    email: p.email,
    telefone: p.telefone,
    perfil: p.perfil,
    trocaSenhaPendente: p.troca_senha_pendente,
  };
});

/** Garante que o usuário tem um dos perfis informados (senão volta ao início). */
export async function exigirPerfil(...perfis: Perfil[]): Promise<Usuario> {
  const u = await getUsuario();
  if (!perfis.includes(u.perfil)) redirect("/?sem-permissao=1");
  return u;
}
