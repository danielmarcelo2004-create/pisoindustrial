import { XMLParser } from "fast-xml-parser";

// Identificação de notas fiscais para a contabilidade, a partir do conteúdo do arquivo anexado.
// Regras (pedido do Financeiro):
//  1. tomado_pj_retencao: NFS-e de pessoa jurídica com retenção de INSS, IRRF, CSRF ou ISS.
//  2. tomado_pf: NFS-e ou nota avulsa de pessoa física.
//  3. mei_servicos_especificos: MEI que presta somente hidráulica, eletricidade, pintura,
//     alvenaria, carpintaria ou manutenção/reparo de veículos.
// Quando a nota não se encaixa, o motivo é devolvido para conferência.

export type CategoriaNota = "tomado_pj_retencao" | "tomado_pf" | "mei_servicos_especificos";

export type Retencoes = { inss: number; irrf: number; csrf: number; iss: number };

export type DadosNota = {
  ehNfse: boolean;
  prestadorDocumento: string | null;
  prestadorNome: string | null;
  numero: string | null;
  dataEmissao: string | null; // AAAA-MM-DD
  valor: number | null;
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

export function classificarNota(d: DadosNota): Classificacao {
  if (!d.ehNfse) return { categoria: null, motivo: "não é NFS-e nem nota avulsa de serviço" };
  const doc = (d.prestadorDocumento ?? "").replace(/\D/g, "");

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
    prestadorNome: txt(achar(prestador, ["RazaoSocial", "xNome"])),
    numero: txt(achar(inf, ["Numero", "nNFSe"])),
    dataEmissao,
    valor: v("ValorServicos") || v("vServ") || v("vLiq") || null,
    mei,
    servicos,
    retencoes,
  };
}

// ----- NFS-e em PDF com camada de texto -----

const numBR = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));

/** Lê o texto de uma NFS-e em PDF. Heurística: notas sem camada de texto não são identificadas. */
export function lerNfseTexto(texto: string): DadosNota | null {
  const t = texto.replace(/[ \t]+/g, " ");
  const ehNfse = /NFS-?e\b|NOTA FISCAL (DE )?SERVI[CÇ]O|NOTA FISCAL AVULSA/i.test(t) && !/DANFE/i.test(t);
  if (!ehNfse) return null;

  // Documento do prestador: primeiro CNPJ/CPF depois do rótulo PRESTADOR.
  const inicioPrestador = t.search(/PRESTADOR/i);
  const aposPrestador = inicioPrestador >= 0 ? t.slice(inicioPrestador, inicioPrestador + 600) : "";
  const docM = aposPrestador.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{3}\.\d{3}\.\d{3}-\d{2}/);
  const retencao = (rotulo: RegExp) => {
    const m = t.match(rotulo);
    return m ? numBR(m[1]) : 0;
  };
  const servicosM = t.match(/(?:DISCRIMINA[CÇ][AÃ]O|DESCRI[CÇ][AÃ]O DO SERVI[CÇ]O)[:\s]*([\s\S]{0,400}?)(?:\n\s*\n|VALOR|TOTAL|$)/i);
  const dataM = t.match(/EMISS[AÃ]O\D{0,25}(\d{2}\/\d{2}\/\d{4})/i);
  const valorM = t.match(/VALOR (?:TOTAL )?(?:DOS )?SERVI[CÇ]OS?\D{0,20}([\d.]+,\d{2})/i);
  const numeroM = t.match(/N[ºº°o]\.?\s*(?:DA )?(?:NFS-?e|NOTA)?\D{0,12}(\d{1,12})/i);

  return {
    ehNfse: true,
    prestadorDocumento: docM ? docM[0] : null,
    prestadorNome: null,
    numero: numeroM ? numeroM[1] : null,
    dataEmissao: dataM ? dataM[1].split("/").reverse().join("-") : null,
    valor: valorM ? numBR(valorM[1]) : null,
    mei: /\bMEI\b|Microempreendedor Individual/i.test(t),
    servicos: servicosM ? servicosM[1].split(/\n|;/).map((s) => s.trim()).filter(Boolean) : [],
    retencoes: {
      inss: retencao(/INSS\D{0,30}([\d.]+,\d{2})/i),
      irrf: retencao(/IRRF\D{0,30}([\d.]+,\d{2})/i),
      csrf: retencao(/CSRF\D{0,30}([\d.]+,\d{2})/i),
      iss: retencao(/ISS\s*RETIDO\D{0,30}([\d.]+,\d{2})/i),
    },
  };
}
