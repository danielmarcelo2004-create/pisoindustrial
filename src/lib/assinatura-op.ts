import "server-only";
import { PDFDocument } from "pdf-lib";
import { embutirImagem } from "@/lib/imagem-pdf";

export type PosAssinatura = { fx: number; fy: number; fw: number };

/** Aplica a assinatura na última página do PDF, na posição escolhida na solicitação. */
export async function sobreporAssinatura(pdfBytes: Uint8Array, assinatura: Uint8Array, pos: PosAssinatura): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const pagina = doc.getPage(doc.getPageCount() - 1);
  const sig = await embutirImagem(doc, assinatura);
  const { width: pw, height: ph } = pagina.getSize();
  const w = pos.fw * pw;
  const h = w * (sig.height / sig.width);
  pagina.drawImage(sig, { x: pos.fx * pw, y: ph - pos.fy * ph - h, width: w, height: h });
  return doc.save();
}
