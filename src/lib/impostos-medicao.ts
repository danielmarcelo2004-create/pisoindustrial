// Cálculo de impostos de notas de medição (emitidas pela empresa).
//   imposto retido  = valor total da nota − valor líquido
//   imposto devido  = 14% do valor total − imposto retido
//   % retido        = imposto retido ÷ valor total
//   % devido        = imposto devido ÷ valor total
// Valores em reais arredondados a centavos; percentuais com duas casas.

export const TAXA_IMPOSTO_DEVIDO = 0.14;

export type CalculoImpostos = {
  total: number;
  liquido: number;
  retido: number;
  devido: number;
  percRetido: number;
  percDevido: number;
};

const arredonda2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function calcularImpostosMedicao(total: number | null | undefined, liquido: number | null | undefined): CalculoImpostos | null {
  if (total === null || total === undefined || liquido === null || liquido === undefined) return null;
  if (!(total > 0) || liquido < 0 || liquido > total) return null;
  const retido = arredonda2(total - liquido);
  const devido = arredonda2(arredonda2(total * TAXA_IMPOSTO_DEVIDO) - retido);
  return {
    total,
    liquido,
    retido,
    devido,
    percRetido: arredonda2((retido / total) * 100),
    percDevido: arredonda2((devido / total) * 100),
  };
}
