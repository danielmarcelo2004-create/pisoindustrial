import "server-only";
import type { Aberto } from "@/lib/comprovantes-banco";
import { moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";

/** Chave PIX gravada nos dados bancários da OP ("CHAVE PIX: ..."). */
function chaveDosDados(dados: string | null | undefined): string | null {
  const m = (dados ?? "").match(/CHAVE\s+PIX:\s*(\S+)/i);
  return m ? m[1] : null;
}

/**
 * Tudo que pode receber baixa agora: pagamentos liberados (sem parcelas) e parcelas em aberto
 * de pagamentos liberados, com os dados usados para reconhecer o comprovante (CNPJ/CPF, chave PIX).
 */
export async function abertosParaBaixa(): Promise<Aberto[]> {
  const supabase = await createClient();
  const { data: pags } = await supabase
    .from("pagamentos")
    .select(
      "id, numero, favorecido, descricao, valor, vencimento, forma_pagamento, obra:obras(nome), fornecedor:fornecedores(cpf_cnpj, chave_pix), ordem:ordens_pagamento!pagamentos_ordem_id_fkey(cpf_cnpj, dados_bancarios)",
    )
    .eq("status", "aguardando_pagamento")
    .order("vencimento", { ascending: true })
    .limit(500);
  const lista = pags ?? [];
  const ids = lista.map((p) => p.id);
  const { data: parcelas } = ids.length
    ? await supabase.from("pagamento_parcelas").select("id, pagamento_id, numero, valor_base, multa, juros, desconto, vencimento, status").in("pagamento_id", ids).order("numero")
    : { data: [] as { id: string; pagamento_id: string; numero: number; valor_base: number; multa: number; juros: number; desconto: number; vencimento: string; status: string }[] };
  const porPagamento = new Map<string, NonNullable<typeof parcelas>>();
  for (const pc of parcelas ?? []) porPagamento.set(pc.pagamento_id, [...(porPagamento.get(pc.pagamento_id) ?? []), pc]);

  const abertos: Aberto[] = [];
  for (const p of lista) {
    const cpfCnpj = p.fornecedor?.cpf_cnpj || p.ordem?.cpf_cnpj || null;
    const chavePix = p.fornecedor?.chave_pix || chaveDosDados(p.ordem?.dados_bancarios);
    const obra = p.obra?.nome ?? "";
    const pcs = porPagamento.get(p.id);
    if (pcs?.length) {
      for (const pc of pcs.filter((x) => x.status !== "pago")) {
        const valor = Math.round((Number(pc.valor_base) + Number(pc.multa) + Number(pc.juros) - Number(pc.desconto)) * 100) / 100;
        abertos.push({
          chave: `parc:${pc.id}`,
          tipo: "parcela",
          pagamentoId: p.id,
          parcelaId: pc.id,
          numero: p.numero,
          rotulo: `nº ${p.numero} · parcela ${pc.numero}/${pcs.length} · ${p.favorecido} · ${moeda(valor)} · ${obra}`,
          favorecido: p.favorecido,
          valor,
          vencimento: pc.vencimento,
          cpfCnpj,
          chavePix,
          formaPagamento: p.forma_pagamento,
        });
      }
      continue;
    }
    abertos.push({
      chave: `pag:${p.id}`,
      tipo: "pagamento",
      pagamentoId: p.id,
      numero: p.numero,
      rotulo: `nº ${p.numero} · ${p.favorecido} · ${moeda(p.valor)} · ${obra}`,
      favorecido: p.favorecido,
      valor: Number(p.valor),
      vencimento: p.vencimento,
      cpfCnpj,
      chavePix,
      formaPagamento: p.forma_pagamento,
    });
  }
  return abertos;
}
