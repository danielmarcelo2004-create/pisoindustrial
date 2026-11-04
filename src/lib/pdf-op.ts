import "server-only";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { cpfCnpj, data, dataHora, moeda } from "@/lib/formato";
import { FORMAS_PAGAMENTO, type FormaPagamento } from "@/lib/rotulos";
import { SISTEMA } from "@/lib/sistema";

export type ItemPdfOP = {
  descricao: string;
  unidade: string | null;
  quantidade: number;
  valorUnitario: number;
  total: number;
  inicio: string | null;
  salario: number | null;
};

export type DadosPdfOP = {
  numero: string | null;
  rascunho: boolean;
  referencia: string | null;
  centroDeCusto: string;
  favorecido: string;
  cpfCnpj: string | null;
  observacao: string;
  vencimento: string | null;
  formaPagamento: FormaPagamento;
  dadosBancarios: string | null;
  observacoes: string | null;
  desconto: number;
  solicitante: string;
  emitidaEm: string;
  itens: ItemPdfOP[];
};

// Formulário em paisagem (A4), como o modelo oficial.
const L = 841.89;
const A = 595.28;
const M = 28;
const W = L - 2 * M;
const LIMITE = A - 52; // altura útil, acima do rodapé

type Cor = ReturnType<typeof rgb>;
const PRETO = rgb(0, 0, 0);
const CINZA = rgb(0.35, 0.35, 0.35);
const VERDE = rgb(0.573, 0.816, 0.314); // cabeçalho da tabela (cor do modelo)
const AMARELO = rgb(1, 0.949, 0.8); // valores e totais (cor do modelo)
const VERMELHO = rgb(0.8, 0.1, 0.1);
const AZUL = rgb(0.13, 0.36, 0.6);
const MARCA_DAGUA = rgb(0.85, 0.2, 0.2);

// As fontes padrão do PDF usam WinAnsi: substitui o que não cabe.
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

/** Quebra um texto em linhas que cabem na largura dada. */
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

/** Reduz a fonte e, se preciso, corta o texto com reticências, para caber numa célula. */
function encaixar(t: string, f: PDFFont, maxW: number, tamanho: number): { txt: string; s: number } {
  let s = tamanho;
  let txt = seguro(t);
  while (s > 6.5 && f.widthOfTextAtSize(txt, s) > maxW) s -= 0.5;
  if (f.widthOfTextAtSize(txt, s) > maxW) {
    while (txt.length > 1 && f.widthOfTextAtSize(txt + "…", s) > maxW) txt = txt.slice(0, -1);
    txt += "…";
  }
  return { txt, s };
}

