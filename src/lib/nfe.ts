import { XMLParser } from "fast-xml-parser";

export type NotaLida = {
  nota: {
    chave: string | null;
    numero: string | null;
    serie: string | null;
    data_emissao: string;
    emitente_cnpj: string | null;
    emitente_nome: string;
    emitente_uf: string | null;
    valor_produtos: number | null;
    valor_frete: number | null;
    valor_desconto: number | null;
    valor_total: number | null;
  };
  itens: {
    numero_item: number;
    codigo: string | null;
    descricao: string;
    descricao_normalizada: string;
    ncm: string | null;
    unidade: string | null;
    quantidade: number;
    valor_unitario: number;
    valor_total: number;
  }[];
};

/** Normaliza a descrição para agrupar itens parecidos (minúsculas, sem acento/pontuação). */
export function normalizarDescricao(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9,.\s]/g, " ")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false, // mantém códigos/CNPJ como texto (zeros à esquerda)
  processEntities: false, // sem entidades externas
  trimValues: true,
});

const n = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(String(v)));
const s = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
const lista = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * Lê um XML de NF-e (modelo 55/65, com ou sem nfeProc). Retorna null quando o
 * arquivo não é uma NF-e reconhecível.
 */
export function lerNFe(xml: string): NotaLida | null {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }
  type No = Record<string, unknown>;
  const raiz = (doc.nfeProc as No | undefined) ?? doc;
  const nfe = (raiz.NFe as No | undefined) ?? (doc.NFe as No | undefined);
  const inf = nfe?.infNFe as No | undefined;
  if (!inf) return null;

  const ide = (inf.ide ?? {}) as No;
  const emit = (inf.emit ?? {}) as No;
  const ender = (emit.enderEmit ?? {}) as No;
  const tot = (((inf.total ?? {}) as No).ICMSTot ?? {}) as No;
  const prot = ((raiz.protNFe as No | undefined)?.infProt ?? {}) as No;

  const chave = s(prot.chNFe) ?? s(inf["@Id"])?.replace(/^NFe/, "") ?? null;
  const emissao = s(ide.dhEmi) ?? s(ide.dEmi);
  if (!emissao) return null;

  const itens = lista(inf.det as No | No[]).map((det, i) => {
    const prod = (det.prod ?? {}) as No;
    const descricao = s(prod.xProd) ?? "";
    return {
      numero_item: Number(det["@nItem"] ?? i + 1),
      codigo: s(prod.cProd),
      descricao,
      descricao_normalizada: normalizarDescricao(descricao),
      ncm: s(prod.NCM),
      unidade: s(prod.uCom)?.toUpperCase() ?? null,
      quantidade: n(prod.qCom) ?? 0,
      valor_unitario: n(prod.vUnCom) ?? 0,
      valor_total: n(prod.vProd) ?? 0,
    };
  });
  if (itens.length === 0 || itens.some((i) => !i.descricao || !(i.quantidade > 0))) return null;

  return {
    nota: {
      chave: chave && /^\d{44}$/.test(chave) ? chave : null,
      numero: s(ide.nNF),
      serie: s(ide.serie),
      data_emissao: emissao.slice(0, 10),
      emitente_cnpj: s(emit.CNPJ) ?? s(emit.CPF),
      emitente_nome: s(emit.xNome) ?? s(emit.xFant) ?? "Emitente não informado",
      emitente_uf: s(ender.UF),
      valor_produtos: n(tot.vProd),
      valor_frete: n(tot.vFrete),
      valor_desconto: n(tot.vDesc),
      valor_total: n(tot.vNF),
    },
    itens,
  };
}
