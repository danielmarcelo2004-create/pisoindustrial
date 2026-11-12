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

/** Texto de cada página pela camada de texto do PDF (vazio quando a página é só imagem). */
async function lerPaginasPdf(arquivo: File): Promise<string[]> {
  const pdfjs = await carregarPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await arquivo.arrayBuffer()) }).promise;
  const paginas: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const conteudo = await (await doc.getPage(i)).getTextContent();
    paginas.push(conteudo.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return paginas;
}

/**
 * Texto de cada página de um boleto: usa a camada de texto do PDF e, quando ela não existe
 * (PDF escaneado), lê as páginas com OCR (limitado a 12 páginas).
 */
export async function lerPaginasBoleto(arquivo: File): Promise<string[]> {
  const paginas = await lerPaginasPdf(arquivo);
  if (paginas.join("").trim().length >= 40) return paginas;
  const total = Math.min(paginas.length, 12);
  const worker = await criarOcr();
  try {
    const lidas: string[] = [];
    for (let i = 1; i <= total; i++) {
      const imagem = await renderizarPagina(arquivo, i, 2.5);
      lidas.push(await lerTexto(worker, imagem));
    }
    return lidas;
  } finally {
    await worker.terminate();
  }
}

/** Renderiza uma página do PDF como imagem. Para leitura (OCR) usa escala maior (~300 dpi). */
export async function renderizarPagina(arquivo: File, numero: number, escala = 2.5): Promise<string> {
  const pdfjs = await carregarPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await arquivo.arrayBuffer()) }).promise;
  const page = await doc.getPage(numero);
  const viewport = page.getViewport({ scale: escala });
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

/**
 * Lê uma página de nota em duas partes: o cabeçalho (modo padrão) e a página em faixas horizontais
 * com sobreposição (modo de linha). A tabela de produtos só sai inteira por faixa: lida de uma vez,
 * o OCR separa as colunas em linhas diferentes e perde o produto de cada linha.
 */
export async function lerPaginaNota(worker: { recognize: (img: string) => Promise<{ data: { text: string } }>; setParameters: (p: Record<string, string>) => Promise<unknown> }, imagem: string) {
  const cabecalho = await lerTexto(worker, imagem);
  const img = new Image();
  img.src = imagem;
  await img.decode();
  const FAIXAS = 8;
  const sobra = Math.round(img.height * 0.04);
  await worker.setParameters({ tessedit_pageseg_mode: "6" });
  let faixas = "";
  for (let i = 0; i < FAIXAS; i++) {
    const y0 = Math.max(0, Math.round((img.height * i) / FAIXAS) - sobra);
    const y1 = Math.min(img.height, Math.round((img.height * (i + 1)) / FAIXAS) + sobra);
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = y1 - y0;
    const ctx = canvas.getContext("2d")!;
    ctx.filter = "grayscale(100%) contrast(140%)";
    ctx.drawImage(img, 0, y0, img.width, y1 - y0, 0, 0, img.width, y1 - y0);
    faixas += "\n" + (await lerTexto(worker, canvas.toDataURL("image/png")));
  }
  await worker.setParameters({ tessedit_pageseg_mode: "3" });
  return cabecalho + faixas;
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
