"use server";

import { revalidatePath } from "next/cache";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f-]{36}$/i;

/** Cadastro rápido (janelinha do Novo pagamento): devolve a categoria criada para já ficar selecionada. */
export async function criarCategoriaRapida(nome: string): Promise<{ id?: string; nome?: string; erro?: string }> {
  await exigirPerfil("financeiro", "administrador_master");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("criar_categoria", { p_nome: nome });
  if (error || !data) return { erro: mensagemErro(error) };
  revalidatePath("/categorias");
  return { id: data, nome: nome.trim() };
}

export async function criarCategoria(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "administrador_master");
  const supabase = await createClient();
  const { error } = await supabase.rpc("criar_categoria", { p_nome: String(fd.get("nome") ?? "") });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/categorias");
  return { ok: "Categoria cadastrada." };
}

export async function atualizarCategoria(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "administrador_master");
  if (!UUID.test(id)) return { erro: "Categoria não encontrada." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("atualizar_categoria", {
    p_id: id,
    p_nome: String(fd.get("nome") ?? ""),
    p_ativo: fd.get("ativo") === "on",
  });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/categorias");
  return { ok: "Categoria atualizada." };
}
