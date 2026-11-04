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
  redirect(voltar.startsWith("/") && !voltar.startsWith("//") ? voltar : "/");
}
