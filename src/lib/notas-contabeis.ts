import { XMLParser } from "fast-xml-parser";

// Identificação de notas fiscais para a contabilidade, a partir do conteúdo do arquivo anexado.
// Regras (pedido do Financeiro):
//  1. tomado_pj_retencao: NFS-e de pessoa jurídica com retenção de INSS, IRRF, CSRF ou ISS.
//  2. tomado_pf: NFS-e ou nota avulsa de pessoa física.
//  3. mei_servicos_especificos: MEI que presta somente hidráulica, eletricidade, pintura,
//     alvenaria, carpintaria ou manutenção/reparo de veículos.
// Quando a nota não se encaixa, o motivo é devolvido para conferência.

export type CategoriaNota = "tomado_pj_retencao" | "tomado_pf" | "mei_servicos_especificos" | "medicao_emitida";

export type Retencoes = { inss: number; irrf: number; csrf: number; iss: number };

export type DadosNota = {
  ehNfse: boolean;
  prestadorDocumento: string | null;
  tomadorDocumento: string | null;
  prestadorNome: string | null;
  numero: string | null;
  dataEmissao: string | null; // AAAA-MM-DD
  valor: number | null;
  valorLiquido: number | null;
  medicao: boolean; // boletim de medição (BM)
  mei: boolean;
  servicos: string[];
  retencoes: Retencoes;
};

export type Classificacao = { categoria: CategoriaNota | null; motivo: string | null };

const SERVICOS_MEI: RegExp[] = [
  /hidr[aá]ulic/i,
  /el[eé]tric/i,
  /pintur|pintor/i,
  /alvenaria|pedreir/i,
  /carpint/i,
  /(manuten[cç][aã]o|repar[oa]|conserto)[^.]{0,60}ve[ií]culo|ve[ií]culo[^.]{0,60}(manuten[cç][aã]o|repar[oa]|conserto)/i,
];

const digitos = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

/**
 * `cnpjEmpresa`: CNPJ da empresa dona do sistema. Só são classificadas notas em que ela é a
 * tomadora dos serviços (quando o tomador é conhecido) e nunca notas que ela mesma emitiu.
 */
export function classificarNota(d: DadosNota, cnpjEmpresa: string): Classificacao {
  if (!d.ehNfse) return { categoria: null, motivo: "não é NFS-e nem nota avulsa de serviço" };
  const doc = digitos(d.prestadorDocumento);
  const empresa = digitos(cnpjEmpresa);
  if (doc === empresa) {
    // Emitida pela empresa: só interessa a nota de medição (boletim), que tem cálculo de impostos.
    return d.medicao
      ? { categoria: "medicao_emitida", motivo: null }
      : { categoria: null, motivo: "nota emitida pela própria empresa (não é serviço tomado)" };
  }
  const tomador = digitos(d.tomadorDocumento);
  if (tomador && tomador !== empresa) return { categoria: null, motivo: "a empresa não é a tomadora desta nota" };

  if (doc.length === 11) return { categoria: "tomado_pf", motivo: null };

  if (doc.length === 14) {
    if (d.mei) {
      const soServicosPermitidos =
        d.servicos.length > 0 && d.servicos.every((s) => SERVICOS_MEI.some((r) => r.test(s)));
      return soServicosPermitidos
        ? { categoria: "mei_servicos_especificos", motivo: null }
        : { categoria: null, motivo: "MEI com serviço fora da lista permitida" };
    }
    const r = d.retencoes;
    if (r.inss + r.irrf + r.csrf + r.iss > 0) return { categoria: "tomado_pj_retencao", motivo: null };
    return { categoria: null, motivo: "pessoa jurídica sem retenção de INSS, IRRF, CSRF ou ISS" };
  }

  return { categoria: null, motivo: "CPF/CNPJ do prestador não identificado" };
}

export const ROTULO_CATEGORIA: Record<CategoriaNota, string> = {
  tomado_pj_retencao: "Serviço tomado de PJ com retenção",
  tomado_pf: "Serviço tomado de PF",
  mei_servicos_especificos: "MEI — serviços específicos",
  medicao_emitida: "Medição emitida pela empresa",
};

// ----- NFS-e em XML (padrão municipal ABRASF e padrão nacional) -----

type No = Record<string, unknown>;

/** Primeiro valor, em profundidade, de uma das chaves informadas. */
function achar(no: unknown, chaves: string[]): unknown {
  if (!no || typeof no !== "object") return undefined;
  const obj = no as No;
  for (const c of chaves) if (obj[c] !== undefined && obj[c] !== null && obj[c] !== "") return obj[c];
  for (const v of Object.values(obj)) {
    const achado = Array.isArray(v) ? v.map((x) => achar(x, chaves)).find((x) => x !== undefined) : achar(v, chaves);
    if (achado !== undefined) return achado;
  }
  return undefined;
}

