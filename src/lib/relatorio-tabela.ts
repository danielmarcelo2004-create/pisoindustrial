import "server-only";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { SISTEMA } from "@/lib/sistema";

// Relatório em tabela (Contas a pagar, Contas a receber, Relatórios): o mesmo conteúdo sai em Excel organizado ou em PDF
// pronto para imprimir (A4 paisagem: cabeçalho com a empresa, resumo, tabela, situação colorida e rodapé com página).

export type CorSituacao = "verde" | "vermelho" | "ambar" | "azul" | "cinza";
/** Célula de situação: texto + cor do selo. */
export type Selo = { texto: string; cor: CorSituacao };
export type Celula = string | number | null | undefined | Selo;

export type ColunaRel = {
  titulo: string;
  chave: string;
  /** Largura relativa (as colunas dividem a largura da página proporcionalmente). */
  largura: number;
  tipo?: "texto" | "data" | "moeda" | "numero" | "situacao";
  alinhar?: "esq" | "dir" | "centro";
};

export type RelatorioTabela = {
  titulo: string;
  /** Texto ao lado do título (ex.: "Todo o período", "Novembro de 2026"). */
  periodo: string;
  /** Resumo no canto superior direito (ex.: Despesas em aberto). */
  resumo?: { rotulo: string; valor: number; destaque?: boolean }[];
  /** Uma linha por filtro aplicado (aparecem na última página e na planilha). */
  filtros?: string[];
  colunas: ColunaRel[];
  linhas: Record<string, Celula>[];
  /** Nome de quem emitiu (rodapé). */
  usuario: string;
  /** "despesa": valores positivos mostrados com sinal de menos; "misto" (extrato): o sinal vem do próprio valor (receita +, despesa −). */
  natureza?: "despesa" | "receita" | "neutro" | "misto";
  /** Soma a coluna de valor no fim da tabela (Excel) quando existir uma coluna "moeda". */
  totalizar?: boolean;
  /** Nome da aba no Excel. */
  aba?: string;
};

const ehSelo = (c: Celula): c is Selo => typeof c === "object" && c !== null;
const brl = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBR = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);

/** Texto de uma célula para exibição (PDF). */
function textoDe(c: Celula, col: ColunaRel, natureza: RelatorioTabela["natureza"]): string {
  if (c === null || c === undefined || c === "") return "";
  if (ehSelo(c)) return c.texto;
  if (col.tipo === "moeda" && typeof c === "number") return (natureza === "despesa" && c > 0 ? "- " : c < 0 ? "- " : "") + brl(Math.abs(c));
  if (col.tipo === "data" && typeof c === "string") return dataBR(c);
  return String(c);
}

const CORES_XLSX: Record<CorSituacao, { fundo: string; texto: string }> = {
  verde: { fundo: "FFD6F7DC", texto: "FF0D6B2B" },
  vermelho: { fundo: "FFFCDDDD", texto: "FFA61A1A" },
  ambar: { fundo: "FFFFEDC7", texto: "FF995A05" },
  azul: { fundo: "FFDBEAFC", texto: "FF1A4D99" },
  cinza: { fundo: "FFEBEDF1", texto: "FF4D5461" },
};

/** Remove o que a fonte padrão do PDF não desenha (emojis, símbolos) e quebras de linha. */
function limpar(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E -ÿ–—‘’“”•…€]/g, "")
    .trim();
}

function quebrar(texto: string, fonte: PDFFont, tamanho: number, larg: number, maxLinhas: number): string[] {
  const palavras = limpar(texto).split(" ").filter(Boolean);
  const linhas: string[] = [];
  let atual = "";
  const cabe = (s: string) => fonte.widthOfTextAtSize(s, tamanho) <= larg;
  for (let p of palavras) {
    // palavra maior que a coluna: corta
    while (!cabe(p) && p.length > 1) {
      let corte = p.length - 1;
      while (corte > 1 && !cabe(p.slice(0, corte))) corte--;
      if (atual) {
        linhas.push(atual);
        atual = "";
      }
      linhas.push(p.slice(0, corte));
      p = p.slice(corte);
    }
    const tentativa = atual ? `${atual} ${p}` : p;
    if (cabe(tentativa)) atual = tentativa;
    else {
      linhas.push(atual);
      atual = p;
    }
  }
  if (atual) linhas.push(atual);
  if (linhas.length > maxLinhas) {
    const cortadas = linhas.slice(0, maxLinhas);
    let ultima = cortadas[maxLinhas - 1];
    while (ultima.length > 1 && !cabe(ultima + "…")) ultima = ultima.slice(0, -1);
    cortadas[maxLinhas - 1] = ultima + "…";
    return cortadas;
  }
  return linhas.length ? linhas : [""];
}

