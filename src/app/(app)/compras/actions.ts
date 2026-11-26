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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(emissao) || Number.isNaN(new Date(emissao + "T12:00:00Z").getTime())) return { erro: "Informe a data de emissão." };
  // Data de emissão plausível: de 2000 até amanhã (nota com data absurda estraga o histórico e a evolução mensal).
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (emissao < "2000-01-01" || emissao > amanha) return { erro: "A data de emissão está fora do período aceito (de 2000 até hoje)." };
  const chaveDigitada = t(fd, "chave");
  if (chaveDigitada && !/^\d{44}$/.test(chaveDigitada.replace(/\s/g, ""))) return { erro: "A chave da nota deve ter 44 números (ou deixe em branco)." };
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
  if (frete !== null && !(frete >= 0)) return { erro: "Valor do frete inválido." };
  const produtos = itens.reduce((s, i) => s + i.valor_total, 0);

  const supabase = await createClient();
  const { error } = await supabase.rpc("registrar_nf", {
    p_documento_id: documentoId,
    p_origem: "manual",
    p_itens: itens,
    p_nota: {
      chave: chaveDigitada.replace(/\s/g, "") || null,
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
  // Consulta exata no banco: PDFs ainda sem leitura (as mais recentes primeiro), sem janela fixa que esconda as antigas
  const { data: docs } = await supabase.rpc("notas_fiscais_pendentes", { p_somente_pdf: true, p_limite: 200 });
  let ok = 0;
  let semLeitura = 0;
  for (const d of docs ?? []) {
    const arq = await supabase.storage.from("documentos").download(d.storage_path);
    if (arq.error || !arq.data) { semLeitura++; continue; }
    const texto = await extrairTextoPdf(Buffer.from(await arq.data.arrayBuffer()));
    const lida = texto ? lerNotaTexto(texto) : null;
    if (!lida?.confiavel || !lida.itens.length) { semLeitura++; continue; }
    if (!lida.nota.emitente_nome) lida.nota.emitente_nome = d.favorecido ?? "Fornecedor";
    const { error } = await supabase.rpc("registrar_nf", { p_documento_id: d.documento_id, p_nota: lida.nota as never, p_itens: lida.itens as never, p_origem: "ocr" });
    if (error) semLeitura++;
    else ok++;
  }
  revalidatePath("/compras", "layout");
  const { data: restam } = await supabase.rpc("notas_fiscais_pendentes_total");
  return {
    ok: `${ok} nota(s) lida(s) e incluída(s) na análise.${restam ? ` Ainda há ${restam} nota(s) sem leitura no total.` : ""}${semLeitura ? ` ${semLeitura} não puderam ser lidas automaticamente (imagem, PDF escaneado ou nota de serviço): use "Ler notas (PDF)".` : ""}`,
  };
}