const txt = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v).trim());
const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

/** Lê uma NFS-e em XML. Retorna null quando o XML não é de NFS-e (por exemplo, NF-e de produto). */
export function lerNfseXml(xml: string): DadosNota | null {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, processEntities: false, trimValues: true });
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  const inf = achar(doc, ["InfNfse", "infNFSe"]) as No | undefined;
  if (!inf) return null;

  // Prestador: quem presta o serviço (no padrão nacional, o emitente).
  const prestador = achar(inf, ["PrestadorServico", "Prestador", "emit"]);
  const documentoPrestador = txt(achar(prestador, ["Cnpj", "CNPJ", "Cpf", "CPF"]));
  const tomador = achar(inf, ["TomadorServico", "toma"]);
  const documentoTomador = txt(achar(tomador, ["Cnpj", "CNPJ", "Cpf", "CPF"]));
  const mei = txt(achar(inf, ["opSimpNac"])) === "2" || txt(achar(inf, ["RegimeEspecialTributario"])) === "5";

  const valores = (achar(inf, ["Valores", "valores"]) ?? {}) as No;
  const v = (k: string) => num(achar(valores, [k]) ?? achar(inf, [k]));
  const issRetido = txt(achar(inf, ["IssRetido"])) === "1" || txt(achar(inf, ["tpRetISSQN"])) === "1";
  const retencoes: Retencoes = {
    inss: v("ValorInss") || v("vRetCP"),
    irrf: v("ValorIr") || v("vRetIRRF"),
    csrf: v("ValorCsll") + v("ValorPis") + v("ValorCofins") || v("vRetCSLL") + v("vRetPIS") + v("vRetCOFINS"),
    iss: issRetido ? v("ValorIssRetido") || v("vISSQN") : 0,
  };

  const descricao = txt(achar(inf, ["Discriminacao", "xDescServ"])) ?? "";
  const servicos = descricao.split(/[;\n|]+/).map((s) => s.trim()).filter(Boolean);
  const dataTxt = txt(achar(inf, ["DataEmissao", "dhEmi", "dhProc"])) ?? "";
  const dataEmissao = /^\d{4}-\d{2}-\d{2}/.test(dataTxt) ? dataTxt.slice(0, 10) : null;

  return {
    ehNfse: true,
    prestadorDocumento: documentoPrestador,
    tomadorDocumento: documentoTomador,
    prestadorNome: txt(achar(prestador, ["RazaoSocial", "xNome"])),
    numero: txt(achar(inf, ["Numero", "nNFSe"])),
    dataEmissao,
    valor: v("ValorServicos") || v("vServ") || v("vLiq") || null,
    valorLiquido: v("ValorLiquidoNfse") || v("vLiq") || null,
    medicao: /MEDI[CÇ][AÃ]O|\bBM\s?\d/i.test(descricao),
    mei,
    servicos,
    retencoes,
  };
}

// ----- NFS-e em PDF com camada de texto -----

const numBR = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
const DINHEIRO = /^\d{1,3}(\.\d{3})*,\d{2}$/;

/**
 * Valores do quadro "VALORES" de notas de layout tabular: a linha de valores vem logo depois do
 * cabeçalho. Retorna o primeiro valor da linha (valor do serviço) e o último (ISS retido, quando o
 * cabeçalho tem a coluna "ISS Retido").
 */
function valoresDaTabela(linhas: string[], cabecalho: RegExp): { primeiro: number; ultimo: number; cabecalhoTemIssRetido: boolean } | null {
  const i = linhas.findIndex((l) => cabecalho.test(l));
  if (i < 0) return null;
  for (let j = i + 1; j < Math.min(linhas.length, i + 4); j++) {
    const dinheiro = linhas[j].split(/\s+/).filter((t) => DINHEIRO.test(t));
    if (dinheiro.length >= 4) {
      // O cabeçalho pode quebrar em mais de uma linha: procura "ISS Retido" até a linha de valores.
      const cabecalho = linhas.slice(i, j).join(" ");
      return {
        primeiro: numBR(dinheiro[0]),
        ultimo: numBR(dinheiro[dinheiro.length - 1]),
        cabecalhoTemIssRetido: /ISS\s+Retido/i.test(cabecalho),
      };
    }
  }
  return null;
}

/**
 * Valor líquido do quadro de tributos em tabela: a linha de valores vem depois do cabeçalho que
 * termina em "Valor Líquido (R$) Valor Total (R$)". O líquido é o penúltimo valor da linha.
 */
function liquidoDaTabela(linhas: string[]): number | null {
  const i = linhas.findIndex((l) => /Valor L[IÍ]quido \(R\$\)\s*Valor Total/i.test(l));
  if (i < 0) return null;
  for (const linha of linhas.slice(i + 1, i + 4)) {
    const dinheiro = linha.split(/\s+/).filter((t) => DINHEIRO.test(t));
    if (dinheiro.length >= 2) return numBR(dinheiro[dinheiro.length - 2]);
  }
  return null;
}

