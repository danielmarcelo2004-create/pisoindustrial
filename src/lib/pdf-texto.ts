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
      for (const item of conteudo.items) {
        if ("str" in item) texto += item.str + (item.hasEOL ? "\n" : " ");
      }
      texto += "\n";
    }
    await doc.destroy();
    return texto;
  } catch (e) {
    console.error("[pdf-texto] não foi possível ler o texto do PDF:", e);
    return "";
  }
}
