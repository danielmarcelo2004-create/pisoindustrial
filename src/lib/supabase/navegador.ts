"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Cliente do navegador (mesma sessão do usuário; o RLS continua valendo). */
export function criarClienteNavegador() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
}
