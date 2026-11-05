import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { cpfCnpj, data, dataHora, moeda } from "@/lib/formato";
import { FORMAS_PAGAMENTO, type FormaPagamento } from "@/lib/rotulos";
import { SISTEMA } from "@/lib/sistema";

export type ItemPdfOP = { descricao: string; unidade: string | null; quantidade: number; valorUnitario: number; total: number };

export type DadosPdfOP = {
  numero: string | null;
  rascunho: boolean;
  dataEmissao: string;
  favorecido: string;
  cpfCnpj: string | null;
  numeroNf: string | null;
  vencimento: string | null;
  formaPagamento: FormaPagamento;
  dadosBancarios: string | null;
  centroDeCusto: string;
  solicitante: string;
  emitidaEm: string;
  itens: ItemPdfOP[];
};

// Formulário em paisagem (A4), no modelo da planilha da empresa.
const L = 841.89;
const A = 595.28;
const M = 28;
const W = L - 2 * M;
const LIMITE = A - 52;

type Cor = ReturnType<typeof rgb>;
const PRETO = rgb(0, 0, 0);
const CINZA = rgb(0.35, 0.35, 0.35);
const CINZA_CLARO = rgb(0.93, 0.93, 0.93);
const AZUL = rgb(0.13, 0.36, 0.6);
const MARCA_DAGUA = rgb(0.85, 0.2, 0.2);

const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function seguro(s: string): string {
  return Array.from(s.replace(/\r?\n/g, " "))
    .map((c) => {
      const cp = c.codePointAt(0)!;
      if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.includes(c)) return c;
      if (c === "\t") return " ";
      return "?";
    })
    .join("");
}