/** Lê uma NFS-e em PDF com camada de texto. Notas só de imagem não são identificadas. */
export function lerNfseTexto(texto: string): DadosNota | null {
  const t = texto.replace(/[ \t]+/g, " ");
  const linhas = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const ehNfse = /NFS-?e\b|NOTA FISCAL (DE )?SERVI[CÇ]O|NOTA FISCAL AVULSA/i.test(t) && !/DANFE/i.test(t);
  if (!ehNfse) return null;

  // Prestador: primeiro CNPJ/CPF depois do rótulo PRESTADOR.
  const iPrest = t.search(/\bPRESTADOR\b/i);
  const aposPrestador = iPrest >= 0 ? t.slice(iPrest, iPrest + 600) : "";
  const docPrest = aposPrestador.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}/);
  // Tomador: primeiro CNPJ/CPF depois do rótulo TOMADOR.
  const iTom = t.search(/TOMADOR/i);
  const aposTomador = iTom >= 0 ? t.slice(iTom, iTom + 300) : "";
  const docTom = aposTomador.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}/);

  const nomeM =
    aposPrestador.match(/Nome \/ Nome Empresarial\s*\n?\s*([^\n]+)/i) ??
    aposPrestador.match(/\bPRESTADOR\b\s*\n?\s*([^\n]*?)\s+(?:CNPJ|CPF)\b/i) ??
    aposPrestador.match(/RAZ[ÃA]O SOCIAL\s*\n?\s*([^\n]+)/i);

  const retencao = (rotulo: RegExp) => {
    const m = t.match(rotulo);
    return m ? numBR(m[1]) : 0;
  };
  const tabela = valoresDaTabela(linhas, /Valor dos Servi[çc]os/i);

  const servicosM = t.match(/(?:DISCRIMINA[CÇ][AÃ]O(?:\s+DOS\s+SERVI[CÇ]OS)?|DESCRI[CÇ][AÃ]O DO SERVI[CÇ]O|DESCRI[CÇ][AÃ]O DOS SERVI[CÇ]OS)[:\s]*([\s\S]{0,1200}?)(?:\n\s*\n|TRIBUTA[CÇ][AÃ]O|VALOR|TOTAL|CONFORME|OUTRAS INFORMA|$)/i);
  const dataM = t.match(/EMISS[AÃ]O\D{0,25}(\d{2}\/\d{2}\/\d{4})/i);
  const liquidoM = t.match(/VALOR L[IÍ]QUIDO DA NFS-e\D{0,20}([\d.]+,\d{2})/i);
  const valorM =
    t.match(/VALOR (?:TOTAL )?(?:DOS )?SERVI[CÇ]OS?\D{0,20}([\d.]+,\d{2})/i) ?? t.match(/VALOR DA OPERA[CÇ][AÃ]O[^\d]{0,30}([\d.]+,\d{2})/i);
  const numeroM = t.match(/N(?:ú|u)MERO DA NFS-?e\D{0,30}?(\d{1,12})/i) ?? t.match(/N(?:ú|u)mero\D{0,30}?(\d{1,12})/i);

  return {
    ehNfse: true,
    prestadorDocumento: docPrest ? docPrest[0] : null,
    tomadorDocumento: docTom ? docTom[0] : null,
    prestadorNome: nomeM ? nomeM[1].replace(/^[\d.\-\/]+\s+/, "").trim() || null : null,
    numero: numeroM ? numeroM[1] : null,
    dataEmissao: dataM ? dataM[1].split("/").reverse().join("-") : null,
    valor: tabela ? tabela.primeiro : valorM ? numBR(valorM[1]) : null,
    valorLiquido: liquidoM ? numBR(liquidoM[1]) : liquidoDaTabela(linhas),
    medicao: /MEDI[CÇ][AÃ]O|\bBM\s?\d/i.test(t),
    mei: /\bMEI\b|Microempreendedor Individual/i.test(t),
    servicos: servicosM
      ? servicosM[1].split(/\n|;/).map((s) => s.trim()).filter((s) => s && !/^(DOS )?SERVI[ÇC]OS?$/i.test(s))
      : [],
    retencoes: {
      inss: retencao(/INSS\D{0,30}([\d.]+,\d{2})/i),
      irrf: retencao(/IRRF\D{0,30}([\d.]+,\d{2})/i),
      csrf: retencao(/CSRF\D{0,30}([\d.]+,\d{2})/i),
      // Tabela de valores: ISS retido é a última coluna da linha. Sem tabela, procura o rótulo.
      iss: tabela
        ? tabela.cabecalhoTemIssRetido ? tabela.ultimo : 0
        : retencao(/ISS\s*RETIDO\D{0,30}([\d.]+,\d{2})/i),
    },
  };
}
