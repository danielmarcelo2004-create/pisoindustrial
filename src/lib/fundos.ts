import type { Cor } from "@/lib/rotulos";

export const STATUS_FUNDO: Record<string, { rotulo: string; cor: Cor }> = {
  em_andamento: { rotulo: "Em andamento", cor: "verde" },
  acabando: { rotulo: "Acabando", cor: "amarelo" },
  esgotado: { rotulo: "Esgotado", cor: "vermelho" },
  fechado: { rotulo: "Fechado", cor: "cinza" },
};

export const STATUS_GASTO: Record<string, { rotulo: string; cor: Cor }> = {
  pendente: { rotulo: "Aguardando administrador", cor: "amarelo" },
  aprovado: { rotulo: "Aprovado", cor: "verde" },
  recusado: { rotulo: "Recusado", cor: "vermelho" },
};

/** Mesmo cálculo do banco: saldo = valor menos os gastos aprovados. */
export function saldoDoFundo(valor: number, gastosAprovados: number[]) {
  return Math.round((valor - gastosAprovados.reduce((s, v) => s + v, 0)) * 100) / 100;
}

export async function sha256Hex(bytes: Uint8Array) {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