function quebrar(texto: string, fonte: PDFFont, tamanho: number, largura: number): string[] {
  const palavras = seguro(texto).split(/\s+/).filter(Boolean);
  const linhas: string[] = [];
  let atual = "";
  for (const p of palavras) {
    const teste = atual ? `${atual} ${p}` : p;
    if (fonte.widthOfTextAtSize(teste, tamanho) <= largura) {
      atual = teste;
      continue;
    }
    if (atual) linhas.push(atual);
    let resto = p;
    while (fonte.widthOfTextAtSize(resto, tamanho) > largura && resto.length > 1) {
      let n = resto.length;
      while (n > 1 && fonte.widthOfTextAtSize(resto.slice(0, n), tamanho) > largura) n--;
      linhas.push(resto.slice(0, n));
      resto = resto.slice(n);
    }
    atual = resto;
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [""];
}

/** Gera o PDF da Ordem de Pagamento no modelo da planilha da empresa. */
export async function gerarPdfOP(d: DadosPdfOP): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Ordem de Pagamento ${d.numero ?? "(rascunho)"}`);
  pdf.setAuthor(SISTEMA.empresa);
  pdf.setCreator(SISTEMA.nome);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Logo da empresa (JPEG em public/logo-empresa.jpg). Se faltar, usa o nome da empresa.
  let logo: Awaited<ReturnType<PDFDocument["embedJpg"]>> | null = null;
  try {
    logo = await pdf.embedJpg(await readFile(path.join(process.cwd(), "public", "logo-empresa.jpg")));
  } catch {
    logo = null;
  }

  const subtotal = d.itens.reduce((s, i) => s + i.total, 0);

  // Colunas da tabela
  const colDef: { id: string; titulo: string; w: number; al: "c" | "l" | "r" }[] = [
    { id: "item", titulo: "ITEM", w: 40, al: "c" },
    { id: "nome", titulo: "NOME DO PRODUTO/SERVIÇO/MATERIAL", w: 0, al: "l" },
    { id: "centro", titulo: "CENTRO DE CUSTO", w: 170, al: "c" },
    { id: "qtd", titulo: "QUANTIDADE", w: 70, al: "c" },
    { id: "un", titulo: "UNIDADE", w: 62, al: "c" },
    { id: "vu", titulo: "VALOR UNITÁRIO", w: 98, al: "r" },
    { id: "total", titulo: "VALOR TOTAL", w: 104, al: "r" },
  ];
  const fixo = colDef.reduce((s, c) => (c.id === "nome" ? s : s + c.w), 0);
  colDef.find((c) => c.id === "nome")!.w = W - fixo;
  const col: Record<string, { x: number; w: number; al: "c" | "l" | "r" }> = {};
  let cursor = M;
  for (const c of colDef) {
    col[c.id] = { x: cursor, w: c.w, al: c.al };
    cursor += c.w;
  }

  const yOf = (top: number) => A - top;
  const texto = (p: PDFPage, t: string, x: number, top: number, o: { f?: PDFFont; s?: number; c?: Cor } = {}) =>
    p.drawText(seguro(t), { x, y: yOf(top) - (o.s ?? 9), font: o.f ?? reg, size: o.s ?? 9, color: o.c ?? PRETO });
  const textoAlin = (p: PDFPage, t: string, x0: number, x1: number, top: number, al: "c" | "l" | "r", o: { f?: PDFFont; s?: number; c?: Cor } = {}) => {
    const w = (o.f ?? reg).widthOfTextAtSize(seguro(t), o.s ?? 9);
    const x = al === "c" ? x0 + (x1 - x0 - w) / 2 : al === "r" ? x1 - w - 5 : x0 + 5;
    texto(p, t, x, top, o);
  };
  const caixa = (p: PDFPage, x: number, top: number, w: number, h: number, o: { fill?: Cor; espessura?: number } = {}) =>
    p.drawRectangle({ x, y: yOf(top) - h, width: w, height: h, borderColor: PRETO, borderWidth: o.espessura ?? 0.8, color: o.fill });
  const linhaH = (p: PDFPage, x1: number, x2: number, top: number) =>
    p.drawLine({ start: { x: x1, y: yOf(top) }, end: { x: x2, y: yOf(top) }, thickness: 0.8, color: PRETO });
  const linhaV = (p: PDFPage, x: number, t1: number, t2: number) =>
    p.drawLine({ start: { x, y: yOf(t1) }, end: { x, y: yOf(t2) }, thickness: 0.8, color: PRETO });

  const paginas: PDFPage[] = [];
  const novaPagina = () => {
    const p = pdf.addPage([L, A]);
    paginas.push(p);
    return p;
  };
  const cabecalhoTabela = (p: PDFPage, top: number) => {
    const h = 20;
    caixa(p, M, top, W, h, { fill: CINZA_CLARO });
    for (const c of colDef) {
      const cc = col[c.id];
      textoAlin(p, c.titulo, cc.x, cc.x + cc.w, top + 6, "c", { f: bold, s: 7.5 });
      if (cc.x > M) linhaV(p, cc.x, top, top + h);
    }
    return top + h;
  };

  let page = novaPagina();
  let top = M;

  // Cabeçalho: logo e CNPJ à esquerda; campos à direita
  const hTopo = 92;
  const xDir = M + 330;
  const wDirRot = 150;
  caixa(page, M, top, W, hTopo, { espessura: 1 });
  linhaV(page, xDir, top, top + hTopo);
  if (logo) {
    const lw = 220;
    const lh = (lw * logo.height) / logo.width;
    page.drawImage(logo, { x: M + 14, y: yOf(top + 14) - lh, width: lw, height: lh });
    texto(page, `CNPJ: ${SISTEMA.empresaCnpj}`, M + 14, top + hTopo - 18, { f: bold, s: 9 });
  } else {
    texto(page, SISTEMA.logoPequeno, M + 14, top + 12, { s: 9, c: CINZA });
    texto(page, SISTEMA.logoGrande, M + 14, top + 22, { f: bold, s: 22, c: AZUL });
    texto(page, `CNPJ: ${SISTEMA.empresaCnpj}`, M + 14, top + hTopo - 18, { f: bold, s: 9 });
  }

  const campos: [string, string][] = [
    ["Data:", data(d.dataEmissao)],
    ["FORNECEDOR", d.favorecido.toUpperCase()],
    ["Nº da Nota Fiscal", d.numeroNf ?? "—"],
    ["Data de vencimento", d.vencimento ? data(d.vencimento) : "—"],
    ["CONDIÇÃO DE PGTO (pix ou boleto)", FORMAS_PAGAMENTO[d.formaPagamento].toUpperCase()],
  ];
  const hLin = hTopo / campos.length;
  campos.forEach(([rot, val], i) => {
    const yy = top + i * hLin;
    if (i > 0) linhaH(page, xDir, M + W, yy);
    texto(page, rot, xDir + 6, yy + hLin / 2 - 4, { f: bold, s: 7, c: CINZA });
    const x0 = xDir + wDirRot;
    linhaV(page, x0, yy, yy + hLin);
    const largura = M + W - x0 - 10;
    let s = 9;
    let txt = seguro(val);
    while (s > 6.5 && bold.widthOfTextAtSize(txt, s) > largura) s -= 0.5;
    while (txt.length > 1 && bold.widthOfTextAtSize(txt, s) > largura) txt = txt.slice(0, -1);
    texto(page, txt, x0 + 6, yy + hLin / 2 - s / 2 - 1, { f: bold, s });
  });
  top += hTopo;

  // Título acima da tabela (faixa com a palavra ORDEM DE PAGAMENTO)
  caixa(page, M, top, W, 26, { espessura: 1 });
  textoAlin(page, "ORDEM DE PAGAMENTO", M, M + W, top + 7, "c", { f: bold, s: 14 });
  if (d.numero) textoAlin(page, d.numero, M, M + W, top + 9, "r", { f: bold, s: 8 });
  top += 26;

  // Tabela de itens
  top = cabecalhoTabela(page, top);
  d.itens.forEach((item, idx) => {
    const nomeL = quebrar(item.descricao, reg, 8.5, col.nome.w - 10);
    const centroL = quebrar(d.centroDeCusto, reg, 8, col.centro.w - 10);
    const hRow = Math.max(18, nomeL.length * 10.5 + 7, centroL.length * 10 + 8);
    if (top + hRow > LIMITE) {
      page = novaPagina();
      top = M;
      top = cabecalhoTabela(page, top);
    }
    caixa(page, M, top, W, hRow);
    for (const c of colDef) if (col[c.id].x > M) linhaV(page, col[c.id].x, top, top + hRow);
    const yc = top + (hRow - 8) / 2;
    textoAlin(page, String(idx + 1), col.item.x, col.item.x + col.item.w, yc, "c", { s: 8 });
    nomeL.forEach((l, j) => texto(page, l, col.nome.x + 5, top + 5 + j * 10.5, { s: 8.5 }));
    centroL.forEach((l, j) => textoAlin(page, l, col.centro.x, col.centro.x + col.centro.w, top + 5 + j * 10, "c", { s: 8 }));
    const celula = (id: string, t: string, al: "c" | "l" | "r") => textoAlin(page, t, col[id].x, col[id].x + col[id].w, yc, al, { s: 8 });
    celula("qtd", String(item.quantidade).replace(".", ","), "c");
    celula("un", item.unidade ?? "", "c");
    celula("vu", moeda(item.valorUnitario), "r");
    celula("total", moeda(item.total), "r");
    top += hRow;
  });

  // Total
  if (top + 22 > LIMITE) {
    page = novaPagina();
    top = M;
  }
  caixa(page, col.vu.x, top, col.vu.w, 22, { fill: CINZA_CLARO });
  caixa(page, col.total.x, top, col.total.w, 22, { fill: CINZA_CLARO });
  textoAlin(page, "Total", col.vu.x, col.vu.x + col.vu.w, top + 7, "r", { f: bold, s: 9 });
  textoAlin(page, moeda(subtotal), col.total.x, col.total.x + col.total.w, top + 6, "r", { f: bold, s: 10 });
  top += 22;

  // Bloco de pagamento e assinatura
  const linhasPag = [
    ...(d.dadosBancarios ? d.dadosBancarios.split(/\r?\n/).flatMap((l) => quebrar(l, bold, 9, 360)) : []),
    ...quebrar(`FAVORECIDO: ${d.favorecido}`, bold, 9, 360),
    ...(d.cpfCnpj ? [`CPF/CNPJ: ${cpfCnpj(d.cpfCnpj)}`] : []),
  ];
  const wPag = 420;
  const hPag = 26 + linhasPag.length * 14 + 10;
  if (top + hPag + 80 > LIMITE) {
    page = novaPagina();
    top = M;
  }
  caixa(page, M, top, wPag, hPag);
  textoAlin(page, "PAGAMENTO", M, M + wPag, top + 7, "c", { f: bold, s: 10 });
  linhasPag.forEach((l, j) => textoAlin(page, l, M, M + wPag, top + 26 + j * 14, "c", { f: bold, s: 9 }));

  const sigTop = top + Math.max(hPag, 54) + 26;
  linhaH(page, M + W * 0.5, M + W - 30, sigTop + 36);
  textoAlin(page, SISTEMA.empresa, M + W * 0.5, M + W - 30, sigTop + 42, "c", { s: 9 });
  textoAlin(
    page,
    d.rascunho ? "Rascunho: sem assinatura registrada" : `Emitida eletronicamente por ${d.solicitante} em ${dataHora(d.emitidaEm)}`,
    M + W * 0.5,
    M + W - 30,
    sigTop + 54,
    "c",
    { s: 7.5, c: CINZA },
  );

  // Rodapé e marca d'água
  const totalP = paginas.length;
  paginas.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 36 }, end: { x: L - M, y: 36 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    p.drawText(seguro(`${d.numero ?? "Rascunho"} · ${SISTEMA.nome}`), { x: M, y: 24, size: 7, font: reg, color: CINZA });
    const pg = `Página ${i + 1} de ${totalP}`;
    p.drawText(pg, { x: L - M - reg.widthOfTextAtSize(pg, 7), y: 24, size: 7, font: reg, color: CINZA });
    if (d.rascunho) {
      p.drawText("RASCUNHO", { x: 230, y: 200, size: 110, font: bold, color: MARCA_DAGUA, opacity: 0.12, rotate: degrees(20) });
    }
  });

  return pdf.save();
}
