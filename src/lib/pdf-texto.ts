/** Texto da camada de texto de um PDF (até as primeiras páginas). Vazio quando o PDF é só imagem. */
export async function extrairTextoPdf(bytes: Buffer, maxPaginas = 5): Promise<string> {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
    let texto = "";
    for (let i = 1; i <= Math.min(doc.numPages, maxPaginas); i++) {
      const pagina = await doc.getPage(i);
      const conteudo = await pagina.getTextContent();
      // Linhas pela posição na página (o texto do PDF pode vir fora de ordem)
      texto += montarLinhas(conteudo.items.filter((it) => "str" in it) as PedacoPdf[]) + "\n";
    }
    await doc.destroy();
    return texto;
  } catch (e) {
    console.error("[pdf-texto] não foi possível ler o texto do PDF:", e);
    return "";
  }
}

/**
 * Monta as linhas de uma página de PDF pela posição de cada pedaço de texto (de cima para baixo,
 * da esquerda para a direita). Muitos emissores gravam o texto fora de ordem (por coluna ou por
 * campo); juntando na ordem do arquivo, a linha de um item da nota sai partida em vários pedaços.
 */
export type PedacoPdf = { str: string; transform: number[]; width?: number; height?: number };

export function montarLinhas(pedacos: PedacoPdf[], tolerancia = 2.5): string {
  const itens = pedacos
    .filter((p) => p.str && p.str.trim())
    .map((p) => ({ s: p.str, x: p.transform[4], y: p.transform[5], w: p.width ?? 0 }));
  // Agrupa por altura (y cresce para cima no PDF)
  itens.sort((a, b) => b.y - a.y || a.x - b.x);
  const linhas: { y: number; partes: typeof itens }[] = [];
  for (const it of itens) {
    const l = linhas.find((x) => Math.abs(x.y - it.y) <= tolerancia);
    if (l) l.partes.push(it);
    else linhas.push({ y: it.y, partes: [it] });
  }
  linhas.sort((a, b) => b.y - a.y);
  return linhas
    .map((l) =>
      l.partes
        .sort((a, b) => a.x - b.x)
        .map((p) => p.s.trim())
        .join(" "),
    )
    .join("\n");
}
