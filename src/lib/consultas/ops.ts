import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { DadosPdfOP } from "@/lib/pdf-op";

export async function carregarOP(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("ordens_pagamento")
    .select(
      "*, obra:obras(id, nome, codigo, cidade, uf), solicitante:profiles!ordens_pagamento_solicitante_id_fkey(nome), ordem_itens(*), pagamento:pagamentos(id, status, numero, rejeicao_motivo, cancelamento_motivo, pago_em)",
    )
    .eq("id", id)
    .order("posicao", { referencedTable: "ordem_itens" })
    .maybeSingle();
  return data;
}

export type OPCompleta = NonNullable<Awaited<ReturnType<typeof carregarOP>>>;

export function dadosPdf(op: OPCompleta): DadosPdfOP {
  return {
    numero: op.numero,
    rascunho: op.status === "em_elaboracao",
    dataEmissao: op.enviada_em ?? op.created_at,
    favorecido: op.favorecido,
    cpfCnpj: op.cpf_cnpj,
    numeroNf: op.numero_nf,
    vencimento: op.vencimento,
    formaPagamento: op.forma_pagamento,
    dadosBancarios: op.dados_bancarios,
    centroDeCusto: op.obra?.nome ?? "",
    solicitante: op.solicitante?.nome ?? "",
    emitidaEm: op.enviada_em ?? op.updated_at,
    itens: op.ordem_itens.map((i) => ({
      descricao: i.descricao,
      unidade: i.unidade,
      quantidade: Number(i.quantidade),
      valorUnitario: Number(i.valor_unitario),
      total: Number(i.total),
    })),
  };
}
