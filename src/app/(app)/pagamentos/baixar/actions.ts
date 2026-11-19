"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUsuario } from "@/lib/auth";
import { enviarDocumento } from "@/lib/documentos";
import { mensagemErro, type Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

type Item = {
  /** "pag:<id>" ou "parc:<id>" */
  chave: string;
  pago_em: string;
  /** Valor lido no comprovante (null = valor do pagamento). */
  valor: number | null;
  /** Campo do arquivo do comprovante no formulário (ausente = baixa sem comprovante). */
  arquivo?: string;
};

/**
 * Baixa de um ou de vários pagamentos marcados na lista: cada item é um pagamento (ou parcela) com a data e o valor do seu comprovante.
 * O comprovante (uma página separada do PDF do banco) é anexado ao pagamento.
 */
export async function registrarBaixasLote(_: Estado, fd: FormData): Promise<Estado> {
  const u = await getUsuario();
  if (u.perfil !== "financeiro" && u.perfil !== "administrador_master") {
    return { erro: "Somente o Financeiro e o Administrador master registram baixas." };
  }
  let itens: Item[];
  try {
    itens = JSON.parse(String(fd.get("itens") ?? "[]"));
  } catch {
    return { erro: "Seleção inválida." };
  }
  itens = (Array.isArray(itens) ? itens : []).slice(0, 300);
  if (itens.length === 0) return { erro: "Nenhum pagamento escolhido para a baixa." };
  const chaves = itens.map((i) => i.chave);
  if (new Set(chaves).size !== chaves.length) return { erro: "Um mesmo pagamento não pode receber duas baixas." };

  const supabase = await createClient();
  const erros: string[] = [];
  let baixados = 0;
  let anexados = 0;
  for (const it of itens) {
    const [tipo, id] = String(it.chave).split(":");
    if (!UUID.test(id ?? "") || (tipo !== "pag" && tipo !== "parc")) {
      erros.push("Item inválido.");
      continue;
    }
    if (!DATA.test(it.pago_em ?? "")) {
      erros.push("Data de pagamento inválida.");
      continue;
    }
    const valor = typeof it.valor === "number" && Number.isFinite(it.valor) && it.valor > 0 ? Math.round(it.valor * 100) / 100 : null;
    const obs = itens.length > 1 ? (it.arquivo ? "Baixa em lote com comprovante" : "Baixa em lote") : it.arquivo ? "Baixa com comprovante" : "Baixa";

    let pagamentoId = id;
    let rotulo = "";
    if (tipo === "parc") {
      const { data: pc } = await supabase.from("pagamento_parcelas").select("pagamento_id, numero, valor_base, multa, juros, desconto, pagamento:pagamentos(numero)").eq("id", id).maybeSingle();
      if (!pc) {
        erros.push("Parcela não encontrada.");
        continue;
      }
      pagamentoId = pc.pagamento_id;
      rotulo = `nº ${pc.pagamento?.numero} (parcela ${pc.numero})`;
      const devido = Number(pc.valor_base) + Number(pc.multa) + Number(pc.juros) - Number(pc.desconto);
      const { error } = await supabase.rpc("registrar_baixa_parcela", {
        p_parcela_id: id,
        p_pago_em: it.pago_em,
        p_valor_pago: valor ?? Math.round(devido * 100) / 100,
        p_observacao: obs,
      });
      if (error) {
        erros.push(`${rotulo}: ${mensagemErro(error)}`);
        continue;
      }
    } else {
      const { data: p } = await supabase.from("pagamentos").select("numero, valor").eq("id", id).maybeSingle();
      if (!p) {
        erros.push("Pagamento não encontrado.");
        continue;
      }
      rotulo = `nº ${p.numero}`;
      // Valor do comprovante diferente do pagamento: menor vira saldo em aberto (padrão); maior (juros) fica registrado.
      const { error } = await supabase.rpc("registrar_baixa", {
        p_id: id,
        p_pago_em: it.pago_em,
        p_valor_pago: valor !== null && Math.abs(valor - Number(p.valor)) >= 0.005 ? valor : undefined,
        p_observacao: obs,
        p_diferenca: "saldo",
      });
      if (error) {
        erros.push(`${rotulo}: ${mensagemErro(error)}`);
        continue;
      }
    }
    baixados++;

    const arquivo = it.arquivo ? fd.get(it.arquivo) : null;
    if (arquivo && typeof arquivo !== "string") {
      const { data: pg } = await supabase.from("pagamentos").select("id, obra_id").eq("id", pagamentoId).single();
      if (pg) {
        const r = await enviarDocumento(supabase, pg, "comprovante", arquivo as File);
        if (r.erro) erros.push(`Comprovante do ${rotulo}: ${r.erro}`);
        else anexados++;
      }
    }
  }

  revalidatePath("/", "layout");
  const resumo = `${baixados} pagamento(s) registrados como pagos${anexados ? `, com ${anexados} comprovante(s) anexados` : ""}.`;
  if (erros.length) return { erro: `${resumo} Problemas: ${erros.join(" ")}` };
  redirect(`/pagamentos?baixados=${baixados}`);
}