/** Gera o PDF da Ordem de Pagamento no layout do modelo oficial da empresa. */
export async function gerarPdfOP(d: DadosPdfOP): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Ordem de Pagamento ${d.numero ?? "(rascunho)"}`);
  pdf.setAuthor(SISTEMA.empresa);
  pdf.setCreator(SISTEMA.nome);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const boldIt = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);

  const subtotal = d.itens.reduce((s, i) => s + i.total, 0);
  const total = subtotal - d.desconto;
  const temInicio = d.itens.some((i) => i.inicio);
  const temSalario = d.itens.some((i) => i.salario !== null);

  // Colunas da tabela (a coluna do nome ocupa o espaço restante).
  const colDef: { id: string; titulo: string; w: number; al: "c" | "l" | "r" }[] = [
    { id: "item", titulo: "ITEM", w: 38, al: "c" },
    { id: "nome", titulo: "NOME DO PRODUTO/SERVIÇO/MATERIAL", w: 0, al: "l" },
    { id: "centro", titulo: "CENTRO DE CUSTO", w: 150, al: "c" },
    ...(temInicio ? [{ id: "inicio", titulo: "INÍCIO", w: 66, al: "c" as const }] : []),
    ...(temSalario ? [{ id: "salario", titulo: "SALÁRIO", w: 80, al: "r" as const }] : []),
    { id: "un", titulo: "UNIDADE", w: 58, al: "c" },
    { id: "vu", titulo: "VALOR UNITÁRIO", w: 92, al: "r" },
    { id: "total", titulo: "VALOR TOTAL", w: 96, al: "r" },
  ];
  const fixo = colDef.reduce((s, c) => (c.id === "nome" ? s : s + c.w), 0);
  colDef.find((c) => c.id === "nome")!.w = W - fixo;
  const col: Record<string, { x: number; w: number; al: "c" | "l" | "r" }> = {};
  let cursor = M;
  for (const c of colDef) {
    col[c.id] = { x: cursor, w: c.w, al: c.al };
    cursor += c.w;
  }

  // Desenho
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
    caixa(p, M, top, W, h, { fill: VERDE });
    for (const c of colDef) {
      const cc = col[c.id];
      textoAlin(p, c.titulo, cc.x, cc.x + cc.w, top + 6, "c", { f: bold, s: 7.5 });
      if (cc.x > M) linhaV(p, cc.x, top, top + h);
    }
    return top + h;
  };

  let page = novaPagina();
  let top = M;

  // Título
  caixa(page, M, top, W, 30, { espessura: 1.4 });
  textoAlin(page, "ORDEM DE PAGAMENTO", M, M + W, top + 8, "c", { f: bold, s: 15 });
  if (d.numero) textoAlin(page, d.numero, M, M + W, top + 11, "r", { f: bold, s: 9 });
  top += 30;

  // Cabeçalho: empresa | data de vencimento | campos
  const hCab = 66;
  const xMeio = M + 230;
  const xDir = M + 530;
  caixa(page, M, top, W, hCab, { espessura: 1 });
  linhaV(page, xMeio, top, top + hCab);
  linhaV(page, xDir, top, top + hCab);
  texto(page, SISTEMA.logoPequeno, M + 14, top + 8, { s: 9, c: CINZA });
  texto(page, SISTEMA.logoGrande, M + 14, top + 17, { f: bold, s: 22, c: AZUL });
  texto(page, `CNPJ: ${SISTEMA.empresaCnpj}`, M + 14, top + hCab - 20, { f: boldIt, s: 10, c: VERMELHO });

  textoAlin(page, "Data de vencimento:", xMeio, xDir, top + 8, "c", { f: bold, s: 10 });
  textoAlin(page, d.vencimento ? data(d.vencimento) : "—", xMeio, xDir, top + 26, "c", { f: boldIt, s: 16, c: VERMELHO });
  if (d.referencia) textoAlin(page, `REF: ${d.referencia}`, xMeio, xDir, top + hCab - 17, "c", { f: boldIt, s: 10, c: VERMELHO });

  const campos: [string, string, boolean][] = [
    ["FORNECEDOR", d.favorecido.toUpperCase(), false],
    ["OBSERVAÇÃO", d.observacao, true],
    ["CONDIÇÃO DE PGTO", FORMAS_PAGAMENTO[d.formaPagamento].toUpperCase(), false],
  ];
  const hLin = hCab / 3;
  const xValorDir = xDir + 88;
  campos.forEach(([, , ], i) => caixa(page, xValorDir, top + i * hLin, M + W - xValorDir, hLin, { fill: AMARELO }));
  campos.forEach(([rotulo, valor, italico], i) => {
    const yy = top + i * hLin;
    if (i > 0) linhaH(page, xDir, M + W, yy);
    texto(page, rotulo, xDir + 5, yy + hLin / 2 - 4, { f: bold, s: 6.5, c: CINZA });
    const fonte = italico ? boldIt : bold;
    const enc = encaixar(valor, fonte, M + W - xValorDir - 10, 9);
    texto(page, enc.txt, xValorDir + 6, yy + hLin / 2 - enc.s / 2 - 1, { f: fonte, s: enc.s });
  });
  linhaV(page, xValorDir, top, top + hCab);
  top += hCab;

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
    if (temInicio) celula("inicio", item.inicio ? data(item.inicio) : "—", "c");
    if (temSalario) celula("salario", item.salario !== null ? moeda(item.salario) : "—", "r");
    celula("un", item.unidade ?? "", "c");
    celula("vu", moeda(item.valorUnitario), "r");
    celula("total", moeda(item.total), "r");
    top += hRow;
  });

  // Bloco final: pagamento (esquerda), totais (direita), observação e assinatura
  const linhasPag = [
    ...(d.dadosBancarios ? d.dadosBancarios.split(/\r?\n/).flatMap((l) => quebrar(l, bold, 9, col.vu.x - M - 40)) : []),
    ...quebrar(`FAV: ${d.favorecido}`, bold, 9, col.vu.x - M - 40),
    ...(d.cpfCnpj ? [`CPF/CNPJ: ${cpfCnpj(d.cpfCnpj)}`] : []),
  ];
  const wPag = col.vu.x - M - 16;
  const hPag = 26 + linhasPag.length * 14 + 10;
  const obsL = d.observacoes ? quebrar(d.observacoes, reg, 8, wPag - 10) : [];
  const hObs = obsL.length ? obsL.length * 10 + 8 : 0;
  const hBloco = Math.max(hPag, 54);
  if (top + hBloco + hObs + 70 > LIMITE) {
    page = novaPagina();
    top = M;
  }

  const linhasTot: [string, string, boolean][] = [
    ["Sub-Total", moeda(subtotal), false],
    ["Desconto", d.desconto > 0 ? `- ${moeda(d.desconto)}` : "", false],
    ["Total", moeda(total), true],
  ];
  linhasTot.forEach(([rotulo, valor, destaque], i) => {
    const yy = top + i * 18;
    caixa(page, col.vu.x, yy, col.vu.w, 18, { fill: AMARELO });
    caixa(page, col.total.x, yy, col.total.w, 18, { fill: AMARELO });
    textoAlin(page, rotulo, col.vu.x, col.vu.x + col.vu.w, yy + 5, "r", { f: bold, s: 9 });
    textoAlin(page, valor, col.total.x, col.total.x + col.total.w, yy + (destaque ? 3 : 5), "r", { f: bold, s: destaque ? 11 : 9 });
  });

  caixa(page, M, top, wPag, hPag);
  textoAlin(page, "PAGAMENTO", M, M + wPag, top + 7, "c", { f: bold, s: 10 });
  linhasPag.forEach((l, j) => textoAlin(page, l, M, M + wPag, top + 26 + j * 14, "c", { f: bold, s: 9 }));

  if (obsL.length) {
    obsL.forEach((l, j) => texto(page, l, M, top + hPag + 8 + j * 10, { s: 8, c: CINZA }));
  }

  // Assinatura: linha para assinatura física + registro eletrônico
  const fimBloco = top + hBloco + hObs;
  const sigTop = fimBloco + 22;
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

  // Rodapé e marca d'água em todas as páginas
  const total_p = paginas.length;
  paginas.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: 36 }, end: { x: L - M, y: 36 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    p.drawText(seguro(`${d.numero ?? "Rascunho"} · ${SISTEMA.nome}`), { x: M, y: 24, size: 7, font: reg, color: CINZA });
    const pg = `Página ${i + 1} de ${total_p}`;
    p.drawText(pg, { x: L - M - reg.widthOfTextAtSize(pg, 7), y: 24, size: 7, font: reg, color: CINZA });
    if (d.rascunho) {
      p.drawText("RASCUNHO", { x: 230, y: 200, size: 110, font: bold, color: MARCA_DAGUA, opacity: 0.12, rotate: degrees(20) });
    }
  });

  return pdf.save();
}
