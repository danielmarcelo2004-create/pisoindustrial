"use server";

import { revalidatePath } from "next/cache";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { PERFIS, type Perfil } from "@/lib/rotulos";
import { gerarSenhaProvisoria, validarSenha } from "@/lib/senha";
import { createAdminClient, createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const BLOQUEIO = "876000h"; // ~100 anos

export async function criarUsuario(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  const nome = t(fd, "nome");
  const email = t(fd, "email").toLowerCase();
  const perfil = t(fd, "perfil") as Perfil;
  const senha = t(fd, "senha") || gerarSenhaProvisoria();
  const obras = fd.getAll("obras").map(String).filter((x) => UUID.test(x));

  if (!nome) return { erro: "Informe o nome." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { erro: "Informe um e-mail válido." };
  if (!(perfil in PERFIS)) return { erro: "Selecione o perfil." };
  const invalida = validarSenha(senha);
  if (invalida) return { erro: `Senha provisória: ${invalida}` };

  const admin = createAdminClient();
  const { data: criado, error } = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (error || !criado.user) {
    if (/already|registered|exists/i.test(error?.message ?? "")) return { erro: "Já existe um usuário com este e-mail." };
    return { erro: mensagemErro(error) };
  }

  // O perfil é gravado com a sessão do Financeiro: o RLS confere a permissão e a
  // auditoria registra quem criou.
  const supabase = await createClient();
  const { error: e2 } = await supabase.from("profiles").insert({
    id: criado.user.id,
    nome,
    email,
    telefone: t(fd, "telefone") || null,
    perfil,
    troca_senha_pendente: true,
  });
  if (e2) {
    await admin.auth.admin.deleteUser(criado.user.id);
    return { erro: mensagemErro(e2) };
  }
  if (obras.length) {
    const { error: e3 } = await supabase.from("obra_acessos").insert(obras.map((obra_id) => ({ obra_id, user_id: criado.user.id })));
    if (e3) return { erro: `Usuário criado, mas houve erro ao conceder acessos: ${mensagemErro(e3)}` };
  }

  revalidatePath("/usuarios");
  return {
    ok: `Usuário ${nome} criado.`,
    dados: { email, senha, id: criado.user.id },
  };
}

export async function atualizarUsuario(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(id)) return { erro: "Usuário inválido." };
  const perfil = t(fd, "perfil") as Perfil;
  if (!(perfil in PERFIS)) return { erro: "Selecione o perfil." };
  if (!t(fd, "nome")) return { erro: "Informe o nome." };
  const ativo = fd.get("ativo") === "on";

  const supabase = await createClient();
  const { data: antes } = await supabase.from("profiles").select("ativo").eq("id", id).single();
  const { error } = await supabase
    .from("profiles")
    .update({ nome: t(fd, "nome"), telefone: t(fd, "telefone") || null, perfil, ativo })
    .eq("id", id);
  if (error) return { erro: mensagemErro(error) };

  if (antes && antes.ativo !== ativo) {
    const { error: e2 } = await createAdminClient().auth.admin.updateUserById(id, { ban_duration: ativo ? "none" : BLOQUEIO });
    if (e2) return { erro: `Dados salvos, mas houve erro ao ${ativo ? "liberar" : "bloquear"} o login: ${e2.message}` };
  }
  revalidatePath("/usuarios", "layout");
  return { ok: ativo === antes?.ativo ? "Usuário atualizado." : ativo ? "Usuário reativado." : "Usuário desativado: o acesso foi bloqueado." };
}

export async function redefinirSenha(id: string, _: Estado): Promise<Estado> {
  const eu = await exigirPerfil("financeiro");
  if (!UUID.test(id)) return { erro: "Usuário inválido." };
  if (id === eu.id) return { erro: "Para alterar a sua própria senha use “Alterar senha”." };
  const senha = gerarSenhaProvisoria();
  const supabase = await createClient();
  const { data: alvo } = await supabase.from("profiles").select("email").eq("id", id).single();
  if (!alvo) return { erro: "Usuário não encontrado." };

  const { error } = await createAdminClient().auth.admin.updateUserById(id, { password: senha });
  if (error) return { erro: mensagemErro(error) };
  await supabase.from("profiles").update({ troca_senha_pendente: true }).eq("id", id);
  revalidatePath(`/usuarios/${id}`);
  return { ok: "Senha provisória gerada.", dados: { email: alvo.email, senha } };
}

export async function salvarAcessos(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(id)) return { erro: "Usuário inválido." };
  const marcadas = new Set(fd.getAll("obras").map(String).filter((x) => UUID.test(x)));
  const supabase = await createClient();
  const { data: atuais } = await supabase.from("obra_acessos").select("obra_id").eq("user_id", id);
  const tinha = new Set((atuais ?? []).map((a) => a.obra_id));
  const novas = [...marcadas].filter((o) => !tinha.has(o));
  const removidas = [...tinha].filter((o) => !marcadas.has(o));

  if (novas.length) {
    const { error } = await supabase.from("obra_acessos").insert(novas.map((obra_id) => ({ obra_id, user_id: id })));
    if (error) return { erro: mensagemErro(error) };
  }
  if (removidas.length) {
    const { error } = await supabase.from("obra_acessos").delete().eq("user_id", id).in("obra_id", removidas);
    if (error) return { erro: mensagemErro(error) };
  }
  revalidatePath(`/usuarios/${id}`);
  return { ok: novas.length || removidas.length ? `Acessos atualizados (+${novas.length} / −${removidas.length}).` : "Nenhuma alteração." };
}
