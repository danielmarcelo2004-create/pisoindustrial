import "server-only";
import { createClient } from "@/lib/supabase/server";

export type Categoria = { id: string; nome: string };

/** Categorias ativas, em ordem alfabética (para escolher no cadastro de pagamento). */
export async function categoriasAtivas(): Promise<Categoria[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("categorias").select("id, nome").eq("ativo", true).order("nome");
  return data ?? [];
}
