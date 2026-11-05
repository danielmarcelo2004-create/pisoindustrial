"use client";

// Leitura de comprovantes de pagamento em lote, rodando no navegador.
// Cada página do PDF vira imagem, passa pelo OCR (português) e é separada em
// um PDF próprio. O casamento com o pagamento é feito pelo valor e pelo CNPJ.

export const CNPJ_EMPRESA = "04.602.232/0001-70";

export type CampoComprovante = { valor: number | null; cnpj: string | null; texto: string };

/** Extrai valor cobrado e CNPJ do beneficiário do texto lido de uma página. */
export function extrairCampos(texto: string): CampoComprovante {
  const limpo = texto.replace(/\s+/g, " ");
  const v = limpo.match(/VALOR\s+COBRADO\D{0,6}([\d.]+,\d{2})/i) ?? limpo.match(/VALOR\s+DO\s+DOCUMENTO\D{0,6}([\d.]+,\d{2})/i);
  const valor = v ? Number(v[1].replace(/\./g, "").replace(",", ".")) : null;
  const cnpjs = [...limpo.matchAll(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g)].map((m) => m[0]).filter((c) => c !== CNPJ_EMPRESA);
  return { valor, cnpj: cnpjs[0] ?? null, texto };
}

async function carregarPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  return pdfjs;
}

/** Quantidade de páginas do PDF. */
export async function contarPaginas(arquivo: File): Promise<number> {
  const pdfjs = await carregarPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await arquivo.arrayBuffer()) }).promise;
  return doc.numPages;
}

/** Renderiza uma página para imagem (PNG em data URL) com resolução boa para OCR. */
export async function renderizarPagina(arquivo: File, numero: number): Promise<string> {
  const pdfjs = await carregarPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await arquivo.arrayBuffer()) }).promise;
  const page = await doc.getPage(numero);
  const viewport = page.getViewport({ scale: 2.5 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL("image/png");
}

/** Lê o texto de uma imagem com o OCR em português. */
export async function lerTexto(worker: { recognize: (img: string) => Promise<{ data: { text: string } }> }, imagem: string) {
  const { data } = await worker.recognize(imagem);
  return data.text;
}

export async function criarOcr() {
  const { createWorker } = await import("tesseract.js");
  return createWorker("por", 1, {
    workerPath: "/ocr/worker.min.js",
    corePath: "/ocr/core/",
    langPath: "/ocr/lang/",
    gzip: true,
    cacheMethod: "none",
  });
}

/** Cria um PDF só com a página indicada (sem alterar o original). */
export async function extrairPagina(arquivo: File, numero: number, nome: string): Promise<File> {
  const { PDFDocument } = await import("pdf-lib");
  const origem = await PDFDocument.load(await arquivo.arrayBuffer());
  const novo = await PDFDocument.create();
  const [pagina] = await novo.copyPages(origem, [numero - 1]);
  novo.addPage(pagina);
  const bytes = await novo.save();
  return new File([new Uint8Array(bytes)], nome, { type: "application/pdf" });
}
