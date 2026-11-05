// Leitura de nota fiscal (DANFE/NF-e em PDF ou imagem) a partir do texto do OCR.
// Só é considerada CONFIÁVEL quando todas as linhas de item fecham a conta
// (quantidade × valor unitário = valor total) e a soma bate com o total de produtos.

export const CNPJ_EMPRESA_NF = "04.602.232/0001-70";

export type ItemNf = {
  numero_item: number;
  codigo: string | null;
  descricao: string;
  descricao_normalizada: string;
  ncm: string | null;
  unidade: string | null;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
};

export type NotaLidaOcr = {
  confiavel: boolean;
  motivos: string[];
  nota: {
    chave: string | null;
    numero: string | null;
    serie: string | null;
    data_emissao: string | null;
    emitente_cnpj: string | null;
    emitente_nome: string | null;
    emitente_uf: string | null;
    valor_produtos: number | null;
    valor_frete: number | null;
    valor_desconto: number | null;
    valor_total: number | null;
  };
  itens: ItemNf[];
};

const numBR = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
const normalizar = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9,.\s]/g, " ").replace(/(\d),(\d)/g, "$1.$2").replace(/[,]/g, " ").replace(/\s+/g, " ").trim();

export function lerNotaTexto(texto: string): NotaLidaOcr {
  const motivos: string[] = [];
  const linhas = texto.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const todo = linhas.join("\n");

  // Cabeçalho
  const cnpjs = [...todo.matchAll(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g)].map((m) => m[0]).filter((c) => c !== CNPJ_EMPRESA_NF);
  const emitenteCnpj = cnpjs[0] ?? null;
  const dataM = todo.match(/EMISS[ÃA]O\D{0,25}(\d{2}\/\d{2}\/\d{4})/i) ?? todo.match(/(\d{2}\/\d{2}\/\d{4})/);
  const dataEmissao = dataM ? dataM[1].split("/").reverse().join("-") : null;
  const numeroM = todo.match(/N[º°o]\.?\s*(\d{1,3}(?:\.\d{3})+|\d{3,9})/i);
  const numero = numeroM ? numeroM[1].replace(/\./g, "") : null;
  const serieM = todo.match(/S[ÉE]RIE\D{0,6}(\d{1,3})/i);
  const chaveDigitos = todo.replace(/[\s.\-]/g, "").match(/\d{44}/);
  const chave = chaveDigitos ? chaveDigitos[0] : null;
  const emitenteLinha = linhas.find((l) => /\b(LTDA|EIRELI|S\/?A|ME|EPP)\b/i.test(l) && !/CNPJ|DESTINAT/i.test(l)) ?? null;
  const ufM = todo.match(/\bUF\b\D{0,5}\b([A-Z]{2})\b/);

  const totalProdM = todo.match(/VALOR\s+TOTAL\s+DOS\s+PRODUTOS\D{0,12}([\d.]+,\d{2})/i);
  const totalNfM = todo.match(/VALOR\s+TOTAL\s+DA\s+NOTA\D{0,12}([\d.]+,\d{2})/i);
  const freteM = todo.match(/VALOR\s+DO\s+FRETE\D{0,12}([\d.]+,\d{2})/i);
  const descM = todo.match(/VALOR\s+DO\s+DESCONTO\D{0,12}([\d.]+,\d{2})/i);
  const valorProdutos = totalProdM ? numBR(totalProdM[1]) : null;

  // Itens: linhas que terminam em quantidade, valor unitário e valor total
  const itens: ItemNf[] = [];
  let duvidosas = 0;
  for (const linha of linhas) {
    const toks = linha.split(" ");
    if (toks.length < 6) continue;
    const vt = toks[toks.length - 1];
    const vu = toks[toks.length - 2];
    const qt = toks[toks.length - 3];
    if (!/^\d{1,3}(\.\d{3})*,\d{2}$/.test(vt) || !/^\d+(\.\d{3})*,\d{2,4}$/.test(vu) || !/^\d+(\.\d{3})*,\d{2,4}$/.test(qt)) continue;
    const quantidade = numBR(qt);
    const valorUnitario = numBR(vu);
    const valorTotal = numBR(vt);
    const fecha = Math.abs(quantidade * valorUnitario - valorTotal) <= Math.max(0.02, valorTotal * 0.005);
    const unidade = toks[toks.length - 4];
    const antes = toks.slice(0, toks.length - 4);
    const ncmIdx = antes.findIndex((t) => /^\d{8}$/.test(t));
    const temCodigo = ncmIdx > 1 && /^[A-Za-z0-9\-]{1,15}$/.test(antes[0]);
    const codigo = temCodigo ? antes[0] : null;
    const descricao = antes.slice(temCodigo ? 1 : 0, ncmIdx > 0 ? ncmIdx : antes.length).join(" ").trim();
    if (!fecha || !/[A-Za-zÀ-ÿ]{3,}/.test(descricao) || !/^[A-Za-z][A-Za-z0-9²³]{0,4}$/.test(unidade ?? "")) {
      duvidosas++;
      continue;
    }
    itens.push({
      numero_item: itens.length + 1,
      codigo,
      descricao,
      descricao_normalizada: normalizar(descricao),
      ncm: ncmIdx >= 0 ? antes[ncmIdx] : null,
      unidade: unidade.toUpperCase(),
      quantidade,
      valor_unitario: valorUnitario,
      valor_total: valorTotal,
    });
  }

  if (!emitenteCnpj) motivos.push("CNPJ do emitente não lido");
  if (!dataEmissao) motivos.push("data de emissão não lida");
  if (itens.length === 0) motivos.push("nenhum item lido");
  if (duvidosas > 0) motivos.push(`${duvidosas} linha(s) de item com leitura duvidosa`);
  if (valorProdutos === null) motivos.push("total de produtos não lido");
  if (valorProdutos !== null && itens.length) {
    const soma = itens.reduce((s, i) => s + i.valor_total, 0);
    if (Math.abs(soma - valorProdutos) > Math.max(0.05, valorProdutos * 0.001)) motivos.push("soma dos itens não bate com o total de produtos");
  }

  return {
    confiavel: motivos.length === 0,
    motivos,
    nota: {
      chave,
      numero,
      serie: serieM ? serieM[1] : null,
      data_emissao: dataEmissao,
      emitente_cnpj: emitenteCnpj,
      emitente_nome: emitenteLinha,
      emitente_uf: ufM ? ufM[1] : null,
      valor_produtos: valorProdutos,
      valor_frete: freteM ? numBR(freteM[1]) : null,
      valor_desconto: descM ? numBR(descM[1]) : null,
      valor_total: totalNfM ? numBR(totalNfM[1]) : null,
    },
    itens,
  };
}