// Identidade visual dos relatórios: faixa azul-marinho no topo, resumo em cartões, linhas alternadas e situação com marcador.
const MARINHO = rgb(0.12, 0.23, 0.35);
const MARINHO_CLARO = rgb(0.9, 0.93, 0.97);
const ZEBRA = rgb(0.965, 0.972, 0.985);
const TEXTO = rgb(0.13, 0.16, 0.21);
const TEXTO_FRACO = rgb(0.42, 0.46, 0.52);
const COR_MARCADOR: Record<CorSituacao, [number, number, number]> = {
  verde: [0.1, 0.6, 0.3],
  vermelho: [0.8, 0.2, 0.2],
  ambar: [0.88, 0.58, 0.05],
  azul: [0.2, 0.45, 0.8],
  cinza: [0.55, 0.58, 0.63],
};

export async function gerarPdfRelatorio(rel: RelatorioTabela): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${rel.titulo} ${rel.periodo}`);
  pdf.setCreator(SISTEMA.nome);
  const fonte = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);
  const L = 841.89;
  const A = 595.28;
  const M = 28;
  const larguraUtil = L - M * 2;
  const totalPeso = rel.colunas.reduce((s, c) => s + c.largura, 0);
  const larguras = rel.colunas.map((c) => (c.largura / totalPeso) * larguraUtil);
  const TAM = 7;
  const ALT_LINHA = 9;
  const PAD = 5;
  const RODAPE = 34;

  let pagina!: PDFPage;
  let y = 0;
  let zebra = false;

  const cabecalhoTabela = () => {
    pagina.drawRectangle({ x: M, y: y - 15, width: larguraUtil, height: 17, color: MARINHO });
    let x = M;
    rel.colunas.forEach((c, i) => {
      const t = limpar(c.titulo).toUpperCase();
      const w = negrito.widthOfTextAtSize(t, 6.8);
      const px = c.alinhar === "dir" || c.tipo === "moeda" ? x + larguras[i] - PAD - w : c.alinhar === "centro" ? x + (larguras[i] - w) / 2 : x + PAD;
      pagina.drawText(t, { x: px, y: y - 9.5, size: 6.8, font: negrito, color: rgb(1, 1, 1) });
      x += larguras[i];
    });
    y -= 19;
    zebra = false;
  };

  const novaPagina = (primeira: boolean) => {
    pagina = pdf.addPage([L, A]);
    y = A;
    if (primeira) {
      // Faixa do topo: título e período à esquerda, empresa à direita
      pagina.drawRectangle({ x: 0, y: A - 70, width: L, height: 70, color: MARINHO });
      pagina.drawText(limpar(rel.titulo), { x: M, y: A - 34, size: 18, font: negrito, color: rgb(1, 1, 1) });
      pagina.drawText(limpar(rel.periodo), { x: M, y: A - 52, size: 9.5, font: fonte, color: rgb(0.78, 0.85, 0.93) });
      const emp = limpar(SISTEMA.empresa);
      const cnpj = `CNPJ ${SISTEMA.empresaCnpj}`;
      pagina.drawText(emp, { x: L - M - negrito.widthOfTextAtSize(emp, 9), y: A - 34, size: 9, font: negrito, color: rgb(1, 1, 1) });
      pagina.drawText(cnpj, { x: L - M - fonte.widthOfTextAtSize(cnpj, 8), y: A - 48, size: 8, font: fonte, color: rgb(0.78, 0.85, 0.93) });
      y = A - 70 - 14;
      // Resumo em cartões lado a lado
      const itens = rel.resumo ?? [];
      if (itens.length) {
        const gap = 8;
        const w = (larguraUtil - gap * (itens.length - 1)) / itens.length;
        itens.forEach((r, i) => {
          const cx = M + i * (w + gap);
          pagina.drawRectangle({ x: cx, y: y - 38, width: w, height: 38, color: r.destaque ? MARINHO_CLARO : rgb(1, 1, 1), borderColor: rgb(0.84, 0.87, 0.92), borderWidth: 0.7 });
          pagina.drawRectangle({ x: cx, y: y - 38, width: 3, height: 38, color: r.destaque ? MARINHO : rgb(0.65, 0.72, 0.82) });
          pagina.drawText(limpar(r.rotulo).toUpperCase(), { x: cx + 10, y: y - 13, size: 6.3, font: negrito, color: TEXTO_FRACO });
          const v = (r.valor < 0 ? "-" : "") + brl(Math.abs(r.valor));
          pagina.drawText(v, { x: cx + 10, y: y - 30, size: 12, font: negrito, color: r.destaque ? MARINHO : TEXTO });
        });
        y -= 38 + 10;
      }
      if (rel.filtros?.length) {
        pagina.drawText("Há filtros aplicados; veja os detalhes na última página.", { x: M, y: y - 6, size: 7.2, font: fonte, color: TEXTO_FRACO });
        y -= 14;
      } else {
        y -= 4;
      }
    } else {
      pagina.drawRectangle({ x: 0, y: A - 26, width: L, height: 26, color: MARINHO });
      pagina.drawText(`${limpar(rel.titulo)}  ·  ${limpar(rel.periodo)}`, { x: M, y: A - 17, size: 9, font: negrito, color: rgb(1, 1, 1) });
      y = A - 26 - 12;
    }
    cabecalhoTabela();
  };

  novaPagina(true);

  for (const linha of rel.linhas) {
    const prep = rel.colunas.map((c, i) => {
      const cel = linha[c.chave];
      const texto = textoDe(cel, c, rel.natureza);
      const maxLarg = larguras[i] - PAD * 2 - (c.tipo === "situacao" ? 10 : 0);
      return { texto, linhas: quebrar(texto, c.tipo === "moeda" || c.tipo === "situacao" ? negrito : fonte, TAM, maxLarg, c.tipo === "situacao" ? 2 : 3), cel };
    });
    const nLinhas = Math.max(1, ...prep.map((p) => p.linhas.length));
    const altura = nLinhas * ALT_LINHA + 8;
    if (y - altura < RODAPE + 8) novaPagina(false);

    if (zebra) pagina.drawRectangle({ x: M, y: y - altura + 3, width: larguraUtil, height: altura, color: ZEBRA });
    zebra = !zebra;

    let x = M;
    rel.colunas.forEach((c, i) => {
      const p = prep[i];
      if (c.tipo === "situacao" && ehSelo(p.cel as Celula)) {
        // marcador colorido + texto da situação
        const selo = p.cel as Selo;
        const cor = COR_MARCADOR[selo.cor];
        pagina.drawCircle({ x: x + PAD + 3, y: y - 5, size: 2.6, color: rgb(...cor) });
        // situação com nome longo (ex.: "Liberado p/ pagamento") quebra em até 2 linhas
        const partes = quebrar(selo.texto, negrito, TAM, larguras[i] - PAD * 2 - 10, 2);
        partes.forEach((t, k) => pagina.drawText(t, { x: x + PAD + 10, y: y - 7.6 - k * ALT_LINHA, size: TAM, font: negrito, color: rgb(cor[0] * 0.8, cor[1] * 0.8, cor[2] * 0.8) }));
      } else {
        const ehValor = c.tipo === "moeda";
        const f = ehValor ? negrito : fonte;
        p.linhas.forEach((t, k) => {
          const w = f.widthOfTextAtSize(t, TAM);
          const px = ehValor || c.alinhar === "dir" ? x + larguras[i] - PAD - w : c.alinhar === "centro" ? x + (larguras[i] - w) / 2 : x + PAD;
          pagina.drawText(t, { x: px, y: y - 7.6 - k * ALT_LINHA, size: TAM, font: f, color: TEXTO });
        });
      }
      x += larguras[i];
    });
    y -= altura;
  }

  if (!rel.linhas.length) {
    pagina.drawText("Nenhum lançamento com esses filtros.", { x: M + PAD, y: y - 10, size: 9, font: fonte, color: TEXTO_FRACO });
    y -= 24;
  }
  pagina.drawLine({ start: { x: M, y: y + 1 }, end: { x: L - M, y: y + 1 }, thickness: 0.8, color: MARINHO });

  // Última página: filtros aplicados em uma caixa
  if (rel.filtros?.length) {
    const altCaixa = 26 + rel.filtros.length * 12;
    if (y < RODAPE + altCaixa + 20) novaPagina(false);
    y -= 18;
    pagina.drawRectangle({ x: M, y: y - altCaixa, width: larguraUtil, height: altCaixa, color: rgb(0.975, 0.98, 0.99), borderColor: rgb(0.84, 0.87, 0.92), borderWidth: 0.7 });
    pagina.drawText("FILTROS APLICADOS", { x: M + 10, y: y - 15, size: 7, font: negrito, color: MARINHO });
    rel.filtros.forEach((f, k) => pagina.drawText(`•  ${limpar(f)}`, { x: M + 10, y: y - 29 - k * 12, size: 8, font: fonte, color: TEXTO }));
  }

  // Rodapé em todas as páginas: emitido por, sistema e paginação em destaque
  const paginas = pdf.getPages();
  const emitido = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
  paginas.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 28 }, end: { x: L - M, y: 28 }, thickness: 0.5, color: rgb(0.84, 0.87, 0.92) });
    p.drawText(`${limpar(SISTEMA.nome)}  ·  emitido por ${limpar(rel.usuario)} em ${emitido}`, { x: M, y: 15, size: 7.2, font: fonte, color: TEXTO_FRACO });
    const pg = `Página ${i + 1} de ${paginas.length}`;
    const w = negrito.widthOfTextAtSize(pg, 7.5) + 14;
    p.drawRectangle({ x: L - M - w, y: 10, width: w, height: 14, color: MARINHO_CLARO });
    p.drawText(pg, { x: L - M - w + 7, y: 14.2, size: 7.5, font: negrito, color: MARINHO });
  });

  return pdf.save();
}

/** Excel organizado: título, empresa, resumo, filtros, tabela com cabeçalho fixo, situação colorida e total. Uma aba por relatório. */
export async function gerarExcelRelatorio(relatorios: RelatorioTabela[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = SISTEMA.nome;
  wb.created = new Date();
  relatorios.forEach((rel, idx) => {
    const nome = (rel.aba ?? rel.titulo).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Aba ${idx + 1}`;
    const ws = wb.addWorksheet(nome, { pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    const n = rel.colunas.length;
    ws.columns = rel.colunas.map((c) => ({ width: Math.max(c.tipo === "situacao" ? 20 : 8, Math.round(c.largura * 1.7)) }));
    const meio = (linha: number) => ws.mergeCells(linha, 1, linha, Math.max(n, 2));

    // Faixa azul-marinho no topo (título, período e empresa)
    const faixa = (linha: number) => {
      for (let c = 1; c <= Math.max(n, 2); c++) ws.getCell(linha, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5A" } };
    };
    [1, 2, 3].forEach(faixa);
    ws.getRow(1).height = 26;
    ws.getCell(1, 1).value = rel.titulo;
    ws.getCell(1, 1).font = { bold: true, size: 17, color: { argb: "FFFFFFFF" } };
    ws.getCell(1, 1).alignment = { vertical: "middle", indent: 1 };
    meio(1);
    ws.getCell(2, 1).value = rel.periodo;
    ws.getCell(2, 1).font = { size: 10, color: { argb: "FFC7D9EE" } };
    ws.getCell(2, 1).alignment = { indent: 1 };
    meio(2);
    ws.getCell(3, 1).value = `${SISTEMA.empresa}  ·  CNPJ ${SISTEMA.empresaCnpj}`;
    ws.getCell(3, 1).font = { size: 9, bold: true, color: { argb: "FFFFFFFF" } };
    ws.getCell(3, 1).alignment = { indent: 1 };
    meio(3);
    ws.getCell(4, 1).value = `Emitido por ${rel.usuario} em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}`;
    ws.getCell(4, 1).font = { size: 9, italic: true, color: { argb: "FF7A8290" } };
    ws.getCell(4, 1).alignment = { indent: 1 };
    meio(4);

    let l = 6;
    for (const r of rel.resumo ?? []) {
      const rot = ws.getCell(l, 1);
      rot.value = r.rotulo;
      rot.font = { size: 10, bold: !!r.destaque };
      ws.mergeCells(l, 1, l, Math.min(2, n));
      const v = ws.getCell(l, Math.min(3, n));
      v.value = r.valor;
      v.numFmt = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
      v.font = { size: 10, bold: true };
      v.alignment = { horizontal: "right" };
      for (let c = 1; c <= Math.min(3, n); c++) ws.getCell(l, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F4F8" } };
      l++;
    }
    if (rel.filtros?.length) {
      l++;
      ws.getCell(l, 1).value = `Filtros aplicados: ${rel.filtros.join(" · ")}`;
      ws.getCell(l, 1).font = { size: 9, italic: true, color: { argb: "FF7A8290" } };
      ws.getCell(l, 1).alignment = { wrapText: true, vertical: "top" };
      meio(l);
      ws.getRow(l).height = Math.min(60, 14 * Math.ceil((rel.filtros.join(" · ").length + 20) / Math.max(60, n * 14)));
      l++;
    }
    l++;

    const cab = l;
    rel.colunas.forEach((c, i) => {
      const cel = ws.getCell(cab, i + 1);
      cel.value = c.titulo;
      cel.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5A" } };
      cel.alignment = { vertical: "middle", horizontal: c.tipo === "moeda" || c.tipo === "numero" ? "right" : c.tipo === "situacao" || c.tipo === "data" ? "center" : "left", wrapText: true };
    });
    ws.getRow(cab).height = 22;

    let r0 = cab + 1;
    for (const linha of rel.linhas) {
      rel.colunas.forEach((c, i) => {
        const cel = ws.getCell(r0, i + 1);
        const v = linha[c.chave];
        cel.font = { size: 10 };
        if ((r0 - cab) % 2 === 0) cel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F7FB" } };
        cel.alignment = { vertical: "top", wrapText: c.tipo === "texto" || c.tipo === undefined };
        if (v === null || v === undefined || v === "") return;
        if (ehSelo(v)) {
          cel.value = `● ${v.texto}`;
          cel.font = { size: 10, bold: true, color: { argb: CORES_XLSX[v.cor].texto } };
          cel.alignment = { horizontal: "left", vertical: "top" };
        } else if (c.tipo === "moeda" && typeof v === "number") {
          cel.value = v;
          cel.numFmt = rel.natureza === "misto" ? '"R$" #,##0.00;[Red]-"R$" #,##0.00' : '"R$" #,##0.00';
          cel.alignment = { horizontal: "right", vertical: "top" };
          cel.font = { size: 10, bold: true };
        } else if (c.tipo === "numero" && typeof v === "number") {
          cel.value = v;
          cel.numFmt = "#,##0.###";
          cel.alignment = { horizontal: c.alinhar === "centro" ? "center" : "right", vertical: "top" };
        } else if (c.tipo === "data" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
          cel.value = new Date(v.slice(0, 10) + "T12:00:00Z");
          cel.numFmt = "dd/mm/yyyy";
          cel.alignment = { horizontal: "center", vertical: "top" };
        } else {
          // texto: evita que o Excel trate "=..." como fórmula
          const s = String(v);
          cel.value = /^[=+\-@]/.test(s) ? "'" + s : s;
        }
      });
      r0++;
    }

    // Total da coluna de valor
    const iValor = rel.colunas.findIndex((c) => c.tipo === "moeda");
    if (rel.totalizar && iValor >= 0 && rel.linhas.length) {
      const colLetra = ws.getColumn(iValor + 1).letter;
      for (let c = 1; c <= n; c++) {
        const cel = ws.getCell(r0, c);
        cel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1F6" } };
        cel.font = { bold: true, size: 10 };
        cel.border = { top: { style: "thin", color: { argb: "FF8A93A3" } } };
      }
      ws.getCell(r0, 1).value = "Total";
      const tot = ws.getCell(r0, iValor + 1);
      tot.value = { formula: `SUBTOTAL(109,${colLetra}${cab + 1}:${colLetra}${r0 - 1})`, result: rel.linhas.reduce((s, x) => s + (typeof x[rel.colunas[iValor].chave] === "number" ? (x[rel.colunas[iValor].chave] as number) : 0), 0) };
      tot.numFmt = '"R$" #,##0.00';
      tot.alignment = { horizontal: "right" };
    }

    ws.views = [{ state: "frozen", ySplit: cab, showGridLines: false }];
    if (rel.linhas.length) ws.autoFilter = { from: { row: cab, column: 1 }, to: { row: cab, column: n } };
    ws.pageSetup.printTitlesRow = `${cab}:${cab}`;
    ws.headerFooter.oddFooter = `&LUsuário: ${rel.usuario.replace(/&/g, "")}&C${SISTEMA.nome}&RPágina &P de &N`;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function respostaPdf(bytes: Uint8Array, nome: string) {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      // inline: abre no navegador, pronto para imprimir
      "Content-Disposition": `inline; filename="${nome}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function respostaXlsx(buf: Buffer, nome: string) {
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
    },
  });
}
