import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { cpfCnpj, data, moeda } from "@/lib/formato";
import { FORMAS_PAGAMENTO, type FormaPagamento } from "@/lib/rotulos";
import { SISTEMA } from "@/lib/sistema";

export type ItemPdfOP = { descricao: string; unidade: string | null; quantidade: number; valorUnitario: number; total: number };
export type ParcelaPdfOP = { numero: number; valor: number; vencimento: string };

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
  parcelas?: ParcelaPdfOP[];
};

// Mesma grade da planilha modelo (formulário em paisagem, carta). Medidas em pontos do PDF,
// tiradas do próprio modelo (colunas, linhas, cores e bordas). As fontes seguem o tamanho do modelo.
const PAGINA_L = 792;
const PAGINA_A = 612;
const X = [18.0, 50.2, 214.2, 369.2, 446.7, 523.7, 593.8, 765.2]; // limites das colunas A..H
const ALTURAS_MODELO = [36, 17.25, 17.25, 17.25, 51.75, 20.25, 53.25, 19.5, 26.45, 76.5, 59.25, 15, 16.5, 16.5, 16.5, 15.75, 15.75];
const ESCALA = 0.4888;
const Y0 = 53.9;
const topo = (linha: number) => Y0 + ALTURAS_MODELO.slice(0, linha - 1).reduce((s, h) => s + h * ESCALA, 0); // linha 1-based
const altura = (linha: number) => ALTURAS_MODELO[linha - 1] * ESCALA;
const ALTURA_ITEM = altura(7);

const PRETO = rgb(0, 0, 0);
const BRANCO = rgb(1, 1, 1);
const CINZA_CLARO = rgb(0.949, 0.949, 0.949);
const AZUL_CLARO = rgb(0.588, 0.863, 0.973);
const VERDE = rgb(0.573, 0.816, 0.314);
const CREME = rgb(0.969, 0.953, 0.874);
const VERMELHO = rgb(1, 0, 0);

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

