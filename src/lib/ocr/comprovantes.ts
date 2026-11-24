"use client";

// Leitura de PDFs no navegador: camada de texto do PDF ou OCR (português) quando a página é imagem.
// A interpretação dos comprovantes e o casamento com os pagamentos ficam em @/lib/comprovantes-banco.
import { montarLinhas, type PedacoPdf } from "@/lib/pdf-texto";

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

/** Texto do PDF com as linhas montadas pela posição na página (para notas fiscais: o emissor pode gravar fora de ordem). */
export async function textoPdfPorPosicao(arquivo: File): Promise<string> {
  const pdfjs = await carregarPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await arquivo.arrayBuffer()) }).promise;
  let texto = "";
  for (let i = 1; i <= Math.min(doc.numPages, 5); i++) {
    texto += montarLinhas((await (await doc.getPage(i)).getTextContent()).items.filter((it) => "str" in it) as PedacoPdf[]) + "\n";
  }
  return texto;
}

/** Texto de cada página pela camada de texto do PDF (vazio quando a página é só imagem). */
async function lerPaginasPdf(arquivo: File): Promise<string[]> {
  const pdfjs = await carregarPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await arquivo.arrayBuffer()) }).promise;
  const paginas: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const conteudo = await (await doc.getPage(i)).getTextContent();
    // Mantém as quebras de linha (mudança de altura do texto ou fim de linha marcado pelo PDF).
    let texto = "";
    let ultimoY: number | null = null;
    for (const it of conteudo.items) {
      if (!("str" in it)) continue;
      const y = it.transform[5];
      if (ultimoY !== null && Math.abs(y - ultimoY) > 2) texto += "\n";
      else if (texto && !texto.endsWith("\n")) texto += " ";
      texto += it.str;
      if (it.hasEOL) texto += "\n";
      ultimoY = y;
    }
    paginas.push(texto);
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

type Ocr = { recognize: (img: string) => Promise<{ data: { text: string } }> };

/**
 * Texto de cada página: camada de texto do PDF quando existe; senão, OCR da página.
 * O OCR só é criado se alguma página precisar (obterOcr recebe a página atual e o total, para mostrar o progresso).
 */
export async function lerTextoPaginas(arquivo: File, obterOcr: (pagina: number, total: number) => Promise<Ocr>): Promise<string[]> {
  const paginas = await lerPaginasPdf(arquivo);
  const textos: string[] = [];
  for (let i = 0; i < paginas.length; i++) {
    if (paginas[i].replace(/\s/g, "").length >= 40) {
      textos.push(paginas[i]);
      continue;
    }
    const ocr = await obterOcr(i + 1, paginas.length);
    textos.push(await lerTexto(ocr, await renderizarPagina(arquivo, i + 1)));
  }
  return textos;
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
