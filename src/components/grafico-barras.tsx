import { moeda } from "@/lib/formato";

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
export const rotuloMes = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;

/**
 * Barras verticais de uma única série (sem legenda: o título do cartão nomeia a
 * série). Dica nativa ao passar o mouse; a tabela ao lado traz os mesmos dados.
 */
export function GraficoBarras({ dados, titulo }: { dados: { rotulo: string; valor: number; detalhe?: string }[]; titulo: string }) {
  if (dados.length === 0) return null;
  const W = 640;
  const H = 200;
  const topo = 16;
  const base = H - 26;
  const max = Math.max(...dados.map((d) => d.valor)) || 1;
  const passo = W / dados.length;
  const larg = Math.min(36, passo * 0.6);
  const grade = [0.5, 1].map((f) => ({ y: base - (base - topo) * f, v: max * f }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={titulo}>
      {grade.map((g) => (
        <g key={g.y}>
          <line x1={0} x2={W} y1={g.y} y2={g.y} stroke="#e2e8f0" strokeWidth={1} />
          <text x={0} y={g.y - 3} fontSize={10} fill="#64748b">
            {moeda(g.v)}
          </text>
        </g>
      ))}
      <line x1={0} x2={W} y1={base} y2={base} stroke="#cbd5e1" strokeWidth={1} />
      {dados.map((d, i) => {
        const h = Math.max(2, ((base - topo) * d.valor) / max);
        const x = i * passo + (passo - larg) / 2;
        const y = base - h;
        const r = Math.min(4, larg / 2, h);
        return (
          <g key={d.rotulo} className="group">
            <title>{`${d.rotulo}: ${moeda(d.valor)}${d.detalhe ? ` · ${d.detalhe}` : ""}`}</title>
            <rect x={i * passo} y={topo} width={passo} height={base - topo} fill="transparent" />
            <path
              d={`M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + larg - r} Q${x + larg},${y} ${x + larg},${y + r} V${base} Z`}
              className="fill-marca-500 group-hover:fill-marca-700"
            />
            <text x={i * passo + passo / 2} y={H - 8} fontSize={10} fill="#64748b" textAnchor="middle">
              {d.rotulo}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
