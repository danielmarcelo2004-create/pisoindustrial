import "server-only";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { SISTEMA } from "@/lib/sistema";
import { cpfCnpj, data, dataHora, moeda } from "@/lib/formato";
import { FORMAS_PAGAMENTO, type FormaPagamento } from "@/lib/rotulos";

export type DadosPdfOP = {
  numero: string | null;
  rascunho: boolean;
  obra: { nome: string; cidade: string; uf: string; codigo?: string | null };
  solicitante: string;
  emitidaEm: string; // timestamp
  favorecido: string;
  cpfCnpj: string | null;
  descricao: string;
  vencimento: string | null;
  formaPagamento: FormaPagamento;
  dadosBancarios: string | null;
  observacoes: string | null;
  itens: { descricao: string; unidade: string | null; quantidade: number; valorUnitario: number; total: number }[];
};

const MARCA = rgb(0.122, 0.227, 0.353);
const CINZA = rgb(0.4, 0.45, 0.5);
const LINHA = rgb(0.85, 0.87, 0.9);

// As fontes padrão do PDF usam WinAnsi: troca caracteres fora dele.
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
    if (fonte.widthOfTextAtSize(teste, tamanho) <= largura) atual = teste;
    else {
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
  }
  if (atual) linhas.push(atual);
  return linhas.length ? linhas : [""];
}

const qtdFmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 });

