import { randomInt } from "node:crypto";

export function validarSenha(s: string): string | null {
  if (s.length < 8) return "A senha deve ter pelo menos 8 caracteres.";
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return "A senha deve conter letras e números.";
  return null;
}

/** Senha provisória legível (sem caracteres ambíguos). */
export function gerarSenhaProvisoria(): string {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  const numeros = "23456789";
  const pick = (s: string, n: number) => Array.from({ length: n }, () => s[randomInt(s.length)]).join("");
  return `${pick(letras, 4)}-${pick(numeros, 4)}-${pick(letras, 4)}`;
}
