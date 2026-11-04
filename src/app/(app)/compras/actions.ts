"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { normalizarDescricao } from "@/lib/nfe";
import { createClient } from "@/lib/supabase/server";

const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const num = (s: string) => (s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s));

/** Lançamento manual (conferência humana) dos itens de uma NF em PDF/imagem. */
export async function lancarNF(documentoId: string, pagamentoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  const emissao = t(fd, "data_emissao");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(emissao)) return { erro: "Informe a data de emissão." };
  if (!t(fd, "emitente_nome")) return { erro: "Informe o fornecedor (emitente)." };
  let brutos: Record<string, string>[];
  try {
    brutos = JSON.parse(t(fd, "itens") || "[]");
  } catch {
    return { erro: "Itens inválidos." };
  }
  const itens = [];
  for (const [i, b] of brutos.entries()) {
    const descricao = String(b.descricao ?? "").trim();
    if (!descricao) continue;
    const quantidade = num(String(b.quantidade ?? ""));
    const vu = num(String(b.valor_unitario ?? ""));
    if (!(quantidade > 0)) return { erro: `Item ${i + 1}: quantidade inválida.` };
    if (!(vu >= 0)) return { erro: `Item ${i + 1}: valor unitário inválido.` };
    itens.push({
      numero_item: itens.length + 1,
      codigo: null,
      descricao,
      descricao_normalizada: normalizarDescricao(descricao),
      ncm: null,
      unidade: String(b.unidade ?? "").trim().toUpperCase() || null,
      quantidade,
      valor_unitario: vu,
      valor_total: Math.round(quantidade * vu * 100) / 100,
    });
  }
  if (!itens.length) return { erro: "Informe ao menos um item." };
  const frete = t(fd, "valor_frete") ? num(t(fd, "valor_frete")) : null;
  const produtos = itens.reduce((s, i) => s + i.valor_total, 0);

  const supabase = await createClient();
  const { error } = await supabase.rpc("registrar_nf", {
    p_documento_id: documentoId,
    p_origem: "manual",
    p_itens: itens,
    p_nota: {
      chave: t(fd, "chave") || null,
      numero: t(fd, "numero") || null,
      serie: null,
      data_emissao: emissao,
      emitente_cnpj: t(fd, "emitente_cnpj") || null,
      emitente_nome: t(fd, "emitente_nome"),
      emitente_uf: t(fd, "emitente_uf") || null,
      valor_produtos: produtos,
      valor_frete: frete,
      valor_desconto: null,
      valor_total: produtos + (frete ?? 0),
    },
  });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath(`/pagamentos/${pagamentoId}`);
  redirect(`/pagamentos/${pagamentoId}?nf=lancada`);
}

export async function removerNF(notaId: string, pagamentoId: string, _: Estado): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  const supabase = await createClient();
  const { error } = await supabase.rpc("remover_nf", { p_nota_id: notaId });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath(`/pagamentos/${pagamentoId}`);
  return { ok: "Itens removidos. Você pode lançar novamente." };
}
