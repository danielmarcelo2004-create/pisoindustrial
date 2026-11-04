import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "@/lib/database.types";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./env";

/** Cliente com a sessão do usuário logado: toda consulta passa pelo RLS. */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Chamado a partir de Server Component: o proxy renova a sessão.
        }
      },
    },
  });
}

/**
 * Cliente com a chave secreta (ignora RLS). Usado SOMENTE para operações de
 * administração de contas (criar usuário, redefinir senha, bloquear login),
 * sempre depois de confirmar que quem pediu é do Financeiro.
 */
export function createAdminClient() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("SUPABASE_SECRET_KEY não configurada.");
  return createPlainClient<Database>(SUPABASE_URL, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Confere a senha do usuário sem alterar a sessão atual (ações sensíveis). */
export async function conferirSenha(email: string, senha: string): Promise<boolean> {
  const temp = createPlainClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await temp.auth.signInWithPassword({ email, password: senha });
  if (error) return false;
  await temp.auth.signOut({ scope: "local" });
  return true;
}
