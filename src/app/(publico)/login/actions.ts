"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Estado } from "@/lib/erros";

export async function entrar(_: Estado, fd: FormData): Promise<Estado> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const senha = String(fd.get("senha") ?? "");
  if (!email || !senha) return { erro: "Informe e-mail e senha." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
  if (error) {
    if (/banned/i.test(error.message)) return { erro: "Seu acesso está desativado. Fale com o Financeiro." };
    return { erro: "E-mail ou senha incorretos." };
  }

  const voltar = String(fd.get("voltar") ?? "");
  // Evita redirecionamento para fora do sistema.
  // Só caminhos internos simples: barra inicial, sem "//", sem "\\" (o navegador a trata como "/") e sem caracteres de controle.
  const seguro = voltar.startsWith("/") && !voltar.startsWith("//") && !/[\\\u0000-\u001f\u007f]/.test(voltar);
  redirect(seguro ? voltar : "/");
}
