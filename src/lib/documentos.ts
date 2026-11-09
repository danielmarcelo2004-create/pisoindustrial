import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { mensagemErro } from "@/lib/erros";
import type { TipoDocumento } from "@/lib/rotulos";
import { lerNFe } from "@/lib/nfe";
import { classificarNota, lerNfseTexto, lerNfseXml, type DadosNota } from "@/lib/notas-contabeis";
import { extrairTextoPdf } from "@/lib/pdf-texto";
import { SISTEMA } from "@/lib/sistema";

export const TAMANHO_MAXIMO = 25 * 1024 * 1024;

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
  if (error) return { erro: mensagemErro(error) };
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

  // PDF de NFS-e com texto: identificado para a contabilidade.
  if (tipo === "nota_fiscal" && ext === "pdf") {
    const nfse = lerNfseTexto(await extrairTextoPdf(bytes));
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
