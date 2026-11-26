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
  /** "despesa": valores em vermelho com sinal de menos (como no extrato); "receita": em verde. */
  natureza?: "despesa" | "receita" | "neutro";
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
  if (col.tipo === "moeda" && typeof c === "number") return (natureza === "despesa" && c > 0 ? "- " : "") + brl(c);
  if (col.tipo === "data" && typeof c === "string") return dataBR(c);
  return String(c);
}

const CORES_PDF: Record<CorSituacao, { fundo: [number, number, number]; texto: [number, number, number] }> = {
  verde: { fundo: [0.84, 0.97, 0.86], texto: [0.05, 0.4, 0.17] },
  vermelho: { fundo: [0.99, 0.87, 0.87], texto: [0.65, 0.1, 0.1] },
  ambar: { fundo: [1, 0.93, 0.78], texto: [0.6, 0.35, 0.02] },
  azul: { fundo: [0.86, 0.92, 0.99], texto: [0.1, 0.3, 0.6] },
  cinza: { fundo: [0.92, 0.93, 0.95], texto: [0.3, 0.33, 0.38] },
};
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
  const PAD = 4;
  const RODAPE = 30;
  const cinzaTexto = rgb(0.35, 0.38, 0.43);
  const linhaFina = rgb(0.88, 0.9, 0.93);

  let pagina!: PDFPage;
  let y = 0;

  const cabecalhoTabela = () => {
    pagina.drawRectangle({ x: M, y: y - 14, width: larguraUtil, height: 16, color: rgb(0.94, 0.96, 0.98) });
    let x = M;
    rel.colunas.forEach((c, i) => {
      const t = limpar(c.titulo);
      const w = negrito.widthOfTextAtSize(t, 7.5);
      const px = c.alinhar === "dir" ? x + larguras[i] - PAD - w : c.alinhar === "centro" ? x + (larguras[i] - w) / 2 : x + PAD;
      pagina.drawText(t, { x: px, y: y - 9, size: 7.5, font: negrito, color: rgb(0.1, 0.12, 0.16) });
      x += larguras[i];
    });
    y -= 18;
  };

  const novaPagina = (primeira: boolean) => {
    pagina = pdf.addPage([L, A]);
    y = A - M;
    if (primeira) {
      // Título e período
      pagina.drawText(limpar(rel.titulo), { x: M, y: y - 12, size: 14, font: negrito, color: rgb(0.08, 0.09, 0.12) });
      const wt = negrito.widthOfTextAtSize(limpar(rel.titulo), 14);
      pagina.drawText(limpar(rel.periodo), { x: M + wt + 8, y: y - 12, size: 9, font: fonte, color: cinzaTexto });
      // Empresa
      pagina.drawText(limpar(SISTEMA.empresa), { x: M, y: y - 46, size: 11, font: negrito, color: rgb(0.2, 0.22, 0.27) });
      pagina.drawText(`CNPJ ${SISTEMA.empresaCnpj}`, { x: M, y: y - 61, size: 8.5, font: fonte, color: cinzaTexto });
      pagina.drawText(`Emitido em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}`, { x: M, y: y - 75, size: 8, font: fonte, color: cinzaTexto });
      // Resumo
      const linhasResumo = rel.resumo ?? [];
      if (linhasResumo.length) {
        const caixaL = 230;
        const caixaA = linhasResumo.length * 14 + 14;
        const cx = L - M - caixaL;
        pagina.drawRectangle({ x: cx, y: y - caixaA + 4, width: caixaL, height: caixaA, color: rgb(0.95, 0.96, 0.98) });
        linhasResumo.forEach((r, i) => {
          const ty = y - 10 - i * 14;
          const f = r.destaque ? negrito : fonte;
          pagina.drawText(limpar(r.rotulo), { x: cx + 10, y: ty, size: 8.5, font: f, color: rgb(0.2, 0.22, 0.27) });
          const v = (r.valor < 0 ? "-" : "") + brl(Math.abs(r.valor));
          pagina.drawText(v, { x: cx + caixaL - 10 - negrito.widthOfTextAtSize(v, 8.5), y: ty, size: 8.5, font: negrito, color: rgb(0.08, 0.09, 0.12) });
        });
      }
      y -= 96;
      if (rel.filtros?.length) {
        pagina.drawText("*Há filtros aplicados. Mais detalhes na última página do relatório.", { x: M, y: y + 6, size: 7.5, font: fonte, color: cinzaTexto });
        y -= 8;
      }
    } else {
      pagina.drawText(`${limpar(rel.titulo)} · ${limpar(rel.periodo)}`, { x: M, y: y - 8, size: 9, font: negrito, color: cinzaTexto });
      y -= 22;
    }
    cabecalhoTabela();
  };

  novaPagina(true);

  for (const linha of rel.linhas) {
    // prepara as linhas de cada célula
    const prep = rel.colunas.map((c, i) => {
      const cel = linha[c.chave];
      const texto = textoDe(cel, c, rel.natureza);
      const maxLarg = larguras[i] - PAD * 2 - (c.tipo === "situacao" ? 8 : 0);
      return { texto, linhas: quebrar(texto, c.tipo === "moeda" ? negrito : fonte, TAM, maxLarg, 3), cel };
    });
    const nLinhas = Math.max(1, ...prep.map((p) => p.linhas.length));
    const altura = nLinhas * ALT_LINHA + 7;
    if (y - altura < RODAPE + 10) novaPagina(false);

    let x = M;
    rel.colunas.forEach((c, i) => {
      const p = prep[i];
      if (c.tipo === "situacao" && ehSelo(p.cel as Celula)) {
        const selo = p.cel as Selo;
        const cores = CORES_PDF[selo.cor];
        const w = larguras[i] - PAD * 2;
        pagina.drawRectangle({ x: x + PAD, y: y - 11, width: w, height: 11, color: rgb(...cores.fundo) });
        const t = limpar(p.linhas[0] ?? "");
        const tw = negrito.widthOfTextAtSize(t, 7);
        pagina.drawText(t, { x: x + PAD + (w - tw) / 2, y: y - 8.5, size: 7, font: negrito, color: rgb(...cores.texto) });
      } else {
        const usaNegrito = c.tipo === "moeda";
        let cor = rgb(0.2, 0.22, 0.27);
        if (c.tipo === "moeda") {
          if (rel.natureza === "despesa") cor = rgb(0.75, 0.15, 0.15);
          else if (rel.natureza === "receita") cor = rgb(0.05, 0.45, 0.2);
        }
        p.linhas.forEach((t, k) => {
          const f = usaNegrito ? negrito : fonte;
          const w = f.widthOfTextAtSize(t, TAM);
          const px = c.alinhar === "dir" || c.tipo === "moeda" ? x + larguras[i] - PAD - w : c.alinhar === "centro" ? x + (larguras[i] - w) / 2 : x + PAD;
          pagina.drawText(t, { x: px, y: y - 8 - k * ALT_LINHA, size: TAM, font: f, color: cor });
        });
      }
      x += larguras[i];
    });
    y -= altura;
    pagina.drawLine({ start: { x: M, y: y + 2 }, end: { x: L - M, y: y + 2 }, thickness: 0.4, color: linhaFina });
  }

  if (!rel.linhas.length) {
    pagina.drawText("Nenhum lançamento com esses filtros.", { x: M + PAD, y: y - 10, size: 9, font: fonte, color: cinzaTexto });
    y -= 24;
  }

  // Última página: filtros aplicados
  if (rel.filtros?.length) {
    if (y < RODAPE + 40 + rel.filtros.length * 12) novaPagina(false);
    y -= 16;
    pagina.drawText("Filtros aplicados", { x: M, y: y - 6, size: 9, font: negrito, color: rgb(0.2, 0.22, 0.27) });
    y -= 20;
    for (const f of rel.filtros) {
      pagina.drawText(`• ${limpar(f)}`, { x: M + 6, y: y - 6, size: 8, font: fonte, color: cinzaTexto });
      y -= 12;
    }
  }

  // Rodapé em todas as páginas
  const paginas = pdf.getPages();
  paginas.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 26 }, end: { x: L - M, y: 26 }, thickness: 0.4, color: linhaFina });
    p.drawText(`Usuário: ${limpar(rel.usuario)}`, { x: M, y: 14, size: 7.5, font: fonte, color: cinzaTexto });
    const centro = limpar(SISTEMA.nome);
    p.drawText(centro, { x: (L - negrito.widthOfTextAtSize(centro, 8)) / 2, y: 14, size: 8, font: negrito, color: rgb(0.25, 0.3, 0.4) });
    const pg = `Página ${i + 1} de ${paginas.length}`;
    p.drawText(pg, { x: L - M - fonte.widthOfTextAtSize(pg, 7.5), y: 14, size: 7.5, font: fonte, color: cinzaTexto });
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

    ws.getCell(1, 1).value = rel.titulo;
    ws.getCell(1, 1).font = { bold: true, size: 15, color: { argb: "FF14213D" } };
    meio(1);
    ws.getCell(2, 1).value = rel.periodo;
    ws.getCell(2, 1).font = { size: 10, color: { argb: "FF5A6270" } };
    meio(2);
    ws.getCell(3, 1).value = `${SISTEMA.empresa} · CNPJ ${SISTEMA.empresaCnpj}`;
    ws.getCell(3, 1).font = { size: 10, bold: true, color: { argb: "FF333B4A" } };
    meio(3);
    ws.getCell(4, 1).value = `Emitido em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })} por ${rel.usuario}`;
    ws.getCell(4, 1).font = { size: 9, color: { argb: "FF7A8290" } };
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
        cel.border = { bottom: { style: "hair", color: { argb: "FFD0D5DD" } } };
        cel.alignment = { vertical: "top", wrapText: c.tipo === "texto" || c.tipo === undefined };
        if (v === null || v === undefined || v === "") return;
        if (ehSelo(v)) {
          cel.value = v.texto;
          cel.font = { size: 9, bold: true, color: { argb: CORES_XLSX[v.cor].texto } };
          cel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CORES_XLSX[v.cor].fundo } };
          cel.alignment = { horizontal: "center", vertical: "top" };
        } else if (c.tipo === "moeda" && typeof v === "number") {
          cel.value = v;
          cel.numFmt = '"R$" #,##0.00';
          cel.alignment = { horizontal: "right", vertical: "top" };
          if (rel.natureza === "despesa") cel.font = { size: 10, color: { argb: "FFB42323" } };
          else if (rel.natureza === "receita") cel.font = { size: 10, color: { argb: "FF0D7333" } };
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