/** Gera o PDF da Ordem de Pagamento (modelo provisório). */
export async function gerarPdfOP(d: DadosPdfOP): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Ordem de Pagamento ${d.numero ?? "(rascunho)"}`);
  pdf.setAuthor(SISTEMA.empresa);
  pdf.setCreator(SISTEMA.nome);
  const fonte = await pdf.embedFont(StandardFonts.Helvetica);
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold);

  const L = 595.28;
  const A = 841.89;
  const M = 40;
  const W = L - 2 * M;
  let page: PDFPage = pdf.addPage([L, A]);
  let y = A - M;

  const texto = (t: string, x: number, yy: number, o: { f?: PDFFont; s?: number; c?: ReturnType<typeof rgb> } = {}) =>
    page.drawText(seguro(t), { x, y: yy, font: o.f ?? fonte, size: o.s ?? 9, color: o.c ?? rgb(0.1, 0.12, 0.15) });
  const direita = (t: string, xDir: number, yy: number, o: { f?: PDFFont; s?: number } = {}) => {
    const f = o.f ?? fonte;
    const s = o.s ?? 9;
    texto(t, xDir - f.widthOfTextAtSize(seguro(t), s), yy, o);
  };
  const novaPagina = () => {
    page = pdf.addPage([L, A]);
    y = A - M;
  };
  const garantir = (h: number) => {
    if (y - h < M + 40) novaPagina();
  };

  // Cabeçalho
  page.drawRectangle({ x: 0, y: A - 90, width: L, height: 90, color: MARCA });
  texto(SISTEMA.empresa, M, A - 38, { f: negrito, s: 13, c: rgb(1, 1, 1) });
  texto(`CNPJ ${SISTEMA.empresaCnpj} · ${SISTEMA.empresaEndereco}`, M, A - 54, { s: 8, c: rgb(0.8, 0.85, 0.92) });
  {
    const t = "ORDEM DE PAGAMENTO";
    page.drawText(t, { x: L - M - negrito.widthOfTextAtSize(t, 13), y: A - 38, font: negrito, size: 13, color: rgb(1, 1, 1) });
  }
  page.drawText(seguro(d.numero ?? "RASCUNHO — sem número"), {
    x: L - M - negrito.widthOfTextAtSize(seguro(d.numero ?? "RASCUNHO — sem número"), 11),
    y: A - 56,
    font: negrito,
    size: 11,
    color: rgb(1, 0.85, 0.4),
  });
  y = A - 115;

  // Bloco de dados
  const campo = (rot: string, val: string, x: number, larg: number) => {
    texto(rot.toUpperCase(), x, y, { s: 7, c: CINZA, f: negrito });
    const linhas = quebrar(val || "—", fonte, 10, larg);
    linhas.forEach((l, i) => texto(l, x, y - 13 - i * 12, { s: 10 }));
    return 13 + linhas.length * 12;
  };
  const linhaCampos = (cs: [string, string][]) => {
    const larg = W / cs.length - 10;
    const h = Math.max(...cs.map(([r, v], i) => campo(r, v, M + i * (W / cs.length), larg)));
    y -= h + 10;
  };

  linhaCampos([
    ["Obra", `${d.obra.codigo ? d.obra.codigo + " — " : ""}${d.obra.nome}`],
    ["Local", `${d.obra.cidade}/${d.obra.uf}`],
  ]);
  linhaCampos([
    ["Solicitante (engenheiro)", d.solicitante],
    ["Emitida em", dataHora(d.emitidaEm)],
    ["Vencimento", data(d.vencimento)],
  ]);
  linhaCampos([
    ["Favorecido", d.favorecido],
    ["CPF / CNPJ", d.cpfCnpj ? cpfCnpj(d.cpfCnpj) : "—"],
    ["Forma de pagamento", FORMAS_PAGAMENTO[d.formaPagamento]],
  ]);
  if (d.dadosBancarios) linhaCampos([["Dados para pagamento", d.dadosBancarios]]);
  linhaCampos([["Descrição", d.descricao]]);

  // Itens
  y -= 4;
  // Bordas: descrição até M+258; demais colunas alinhadas à direita.
  const col = { item: M, desc: M + 28, un: M + 268, qtdDir: M + 345, vuDir: M + 430, totDir: L - M - 4 };
  const cabecalhoItens = () => {
    page.drawRectangle({ x: M, y: y - 6, width: W, height: 20, color: rgb(0.94, 0.95, 0.97) });
    texto("#", col.item + 4, y, { f: negrito, s: 8 });
    texto("DESCRIÇÃO", col.desc, y, { f: negrito, s: 8 });
    texto("UN", col.un, y, { f: negrito, s: 8 });
    direita("QTD", col.qtdDir, y, { f: negrito, s: 8 });
    direita("VALOR UNIT.", col.vuDir, y, { f: negrito, s: 8 });
    direita("TOTAL", col.totDir, y, { f: negrito, s: 8 });
    y -= 22;
  };
  cabecalhoItens();
  let total = 0;
  d.itens.forEach((it, i) => {
    const linhas = quebrar(it.descricao, fonte, 9, 228);
    const h = linhas.length * 11 + 10;
    if (y - h < M + 60) {
      novaPagina();
      cabecalhoItens();
    }
    texto(String(i + 1), col.item + 4, y);
    linhas.forEach((l, j) => texto(l, col.desc, y - j * 11));
    texto((it.unidade ?? "").slice(0, 8), col.un, y);
    direita(qtdFmt.format(it.quantidade), col.qtdDir, y);
    direita(moeda(it.valorUnitario), col.vuDir, y);
    direita(moeda(it.total), col.totDir, y);
    y -= h;
    page.drawLine({ start: { x: M, y: y + 11 }, end: { x: L - M, y: y + 11 }, thickness: 0.5, color: LINHA });
    total += it.total;
  });
  garantir(30);
  y -= 6;
  direita("VALOR TOTAL", col.vuDir, y, { f: negrito, s: 10 });
  direita(moeda(total), col.totDir, y, { f: negrito, s: 12 });
  y -= 30;

  if (d.observacoes) {
    garantir(50);
    texto("OBSERVAÇÕES", M, y, { s: 7, c: CINZA, f: negrito });
    y -= 13;
    for (const l of quebrar(d.observacoes, fonte, 9, W)) {
      garantir(12);
      texto(l, M, y);
      y -= 12;
    }
    y -= 10;
  }

  // Área de aprovação
  garantir(90);
  page.drawRectangle({ x: M, y: y - 62, width: W, height: 70, borderColor: LINHA, borderWidth: 1 });
  texto("SOLICITAÇÃO", M + 10, y - 8, { s: 7, c: CINZA, f: negrito });
  texto(d.rascunho ? "—" : `Enviada eletronicamente por ${d.solicitante}`, M + 10, y - 22, { s: 9 });
  texto(d.rascunho ? "" : dataHora(d.emitidaEm), M + 10, y - 34, { s: 8, c: CINZA });
  texto("APROVAÇÃO DO ADMINISTRADOR DA OBRA", M + W / 2 + 10, y - 8, { s: 7, c: CINZA, f: negrito });
  texto("Registrada eletronicamente no sistema,", M + W / 2 + 10, y - 22, { s: 9 });
  texto("com usuário, data, hora e hash de integridade.", M + W / 2 + 10, y - 34, { s: 9 });
  y -= 80;

  // Rodapé e marca d'água em todas as páginas
  const paginas = pdf.getPages();
  paginas.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: 34 }, end: { x: L - M, y: 34 }, thickness: 0.5, color: LINHA });
    pg.drawText(seguro(`${SISTEMA.nome} · documento gerado eletronicamente · ${d.numero ?? "rascunho"}`), {
      x: M, y: 22, size: 7, font: fonte, color: CINZA,
    });
    const pgTxt = `Página ${i + 1} de ${paginas.length}`;
    pg.drawText(pgTxt, { x: L - M - fonte.widthOfTextAtSize(pgTxt, 7), y: 22, size: 7, font: fonte, color: CINZA });
    if (d.rascunho) {
      pg.drawText("RASCUNHO", { x: 120, y: 330, size: 90, font: negrito, color: rgb(0.85, 0.2, 0.2), opacity: 0.12, rotate: degrees(35) });
    }
  });

  return pdf.save();
}
