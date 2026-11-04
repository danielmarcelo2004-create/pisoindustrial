import "server-only";
import { createClient } from "@/lib/supabase/server";

export type FiltrosCompras = {
  material?: string;
  fornecedor?: string;
  obra?: string;
  cidade?: string;
  uf?: string;
  de?: string;
  ate?: string;
};

const limpo = (s?: string) => (s ?? "").trim().replace(/[%,()*\\]/g, " ").trim();

export async function itensCompras(f: FiltrosCompras) {
  const supabase = await createClient();
  let q = supabase.from("compras_itens").select("*").order("data_emissao", { ascending: false }).limit(20000);
  const mat = limpo(f.material);
  if (mat) q = q.or(`descricao.ilike.%${mat}%,descricao_normalizada.ilike.%${mat}%`);
  const forn = limpo(f.fornecedor);
  if (forn) {
    const dig = forn.replace(/\D/g, "");
    q = q.or(`fornecedor_nome.ilike.%${forn}%${dig.length >= 4 ? `,fornecedor_cnpj.like.%${dig}%` : ""}`);
  }
  if (f.obra && /^[0-9a-f-]{36}$/i.test(f.obra)) q = q.eq("obra_id", f.obra);
  const cid = limpo(f.cidade);
  if (cid) q = q.ilike("cidade", `%${cid}%`);
  if (f.uf && /^[A-Z]{2}$/.test(f.uf)) q = q.eq("uf", f.uf);
  if (f.de && /^\d{4}-\d{2}-\d{2}$/.test(f.de)) q = q.gte("data_emissao", f.de);
  if (f.ate && /^\d{4}-\d{2}-\d{2}$/.test(f.ate)) q = q.lte("data_emissao", f.ate);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((i) => ({
    ...i,
    quantidade: Number(i.quantidade),
    valor_unitario: Number(i.valor_unitario),
    valor_total: Number(i.valor_total),
  }));
}

export type ItemCompra = Awaited<ReturnType<typeof itensCompras>>[number];

function mediana(v: number[]) {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const chaveMaterial = (i: { descricao_normalizada: string | null; unidade: string | null }) =>
  `${i.descricao_normalizada ?? ""}|${i.unidade ?? ""}`;

export type GrupoMaterial = {
  chave: string;
  descricao: string;
  unidade: string | null;
  compras: number;
  quantidade: number;
  valorTotal: number;
  precoMin: number;
  precoMax: number;
  precoMedio: number; // ponderado pela quantidade
  precoMediana: number;
  ultimoPreco: number;
  ultimaData: string;
  fornecedores: number;
  locais: number;
  variacao: number; // (max/min - 1)
};

/** Agrupa por descrição normalizada + unidade (indicador, não prova de equivalência técnica). */
export function agruparMateriais(itens: ItemCompra[]): GrupoMaterial[] {
  const mapa = new Map<string, ItemCompra[]>();
  for (const i of itens) {
    const k = chaveMaterial(i);
    const l = mapa.get(k) ?? [];
    l.push(i);
    mapa.set(k, l);
  }
  return [...mapa.entries()]
    .map(([chave, l]) => {
      const precos = l.map((i) => i.valor_unitario);
      const qtd = l.reduce((s, i) => s + i.quantidade, 0);
      const valor = l.reduce((s, i) => s + i.valor_total, 0);
      const ultimo = [...l].sort((a, b) => b.data_emissao.localeCompare(a.data_emissao))[0];
      const min = Math.min(...precos);
      const max = Math.max(...precos);
      return {
        chave,
        descricao: ultimo.descricao,
        unidade: ultimo.unidade,
        compras: l.length,
        quantidade: qtd,
        valorTotal: valor,
        precoMin: min,
        precoMax: max,
        precoMedio: qtd > 0 ? l.reduce((s, i) => s + i.valor_unitario * i.quantidade, 0) / qtd : 0,
        precoMediana: mediana(precos),
        ultimoPreco: ultimo.valor_unitario,
        ultimaData: ultimo.data_emissao,
        fornecedores: new Set(l.map((i) => i.fornecedor_cnpj ?? i.fornecedor_nome)).size,
        locais: new Set(l.map((i) => `${i.cidade}/${i.uf}`)).size,
        variacao: min > 0 ? max / min - 1 : 0,
      };
    })
    .sort((a, b) => b.valorTotal - a.valorTotal);
}

export const LIMIAR_ALERTA = 0.15;

/** Compras com preço unitário acima da mediana do mesmo material/unidade (mín. 3 compras). */
export function alertasPreco(itens: ItemCompra[], grupos: GrupoMaterial[]) {
  const porChave = new Map(grupos.map((g) => [g.chave, g]));
  return itens
    .map((i) => {
      const g = porChave.get(chaveMaterial(i));
      if (!g || g.compras < 3 || g.precoMediana <= 0) return null;
      const diferenca = i.valor_unitario / g.precoMediana - 1;
      return diferenca > LIMIAR_ALERTA ? { item: i, mediana: g.precoMediana, diferenca } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.diferenca - a.diferenca);
}

export function porFornecedor(itens: ItemCompra[]) {
  const m = new Map<string, { nome: string; cnpj: string | null; valor: number; notas: Set<string> }>();
  for (const i of itens) {
    const k = i.fornecedor_cnpj ?? i.fornecedor_nome ?? "";
    const r = m.get(k) ?? { nome: i.fornecedor_nome ?? "", cnpj: i.fornecedor_cnpj, valor: 0, notas: new Set() };
    r.valor += i.valor_total;
    r.notas.add(i.nota_id ?? "");
    m.set(k, r);
  }
  return [...m.values()].map((r) => ({ ...r, notas: r.notas.size })).sort((a, b) => b.valor - a.valor);
}

/** Preço médio ponderado por mês (AAAA-MM). */
export function evolucaoMensal(itens: ItemCompra[]) {
  const m = new Map<string, { q: number; v: number; n: number }>();
  for (const i of itens) {
    const k = i.data_emissao.slice(0, 7);
    const r = m.get(k) ?? { q: 0, v: 0, n: 0 };
    r.q += i.quantidade;
    r.v += i.valor_unitario * i.quantidade;
    r.n += 1;
    m.set(k, r);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mes, r]) => ({ mes, preco: r.q ? r.v / r.q : 0, compras: r.n }));
}

/** Preço médio ponderado por cidade/UF. */
export function porRegiao(itens: ItemCompra[]) {
  const m = new Map<string, { q: number; v: number; n: number }>();
  for (const i of itens) {
    const k = `${i.cidade}/${i.uf}`;
    const r = m.get(k) ?? { q: 0, v: 0, n: 0 };
    r.q += i.quantidade;
    r.v += i.valor_unitario * i.quantidade;
    r.n += 1;
    m.set(k, r);
  }
  return [...m.entries()].map(([local, r]) => ({ local, preco: r.q ? r.v / r.q : 0, compras: r.n })).sort((a, b) => a.preco - b.preco);
}
