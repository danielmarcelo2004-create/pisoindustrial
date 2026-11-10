import type { PDFDocument, PDFImage } from "pdf-lib";

/** Formato real da imagem, pelos primeiros bytes (o nome e o tipo informado podem estar errados). */
export function formatoImagem(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/** Incorpora a imagem no PDF no formato em que ela realmente está. */
export async function embutirImagem(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  const formato = formatoImagem(bytes);
  if (formato === "png") return doc.embedPng(bytes);
  if (formato === "jpeg") return doc.embedJpg(bytes);
  throw new Error("o arquivo não é uma imagem PNG ou JPG válida");
}
