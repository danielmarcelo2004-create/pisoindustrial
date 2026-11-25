import { descartarArquivoEnviado } from "@/lib/storage-limpeza";
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { mensagemErro } from "@/lib/erros";
import type { TipoDocumento } from "@/lib/rotulos";
import { lerNFe } from "@/lib/nfe";
import { lerNotaTexto } from "@/lib/ocr/nota-fiscal";
import { classificarNota, lerNfseTexto, lerNfseXml, type DadosNota } from "@/lib/notas-contabeis";
import { extrairTextoPdf } from "@/lib/pdf-texto";
import { SISTEMA } from "@/lib/sistema";

const TAMANHO_MAXIMO = 25 * 1024 * 1024;

const MIME_POR_EXTENSAO: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  xml: "application/xml",
};

export function arquivosDoForm(fd: FormData, campo: string): File[] {
  return fd
    .getAll(campo)
    .filter((f): f is File => typeof f === "object" && f !== null && "size" in f && (f as File).size > 0);
}

/** Confere os primeiros bytes do arquivo. Devolve a mensagem de erro, ou null quando o conteúdo combina com a extensão. */
export function conteudoCombinaComExtensao(ext: string, b: Uint8Array): string | null {
  if (b.length === 0) return "o arquivo está vazio.";
  const inicio = (...x: number[]) => x.every((v, i) => b[i] === v);
  const texto = (s: string) => Buffer.from(b.subarray(0, 1024)).toString("latin1").includes(s);
  if (ext === "pdf" && !texto("%PDF-")) return "o conteúdo não é um PDF válido.";
  if (ext === "png" && !inicio(0x89, 0x50, 0x4e, 0x47)) return "o conteúdo não é uma imagem PNG válida.";
  if ((ext === "jpg" || ext === "jpeg") && !inicio(0xff, 0xd8)) return "o conteúdo não é uma imagem JPG válida.";
  if (ext === "xml" && !texto("<")) return "o conteúdo não é um XML válido.";
  return null;
}

/** Confere extensão, tamanho e o conteúdo (primeiros bytes) do arquivo, antes de gravar qualquer coisa. */
export async function validarArquivoCompleto(f: File): Promise<string | null> {
  const simples = validarArquivo(f);
  if (simples) return simples;
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  const erro = conteudoCombinaComExtensao(ext, new Uint8Array(await f.slice(0, 1024).arrayBuffer()));
  return erro ? `${f.name}: ${erro}` : null;
}

export function validarArquivo(f: File): string | null {
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (!MIME_POR_EXTENSAO[ext]) return `Formato não aceito: ${f.name}. Envie PDF, imagem (PNG/JPG/WEBP/HEIC) ou XML.`;
  if (f.size > TAMANHO_MAXIMO) return `Arquivo muito grande: ${f.name} (máximo 25 MB).`;
  return null;
}

/**
 * Envia o arquivo ao Storage (com a sessão do usuário — RLS aplicado) e o
 * registra no pagamento. O SHA-256 é calculado no servidor.
 */
