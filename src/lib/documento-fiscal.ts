// Validação dos dígitos verificadores de CPF e CNPJ (só para avisar; não bloqueia o cadastro).

const digitos = (s: string) => (s ?? "").replace(/\D/g, "");

function cpfValido(s: string): boolean {
  const d = digitos(s);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n: number) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(d[i]) * (n + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

function cnpjValido(s: string): boolean {
  const d = digitos(s);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (n: number) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((s, p, i) => s + Number(d[i]) * p, 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}

/** Mensagem de aviso para um CPF/CNPJ digitado, ou null se estiver vazio ou válido. */
export function avisoCpfCnpj(s: string): string | null {
  const d = digitos(s);
  if (!d) return null;
  if (d.length === 11) return cpfValido(d) ? null : "CPF inválido: os dígitos verificadores não conferem. Confira o número.";
  if (d.length === 14) return cnpjValido(d) ? null : "CNPJ inválido: os dígitos verificadores não conferem. Confira o número.";
  return "CPF deve ter 11 dígitos e CNPJ 14 dígitos. Confira o número.";
}
