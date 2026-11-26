// Séries de provisões: repetição de um pagamento ou provisão de vários meses, numeradas "Descrição (k/N)".
// Identifica a última parcela de cada série para avisar e oferecer "adicionar mais parcelas".

type ProvisaoSerie = {
  id: string;
  descricao: string;
  status: string;
  vencimento: string | null;
  created_by: string;
  pagamento_origem_id: string | null;
  /** Identificador próprio da série (as antigas sem ele são agrupadas pelo texto). */
  serie_id?: string | null;
  obra?: { id: string; nome?: string } | null;
};

const NUMERO = / \((\d+)\/(\d+)\)$/;

export function numeroParcela(descricao: string): { k: number; total: number; base: string } | null {
  const m = descricao.match(NUMERO);
  return m ? { k: Number(m[1]), total: Number(m[2]), base: descricao.replace(NUMERO, "") } : null;
}

export type SerieNaUltima<T> = { ultima: T; base: string; total: number };

/**
 * Para cada série: a última parcela (k = N) e se ela é a única ainda em aberto
 * ("chegou na última parcela" → avisar e perguntar se deseja adicionar mais).
 */
export function analisarSeries<T extends ProvisaoSerie>(lista: T[]) {
  const grupos = new Map<string, { itens: { p: T; k: number }[]; total: number; base: string }>();
  for (const p of lista) {
    const n = numeroParcela(p.descricao);
    if (!n) continue;
    const chave = p.serie_id ?? [p.obra?.id ?? "", p.created_by, p.pagamento_origem_id ?? "", n.base, n.total].join("|");
    const g = grupos.get(chave) ?? { itens: [], total: n.total, base: n.base };
    g.itens.push({ p, k: n.k });
    grupos.set(chave, g);
  }
  const ultimas = new Set<string>();
  const naUltima: SerieNaUltima<T>[] = [];
  for (const g of grupos.values()) {
    const ultima = g.itens.find((i) => i.k === g.total);
    if (!ultima) continue;
    ultimas.add(ultima.p.id);
    const abertas = g.itens.filter((i) => i.p.status === "provisionada");
    if (abertas.length === 1 && abertas[0].p.id === ultima.p.id) naUltima.push({ ultima: ultima.p, base: g.base, total: g.total });
  }
  return { ultimas, naUltima };
}