export async function enviarDocumento(
  supabase: SupabaseClient<Database>,
  pagamento: { id: string; obra_id: string },
  tipo: TipoDocumento,
  arquivo: File,
  substitui?: { id: string; motivo: string },
): Promise<{ erro?: string; id?: string; aviso?: string }> {
  const invalido = validarArquivo(arquivo);
  if (invalido) return { erro: invalido };

  const ext = arquivo.name.split(".").pop()!.toLowerCase();
  const mime = MIME_POR_EXTENSAO[ext];
  const bytes = Buffer.from(await arquivo.arrayBuffer());
  // O conteúdo precisa combinar com a extensão (um .txt renomeado para .pdf não é aceito).
  const assinaturaInvalida = conteudoCombinaComExtensao(ext, bytes);
  if (assinaturaInvalida) return { erro: `${arquivo.name}: ${assinaturaInvalida}` };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const caminho = `${pagamento.obra_id}/${pagamento.id}/${randomUUID()}.${ext}`;

  const up = await supabase.storage.from("documentos").upload(caminho, bytes, { contentType: mime, upsert: false });
  if (up.error) return { erro: `Falha ao enviar ${arquivo.name}: ${mensagemErro(up.error)}` };

  const { data, error } = await supabase.rpc("registrar_documento", {
    p_pagamento_id: pagamento.id,
    p_tipo: tipo,
    p_nome_arquivo: arquivo.name.slice(0, 200),
    p_storage_path: caminho,
    p_mime_type: mime,
    p_tamanho: arquivo.size,
    p_sha256: sha256,
    p_substitui_id: substitui?.id ?? undefined,
    p_motivo: substitui?.motivo ?? undefined,
  });
  if (error) {
    await descartarArquivoEnviado(caminho); // o arquivo já subiu: não deixa órfão no Storage
    return { erro: mensagemErro(error) };
  }
  const id = data as string;

  if (tipo === "nota_fiscal" && ext === "xml") {
    const texto = bytes.toString("utf8");
    // XML de NF-e (produtos): alimenta a Inteligência de Compras automaticamente.
    const lida = lerNFe(texto);
    if (lida) {
      const r = await supabase.rpc("registrar_nf", { p_documento_id: id, p_nota: lida.nota, p_itens: lida.itens, p_origem: "xml" });
      if (r.error) return { id, aviso: `Itens da NF não registrados: ${mensagemErro(r.error)}` };
      return { id };
    }
    // XML de NFS-e (serviços): identificado para a contabilidade.
    const nfse = lerNfseXml(texto);
    if (!nfse) return { id, aviso: `O XML ${arquivo.name} não foi reconhecido como NF-e nem NFS-e; os itens não foram lidos.` };
    return { id, aviso: await registrarNotaContabil(supabase, id, nfse) };
  }

  if (tipo === "nota_fiscal" && ext === "pdf") {
    const texto = await extrairTextoPdf(bytes);
    // DANFE (NF-e de produtos) em PDF com texto: alimenta a Inteligência de Compras na hora,
    // só quando todas as linhas de item fecham a conta (senão fica para "Ler notas").
    const danfe = texto ? lerNotaTexto(texto) : null;
    if (danfe?.confiavel && danfe.itens.length) {
      // Sem a razão social no texto, usa o favorecido da despesa
      if (!danfe.nota.emitente_nome) danfe.nota.emitente_nome = (await supabase.from("pagamentos").select("favorecido").eq("id", pagamento.id).maybeSingle()).data?.favorecido ?? "Fornecedor";
      const r = await supabase.rpc("registrar_nf", { p_documento_id: id, p_nota: danfe.nota as never, p_itens: danfe.itens as never, p_origem: "ocr" });
      if (r.error) return { id, aviso: `Itens da NF não registrados: ${mensagemErro(r.error)}` };
      return { id };
    }
    // PDF de NFS-e com texto: identificado para a contabilidade.
    const nfse = texto ? lerNfseTexto(texto) : null;
    if (nfse) return { id, aviso: await registrarNotaContabil(supabase, id, nfse) };
  }
  return { id };
}

/** Classifica a NFS-e e, se cair numa das categorias para a contabilidade, registra na lista. */
async function registrarNotaContabil(supabase: SupabaseClient<Database>, documentoId: string, dados: DadosNota): Promise<string | undefined> {
  const c = classificarNota(dados, SISTEMA.empresaCnpj);
  if (!c.categoria) return undefined;
  const { error } = await supabase.rpc("registrar_nota_contabil", {
    p_documento_id: documentoId,
    p_categoria: c.categoria,
    p_dados: {
      prestador_documento: dados.prestadorDocumento ?? undefined,
      prestador_nome: dados.prestadorNome ?? undefined,
      numero: dados.numero ?? undefined,
      data_emissao: dados.dataEmissao ?? undefined,
      valor: dados.valor ?? undefined,
      valor_liquido: dados.valorLiquido ?? undefined,
      retencoes: dados.retencoes,
      descricao_servico: dados.servicos.join("; ") || undefined,
    },
  });
  return error ? `Nota não incluída na lista para a contabilidade: ${mensagemErro(error)}` : undefined;
}
