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

/**
 * Lê de uma vez as notas fiscais em PDF já anexadas e ainda não lidas (PDF com texto: DANFE).
 * As que são imagem ou PDF escaneado continuam para "Ler notas" (leitura no navegador).
 */
export async function lerNotasPendentes(_: Estado, __: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  const { extrairTextoPdf } = await import("@/lib/pdf-texto");
  const { lerNotaTexto } = await import("@/lib/ocr/nota-fiscal");
  const supabase = await createClient();
  const { data: docs } = await supabase
    .from("documentos")
    .select("id, storage_path, pagamento:pagamentos(favorecido)")
    .eq("tipo", "nota_fiscal")
    .eq("ativo", true)
    .eq("mime_type", "application/pdf")
    .order("created_at", { ascending: false })
    .limit(500);
  const ids = (docs ?? []).map((d) => d.id);
  const [{ data: lidas }, { data: contabeis }] = await Promise.all([
    supabase.from("nf_notas").select("documento_id").in("documento_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from("notas_contabeis").select("documento_id").in("documento_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  const feitas = new Set([...(lidas ?? []), ...(contabeis ?? [])].map((x) => x.documento_id));
  let ok = 0;
  let semLeitura = 0;
  for (const d of (docs ?? []).filter((x) => !feitas.has(x.id)).slice(0, 60)) {
    const arq = await supabase.storage.from("documentos").download(d.storage_path);
    if (arq.error || !arq.data) { semLeitura++; continue; }
    const texto = await extrairTextoPdf(Buffer.from(await arq.data.arrayBuffer()));
    const lida = texto ? lerNotaTexto(texto) : null;
    if (!lida?.confiavel || !lida.itens.length) { semLeitura++; continue; }
    if (!lida.nota.emitente_nome) lida.nota.emitente_nome = ((Array.isArray(d.pagamento) ? d.pagamento[0] : d.pagamento) as { favorecido: string } | null)?.favorecido ?? "Fornecedor";
    const { error } = await supabase.rpc("registrar_nf", { p_documento_id: d.id, p_nota: lida.nota as never, p_itens: lida.itens as never, p_origem: "ocr" });
    if (error) semLeitura++;
    else ok++;
  }
  revalidatePath("/compras", "layout");
  return {
    ok: `${ok} nota(s) lida(s) e incluída(s) na análise.${semLeitura ? ` ${semLeitura} não puderam ser lidas automaticamente (imagem, PDF escaneado ou nota de serviço): use "Ler notas (PDF)".` : ""}`,
  };
}
