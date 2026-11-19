// Período de vencimento da tela "Contas a pagar": atalhos (hoje, semana, mês…) viram um intervalo de/até.
// Funções puras: usadas no servidor (consulta) e no navegador (setas e menu).

export type TipoPeriodo = "hoje" | "semana" | "mes" | "ano" | "30d" | "12m" | "todos" | "personalizado";
export type Periodo = { tipo: TipoPeriodo; de: string; ate: string; rotulo: string };

export const OPCOES_PERIODO: { tipo: TipoPeriodo; rotulo: string }[] = [
  { tipo: "hoje", rotulo: "Hoje" },
  { tipo: "semana", rotulo: "Esta semana" },
  { tipo: "mes", rotulo: "Este mês" },
  { tipo: "ano", rotulo: "Este ano" },
  { tipo: "30d", rotulo: "Últimos 30 dias" },
  { tipo: "12m", rotulo: "Últimos 12 meses" },
  { tipo: "todos", rotulo: "Todo o período" },
];

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const d = (iso: string) => new Date(iso + "T12:00:00Z");
const iso = (x: Date) => x.toISOString().slice(0, 10);
const dias = (s: string, n: number) => {
  const x = d(s);
  x.setUTCDate(x.getUTCDate() + n);
  return iso(x);
};
/** Soma meses mantendo o dia (31/01 + 1 mês = 28 ou 29/02). */
const meses = (s: string, n: number) => {
  const [a, m, dia] = s.split("-").map(Number);
  const ultimo = new Date(Date.UTC(a, m - 1 + n + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(a, m - 1 + n, Math.min(dia, ultimo), 12)));
};
const fimDoMes = (s: string) => iso(new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0, 12)));
const br = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const brCurto = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const valida = (s: string | undefined) => (s && ISO.test(s) && !Number.isNaN(d(s).getTime()) ? s : "");

/** Monta o período a partir do tipo e de uma data de referência (o "agora" daquele período). */
export function periodoDe(tipo: TipoPeriodo, ref: string, hoje: string, de = "", ate = ""): Periodo {
  switch (tipo) {
    case "hoje":
      return { tipo, de: ref, ate: ref, rotulo: ref === hoje ? "Hoje" : br(ref) };
    case "semana": {
      const dow = (d(ref).getUTCDay() + 6) % 7; // segunda = 0
      const ini = dias(ref, -dow), fim = dias(ini, 6);
      return { tipo, de: ini, ate: fim, rotulo: `${brCurto(ini)} a ${br(fim)}` };
    }
    case "mes": {
      const ini = ref.slice(0, 8) + "01";
      return { tipo, de: ini, ate: fimDoMes(ini), rotulo: `${MESES[Number(ref.slice(5, 7)) - 1]} de ${ref.slice(0, 4)}` };
    }
    case "ano":
      return { tipo, de: `${ref.slice(0, 4)}-01-01`, ate: `${ref.slice(0, 4)}-12-31`, rotulo: ref.slice(0, 4) };
    case "30d": {
      const ini = dias(ref, -29);
      return { tipo, de: ini, ate: ref, rotulo: ref === hoje ? "Últimos 30 dias" : `${br(ini)} a ${br(ref)}` };
    }
    case "12m": {
      const ini = dias(meses(ref, -12), 1);
      return { tipo, de: ini, ate: ref, rotulo: ref === hoje ? "Últimos 12 meses" : `${br(ini)} a ${br(ref)}` };
    }
    case "todos":
      return { tipo, de: "", ate: "", rotulo: "Todo o período" };
    case "personalizado": {
      const rotulo = de && ate ? (de === ate ? br(de) : `${br(de)} a ${br(ate)}`) : de ? `A partir de ${br(de)}` : `Até ${br(ate)}`;
      return { tipo, de, ate, rotulo };
    }
  }
}

/** Lê o período do endereço. Aceita os endereços antigos (?mes=AAAA-MM ou ?mes=todos). */
export function lerPeriodo(sp: { periodo?: string; mes?: string; de?: string; ate?: string }, hoje: string, padrao: "mes" | "todos" = "mes"): Periodo {
  const de = valida(sp.de), ate = valida(sp.ate);
  const tipo = OPCOES_PERIODO.some((o) => o.tipo === sp.periodo) || sp.periodo === "personalizado" ? (sp.periodo as TipoPeriodo) : "";
  if (tipo === "todos") return periodoDe("todos", hoje, hoje);
  if (tipo === "personalizado") {
    if (!de && !ate) return periodoDe("mes", hoje, hoje);
    return de && ate && de > ate ? periodoDe("personalizado", hoje, hoje, ate, de) : periodoDe("personalizado", hoje, hoje, de, ate);
  }
  if (tipo) {
    // A referência é o fim (períodos "últimos") ou o início do intervalo
    const ref = (tipo === "30d" || tipo === "12m" ? ate : de) || hoje;
    return periodoDe(tipo, ref, hoje);
  }
  if (sp.mes === "todos") return periodoDe("todos", hoje, hoje);
  if (sp.mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.mes)) return periodoDe("mes", `${sp.mes}-01`, hoje);
  if (de || ate) return periodoDe("personalizado", hoje, hoje, de && ate && de > ate ? ate : de, de && ate && de > ate ? de : ate);
  return periodoDe(padrao, hoje, hoje);
}

/** Período anterior (-1) ou seguinte (+1), do mesmo tamanho. "Todo o período" não anda. */
export function deslocarPeriodo(p: Periodo, delta: 1 | -1, hoje: string): Periodo | null {
  switch (p.tipo) {
    case "hoje":
      return periodoDe("hoje", dias(p.de, delta), hoje);
    case "semana":
      return periodoDe("semana", dias(p.de, 7 * delta), hoje);
    case "mes":
      return periodoDe("mes", meses(p.de, delta), hoje);
    case "ano":
      return periodoDe("ano", meses(p.de, 12 * delta), hoje);
    case "30d":
      return periodoDe("30d", dias(p.ate, 30 * delta), hoje);
    case "12m":
      return periodoDe("12m", meses(p.ate, 12 * delta), hoje);
    case "personalizado": {
      if (!p.de || !p.ate) return null;
      const n = Math.round((d(p.ate).getTime() - d(p.de).getTime()) / 86400000) + 1;
      return periodoDe("personalizado", hoje, hoje, dias(p.de, n * delta), dias(p.ate, n * delta));
    }
    case "todos":
      return null;
  }
}

/** Parâmetros do endereço que representam o período. */
export function paramsPeriodo(p: Periodo): Record<string, string> {
  return { periodo: p.tipo, de: p.de, ate: p.ate, mes: "" };
}
