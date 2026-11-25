import "server-only";
import { createClient } from "@/lib/supabase/server";

export type DadosFornecedor = { cpf_cnpj: string | null; chave_pix: string | null };

/**
 * CPF/CNPJ e chave PIX dos fornecedores informados. Saem pela visão "fornecedores_dados", que só devolve linhas
 * ao Financeiro, a Suprimentos e ao Administrador master; para os demais perfis o resultado vem vazio.
 */
export async function dadosDeFornecedores(ids: (string | null | undefined)[]): Promise<Map<string, DadosFornecedor>> {
  const lista = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const mapa = new Map<string, DadosFornecedor>();
  if (!lista.length) return mapa;
  const supabase = await createClient();
  for (let i = 0; i < lista.length; i += 200) {
    const { data } = await supabase.from("fornecedores_dados").select("id, cpf_cnpj, chave_pix").in("id", lista.slice(i, i + 200));
    for (const f of data ?? []) mapa.set(f.id, { cpf_cnpj: f.cpf_cnpj, chave_pix: f.chave_pix });
  }
  return mapa;
}
