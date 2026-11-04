// Cria o PRIMEIRO usuário do Financeiro (administrador geral).
// Uso: npm run criar-admin -- email@empresa.com.br "Nome Completo"
// Depois disso, todos os demais usuários são criados pelo próprio sistema.

import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const [email, ...nomePartes] = process.argv.slice(2);
const nome = nomePartes.join(" ").trim();
if (!email || !nome) {
  console.error('Uso: npm run criar-admin -- email@empresa.com.br "Nome Completo"');
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("Configure NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY no .env.local");
  process.exit(1);
}

const letras = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const pick = (s, n) => Array.from({ length: n }, () => s[randomInt(s.length)]).join("");
const senha = `${pick(letras, 4)}-${pick("23456789", 4)}-${pick(letras, 4)}`;

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await admin.auth.admin.createUser({ email: email.toLowerCase(), password: senha, email_confirm: true });
if (error) {
  console.error("Erro ao criar usuário:", error.message);
  process.exit(1);
}
const { error: e2 } = await admin.from("profiles").insert({
  id: data.user.id,
  nome,
  email: email.toLowerCase(),
  perfil: "financeiro",
  troca_senha_pendente: true,
});
if (e2) {
  await admin.auth.admin.deleteUser(data.user.id);
  console.error("Erro ao criar perfil:", e2.message);
  process.exit(1);
}

console.log("\nUsuário do Financeiro criado.");
console.log(`  Login: ${email.toLowerCase()}`);
console.log(`  Senha provisória: ${senha}`);
console.log("No primeiro acesso será solicitada a criação de uma senha própria.\n");
