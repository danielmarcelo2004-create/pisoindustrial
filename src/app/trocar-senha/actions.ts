"use server";

import { redirect } from "next/navigation";
import { getUsuario } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { mensagemErro, type Estado } from "@/lib/erros";
import { validarSenha } from "@/lib/senha";

export async function trocarSenha(_: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const senha = String(fd.get("senha") ?? "");
  const confirmacao = String(fd.get("confirmacao") ?? "");
  const invalida = validarSenha(senha);
  if (invalida) return { erro: invalida };
  if (senha !== confirmacao) return { erro: "A confirmação não confere com a nova senha." };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: senha });
  if (error) {
    if (/same/i.test(error.message)) return { erro: "A nova senha deve ser diferente da senha provisória." };
    return { erro: mensagemErro(error) };
  }
  await supabase.rpc("confirmar_troca_senha");
  redirect("/?senha=alterada");
}
