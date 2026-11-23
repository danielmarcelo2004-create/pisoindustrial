import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Contas bancárias ativas (só nome e identificação; o saldo fica restrito ao Financeiro/master). */
export async function contasBancariasAtivas(): Promise<{ id: string; nome: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase.from("contas_bancarias").select("id, nome").eq("ativa", true).eq("tipo", "corrente").order("nome"); // investimento não paga despesa
  return data ?? [];
}
