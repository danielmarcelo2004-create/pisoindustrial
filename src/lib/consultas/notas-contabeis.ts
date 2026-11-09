import { createClient } from "@/lib/supabase/server";
import type { CategoriaNota } from "@/lib/notas-contabeis";

export type SituacaoNota = "pendentes" | "enviadas" | "todas";

export type NotaContabil = {
  id: string;
  categoria: CategoriaNota;
  prestador_documento: string | null;
  prestador_nome: string | null;
  numero: string | null;
  data_emissao: string | null;
  valor: number | null;
  valor_liquido: number | null;
  retencoes: Partial<Record<"inss" | "irrf" | "csrf" | "iss", number>>;
  enviada_em: string | null;
  descricao_servico: string | null;
  documento: { id: string; ativo: boolean; nome_arquivo: string } | null;
  pagamento: { id: string; descricao: string } | null;
  obra: { nome: string } | null;
};

/** Notas identificadas (somente as dos documentos ainda ativos, sem as substituídas). */
export async function listarNotasContabeis(situacao: SituacaoNota): Promise<NotaContabil[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("notas_contabeis")
    .select("id, categoria, prestador_documento, prestador_nome, numero, data_emissao, valor, valor_liquido, retencoes, enviada_em, descricao_servico, documento:documentos(id, ativo, nome_arquivo), pagamento:pagamentos(id, descricao), obra:obras(nome)")
    .order("criada_em", { ascending: false })
    .limit(1000);
  return ((data ?? []) as unknown as NotaContabil[])
    .filter((n) => n.documento?.ativo)
    .filter((n) => situacao === "todas" || (situacao === "enviadas" ? !!n.enviada_em : !n.enviada_em));
}
