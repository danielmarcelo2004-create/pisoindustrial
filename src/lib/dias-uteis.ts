// Dias úteis com feriados nacionais (fixos + móveis a partir da Páscoa).
// Só nacionais: feriados estaduais e municipais não entram.

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
function pascoa(ano: number): Date {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const somar = (d: Date, dias: number) => new Date(d.getTime() + dias * 86400000);

const cache = new Map<number, Map<string, string>>();

/** Feriados nacionais do ano: data ISO → nome. */
function feriadosNacionais(ano: number): Map<string, string> {
  const pronto = cache.get(ano);
  if (pronto) return pronto;
  const p = pascoa(ano);
  const fixos: [string, string][] = [
    ["01-01", "Confraternização Universal"],
    ["04-21", "Tiradentes"],
    ["05-01", "Dia do Trabalho"],
    ["09-07", "Independência do Brasil"],
    ["10-12", "Nossa Senhora Aparecida"],
    ["11-02", "Finados"],
    ["11-15", "Proclamação da República"],
    ["11-20", "Dia da Consciência Negra"],
    ["12-25", "Natal"],
  ];
  const mapa = new Map<string, string>(fixos.map(([md, nome]) => [`${ano}-${md}`, nome]));
  mapa.set(iso(somar(p, -48)), "Carnaval");
  mapa.set(iso(somar(p, -47)), "Carnaval");
  mapa.set(iso(somar(p, -2)), "Sexta-feira Santa");
  mapa.set(iso(somar(p, 60)), "Corpus Christi");
  cache.set(ano, mapa);
  return mapa;
}

/** Motivo de a data não ser dia útil (sábado, domingo ou nome do feriado) ou null se for dia útil. */
export function motivoNaoUtil(dataIso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataIso)) return null;
  const d = new Date(dataIso + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  const dia = d.getUTCDay();
  if (dia === 6) return "sábado";
  if (dia === 0) return "domingo";
  const f = feriadosNacionais(d.getUTCFullYear()).get(dataIso);
  return f ? `feriado (${f})` : null;
}

/** Próximo dia útil a partir da data (ela mesma, se já for útil). */
export function proximoDiaUtil(dataIso: string): string {
  let d = new Date(dataIso + "T12:00:00Z");
  for (let i = 0; i < 15 && motivoNaoUtil(iso(d)); i++) d = somar(d, 1);
  return iso(d);
}
