import "server-only";
import { createClient } from "@/lib/supabase/server";

export type Categoria = { id: string; nome: string };

/** Categorias ativas, em ordem alfabética: de despesa (cadastro de pagamento) ou de receita (contas a receber). */
export async function categoriasAtivas(tipo: "despesa" | "receita" = "despesa"): Promise<Categoria[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("categorias").select("id, nome").eq("ativo", true).eq("tipo", tipo).order("nome");
  return data ?? [];
}
