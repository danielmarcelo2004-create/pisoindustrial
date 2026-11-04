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
    obra: { nome: op.obra!.nome, codigo: op.obra!.codigo, cidade: op.obra!.cidade, uf: op.obra!.uf },
    solicitante: op.solicitante?.nome ?? "",
    emitidaEm: op.enviada_em ?? op.updated_at,
    favorecido: op.favorecido,
    cpfCnpj: op.cpf_cnpj,
    descricao: op.descricao,
    vencimento: op.vencimento,
    formaPagamento: op.forma_pagamento,
    dadosBancarios: op.dados_bancarios,
    observacoes: op.observacoes,
    itens: op.ordem_itens.map((i) => ({
      descricao: i.descricao,
      unidade: i.unidade,
      quantidade: Number(i.quantidade),
      valorUnitario: Number(i.valor_unitario),
      total: Number(i.total),
    })),
  };
}