/** Gera o PDF da Ordem de Pagamento com a mesma grade da planilha modelo da empresa. */
export async function gerarPdfOP(d: DadosPdfOP): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Ordem de Pagamento ${d.numero ?? "(rascunho)"}`);
  pdf.setAuthor(SISTEMA.empresa);
  pdf.setCreator(SISTEMA.nome);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const boldOblique = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);

  // Logo do modelo (PNG da própria planilha)
  let logo: PDFImage | null = null;
  try {
    logo = await pdf.embedPng(await readFile(path.join(process.cwd(), "public", "op", "logo-modelo-op.png")));
  } catch {
    logo = null;
  }

  const subtotal = d.itens.reduce((s, i) => s + i.total, 0);

  const novaPagina = (): PDFPage => pdf.addPage([PAGINA_L, PAGINA_A]);
  const yOf = (t: number) => PAGINA_A - t;

  // Desenha texto com a linha de base no centro vertical do intervalo [t0, t1]
  const textoCelula = (
    p: PDFPage,
    t: string,
    x0: number,
    x1: number,
    t0: number,
    t1: number,
    al: "c" | "l" | "r",
    o: { f?: PDFFont; s: number; c?: ReturnType<typeof rgb>; pad?: number } = { s: 6 },
  ) => {
    const f = o.f ?? reg;
    const pad = o.pad ?? 4;
    const linhas = quebrar(t, f, o.s, x1 - x0 - pad * 2);
    const altLinha = o.s * 1.2;
    const bloco = linhas.length * altLinha;
    let y = yOf((t0 + t1) / 2) + bloco / 2 - o.s;
    for (const l of linhas) {
      const w = f.widthOfTextAtSize(l, o.s);
      const x = al === "c" ? x0 + (x1 - x0 - w) / 2 : al === "r" ? x1 - pad - w : x0 + pad;
      p.drawText(l, { x, y, font: f, size: o.s, color: o.c ?? PRETO });
      y -= altLinha;
    }
  };
  const retangulo = (p: PDFPage, x0: number, x1: number, t0: number, t1: number, fill?: ReturnType<typeof rgb>) =>
    p.drawRectangle({
      x: x0,
      y: yOf(t1),
      width: x1 - x0,
      height: t1 - t0,
      borderColor: PRETO,
      borderWidth: 0.8,
      color: fill,
    });
  const linhaH = (p: PDFPage, x0: number, x1: number, t: number) =>
    p.drawLine({ start: { x: x0, y: yOf(t) }, end: { x: x1, y: yOf(t) }, thickness: 0.8, color: PRETO });
  const linhaV = (p: PDFPage, x: number, t0: number, t1: number) =>
    p.drawLine({ start: { x, y: yOf(t0) }, end: { x, y: yOf(t1) }, thickness: 0.8, color: PRETO });
  const fundo = (p: PDFPage, x0: number, x1: number, t0: number, t1: number, cor: ReturnType<typeof rgb>) =>
    p.drawRectangle({ x: x0, y: yOf(t1), width: x1 - x0, height: t1 - t0, color: cor });

  // Cabeçalho da tabela de itens (linha 6 do modelo: faixa verde)
  const desenhaCabecalhoItens = (p: PDFPage, t0: number): number => {
    const t1 = t0 + altura(6);
    fundo(p, X[0], X[7], t0, t1, VERDE);
    const cols: [string, number, number][] = [
      ["ITEM", X[0], X[1]],
      ["NOME DO PRODUTO/SERVIÇO/MATERIAL", X[1], X[2]],
      ["CENTRO DE CUSTO", X[2], X[3]],
      ["QUANTIDADE", X[3], X[4]],
      ["UNIDADE", X[4], X[5]],
      ["Valor Unitário", X[5], X[6]],
      ["Valor Total", X[6], X[7]],
    ];
    for (const [titulo, a, b] of cols) {
      retangulo(p, a, b, t0, t1);
      textoCelula(p, titulo, a, b, t0, t1, "c", { f: bold, s: 5.4, pad: 2 });
    }
    return t1;
  };

  // Desenha a linha de um item (linha 7 do modelo, repetida conforme a quantidade de itens)
  const desenhaItem = (p: PDFPage, t0: number, idx: number, item: ItemPdfOP) => {
    const t1 = t0 + ALTURA_ITEM;
    retangulo(p, X[0], X[1], t0, t1);
    retangulo(p, X[1], X[2], t0, t1);
    retangulo(p, X[2], X[3], t0, t1);
    retangulo(p, X[3], X[4], t0, t1, CREME);
    retangulo(p, X[4], X[5], t0, t1);
    retangulo(p, X[5], X[6], t0, t1, AZUL_CLARO);
    retangulo(p, X[6], X[7], t0, t1, AZUL_CLARO);
    textoCelula(p, String(idx + 1), X[0], X[1], t0, t1, "c", { s: 5.9 });
    textoCelula(p, item.descricao, X[1], X[2], t0, t1, "c", { f: reg, s: 5.9 });
    textoCelula(p, d.centroDeCusto, X[2], X[3], t0, t1, "c", { s: 5.9 });
    textoCelula(p, item.quantidade.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }), X[3], X[4], t0, t1, "c", { s: 4.9 });
    textoCelula(p, item.unidade ?? "", X[4], X[5], t0, t1, "c", { s: 5.9 });
    textoCelula(p, moeda(item.valorUnitario), X[5], X[6], t0, t1, "c", { s: 5.4 });
    textoCelula(p, moeda(item.total), X[6], X[7], t0, t1, "c", { s: 5.4 });
    return t1;
  };

  // ---------- Página 1: cabeçalho ----------
  let pagina = novaPagina();
  const paginas: PDFPage[] = [pagina];

  // Título
  retangulo(pagina, X[0], X[7], Y0, topo(2));
  textoCelula(pagina, "ORDEM DE PAGAMENTO", X[0], X[7], Y0, topo(2), "c", { f: bold, s: 13.7 });
  if (d.numero) textoCelula(pagina, d.numero, X[0], X[7], Y0, topo(2), "r", { f: bold, s: 4.6, pad: 6 });

  // Logo (A2:B4) e CNPJ (A5:B5)
  retangulo(pagina, X[0], X[2], topo(2), topo(5));
  if (logo) {
    const lw = 81.5;
    const lh = (lw * logo.height) / logo.width;
    pagina.drawImage(logo, { x: X[1] + 20.7, y: yOf(topo(2) + 2.6) - lh, width: lw, height: lh });
  }
  retangulo(pagina, X[0], X[2], topo(5), topo(6));
  textoCelula(pagina, `CNPJ: ${SISTEMA.empresaCnpj}`, X[0], X[2], topo(5), topo(6), "c", { f: boldOblique, s: 7.8, c: VERMELHO });

  // Data de emissão (C2:E3 rótulo cinza; C4:E5 valor em vermelho)
  retangulo(pagina, X[2], X[4], topo(2), topo(4), CINZA_CLARO);
  textoCelula(pagina, "Data:", X[2], X[4], topo(2), topo(4), "c", { f: bold, s: 7.8 });
  retangulo(pagina, X[2], X[4], topo(4), topo(6));
  textoCelula(pagina, data(d.dataEmissao), X[2], X[4], topo(4), topo(6), "c", { f: boldOblique, s: 7.8, c: VERMELHO });

  // Campos do fornecedor (F rótulo, G:H valor)
  const campos: [string, string][] = [
    ["FORNECEDOR", d.favorecido.toUpperCase()],
    ["Nº da Nota Fiscal", d.numeroNf ?? "—"],
    ["Data de vencimento", d.vencimento ? data(d.vencimento) : "—"],
    ["CONDIÇÃO DE PGTO (pix ou boleto)", FORMAS_PAGAMENTO[d.formaPagamento].toUpperCase()],
  ];
  campos.forEach(([rotulo, valor], i) => {
    const l = 2 + i;
    retangulo(pagina, X[4], X[5], topo(l), topo(l + 1));
    textoCelula(pagina, rotulo, X[4], X[5], topo(l), topo(l + 1), "l", { f: boldOblique, s: 6.35, pad: 3 });
    retangulo(pagina, X[5], X[7], topo(l), topo(l + 1), AZUL_CLARO);
    textoCelula(pagina, valor, X[5], X[7], topo(l), topo(l + 1), "c", { f: boldOblique, s: 6.35 });
  });
  // Dados da data de emissão: a linha 5 do modelo é a condição de pagamento (F5:H5), já coberta acima.

  // Título da tabela e cabeçalho de itens (linhas 6)
  let t = desenhaCabecalhoItens(pagina, topo(6));

  // ---------- Itens ----------
  d.itens.forEach((item, idx) => {
    if (t + ALTURA_ITEM > 430) {
      pagina = novaPagina();
      paginas.push(pagina);
      t = desenhaCabecalhoItens(pagina, Y0);
    }
    t = desenhaItem(pagina, t, idx, item);
  });

  // ---------- Bloco de pagamento, total, parcelas e assinatura ----------
  // O bloco do modelo (linhas 8 a 17) começa logo após os itens; por isso desloca conforme a quantidade de itens.
  const deslocamento = (d.itens.length - 1) * ALTURA_ITEM; // o modelo tem 1 linha de item; cada item extra empurra o bloco
  const b = (linha: number) => topo(linha) + deslocamento;
  const fimModelo = b(18);

  // Pagamento: caixas A8:B11 e textos
  const linhasPag = [
    ...(d.dadosBancarios ? d.dadosBancarios.split(/\r?\n/).flatMap((l) => quebrar(l, bold, 6.35, 200)) : []),
    ...quebrar(`FAVORECIDO: ${d.favorecido}`, bold, 6.35, 200),
    ...(d.cpfCnpj ? [`CPF/CNPJ: ${cpfCnpj(d.cpfCnpj)}`] : []),
  ];
  // Caixas do bloco (A8:B8 título; A9:B9, A10:B10 e A11:B11 linhas)
  retangulo(pagina, X[0], X[2], b(8), b(9));
  textoCelula(pagina, "PAGAMENTO", X[0], X[2], b(8), b(9), "c", { f: bold, s: 6.35 });
  const linhasCaixa: [number, number][] = [
    [b(9), b(10)],
    [b(10), b(11)],
    [b(11), b(12)],
  ];
  linhasCaixa.forEach(([a, c]) => retangulo(pagina, X[0], X[2], a, c));
  // Pagamento: uma linha por informação, alinhada à esquerda, como no modelo
  const entradas = linhasPag.slice(0, 3);
  entradas.forEach((l, j) => {
    const [a, c] = linhasCaixa[Math.min(j, 2)];
    textoCelula(pagina, l, X[0], X[2], a, c, "l", { f: bold, s: 6.35 });
  });

  // Total (G9 rótulo, H9 valor), como no modelo
  retangulo(pagina, X[5], X[6], b(8), b(9), AZUL_CLARO);
  retangulo(pagina, X[6], X[7], b(8), b(9), AZUL_CLARO);
  textoCelula(pagina, "Total", X[5], X[6], b(9), b(10), "c", { f: bold, s: 5.4 });
  retangulo(pagina, X[5], X[6], b(9), b(10));
  retangulo(pagina, X[6], X[7], b(9), b(10), AZUL_CLARO);
  textoCelula(pagina, moeda(subtotal), X[6], X[7], b(9), b(10), "c", { s: 5.4 });

  // Parcelas (E10:H17): só quando a OP tem duas ou mais parcelas; o bloco cresce se precisar
  const parcelas = d.parcelas && d.parcelas.length >= 2 ? d.parcelas : [];
  let fimBloco = fimModelo;
  if (parcelas.length) {
    const altLinha = 7.4;
    const topoParc = b(10);
    retangulo(pagina, X[3], X[7], topoParc, topoParc + 9);
    textoCelula(pagina, "PARCELAS", X[3], X[7], topoParc, topoParc + 9, "c", { f: bold, s: 5.4 });
    const cabTopo = topoParc + 9;
    retangulo(pagina, X[3], X[4], cabTopo, cabTopo + altLinha);
    retangulo(pagina, X[4], X[5], cabTopo, cabTopo + altLinha);
    retangulo(pagina, X[5], X[7], cabTopo, cabTopo + altLinha);
    textoCelula(pagina, "Nº", X[3], X[4], cabTopo, cabTopo + altLinha, "c", { f: bold, s: 5 });
    textoCelula(pagina, "Vencimento", X[4], X[5], cabTopo, cabTopo + altLinha, "c", { f: bold, s: 5 });
    textoCelula(pagina, "Valor", X[5], X[7], cabTopo, cabTopo + altLinha, "c", { f: bold, s: 5 });
    let y = cabTopo + altLinha;
    for (const p of parcelas) {
      if (y + altLinha > PAGINA_A - 60) break;
      retangulo(pagina, X[3], X[4], y, y + altLinha);
      retangulo(pagina, X[4], X[5], y, y + altLinha);
      retangulo(pagina, X[5], X[7], y, y + altLinha);
      textoCelula(pagina, String(p.numero), X[3], X[4], y, y + altLinha, "c", { s: 5 });
      textoCelula(pagina, data(p.vencimento), X[4], X[5], y, y + altLinha, "c", { s: 5 });
      textoCelula(pagina, moeda(p.valor), X[5], X[7], y, y + altLinha, "c", { s: 5 });
      y += altLinha;
    }
    fimBloco = Math.max(fimBloco, y + 4);
  }

  // Borda externa do formulário (da linha 1 até o fim do bloco)
  linhaV(pagina, X[0], Y0, fimBloco);
  linhaV(pagina, X[7], Y0, fimBloco);
  linhaH(pagina, X[0], X[7], fimBloco);

  // Assinatura: linha curta centralizada e nome da empresa abaixo (linhas 15 e 16 do modelo)
  const meio = (X[1] + X[6]) / 2;
  linhaH(pagina, meio - 80, meio + 80, b(15) + 6);
  textoCelula(pagina, SISTEMA.empresa, X[1], X[6], b(16), b(17), "c", { f: reg, s: 5.9 });

  // Marca d'água de rascunho
  if (d.rascunho) {
    for (const p of paginas) {
      p.drawText("RASCUNHO", { x: 230, y: 200, size: 110, font: bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(20) });
    }
  }

  return pdf.save();
}
