// Sugestão de parcelas a partir do texto de um boleto.
// Cada página de boleto é um boleto: vencimento seguido do valor do documento.
// Se o arquivo tiver mais de um boleto (uma página por boleto), cada um vira uma parcela.

export type ParcelasBoleto = { vencimentos: string[]; valores: number[] };

const numBR = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
const dataISO = (s: string) => s.split("/").reverse().join("-");

export function extrairParcelasPorPagina(paginas: string[]): ParcelasBoleto | null {
  const vencimentos: string[] = [];
  const valores: number[] = [];
  for (const pagina of paginas) {
    const t = pagina.replace(/\s+/g, " ");
    // Só páginas de boleto (têm o rótulo VENCIMENTO).
    if (!/vencimento/i.test(t)) continue;
    // Vencimento: a primeira data da ficha. Valor do documento: o valor que mais se repete na ficha
    // (aparece em "valor do documento" e "valor cobrado"; multa e juros aparecem menos vezes).
    const datas = [...t.matchAll(/\b(\d{2}\/\d{2}\/\d{4})\b/g)].map((m) => m[1]);
    const dinheiro = [...t.matchAll(/\b(\d{1,3}(?:\.\d{3})*,\d{2})\b/g)].map((m) => numBR(m[1]));
    if (datas.length === 0 || dinheiro.length === 0) continue;
    const cont = new Map<number, number>();
    dinheiro.forEach((v) => cont.set(v, (cont.get(v) ?? 0) + 1));
    const valor = [...cont.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    vencimentos.push(dataISO(datas[0]));
    valores.push(valor);
  }
  if (vencimentos.length < 2) return null;
  return { vencimentos, valores };
}
