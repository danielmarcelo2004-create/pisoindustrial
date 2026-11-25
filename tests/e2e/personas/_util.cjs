// Utilidades compartilhadas pelos testes das personas. Dados sempre fictícios; use `marca` para não colidir com outros testes.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const DIR = path.join(__dirname, '..', '.saida');
fs.mkdirSync(DIR, { recursive: true });
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const admin = createClient(URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const um = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const somarDias = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const marca = (p) => `${p}-${Date.now() % 1000000}`;
const confere = (c, m) => { if (!c) throw new Error(m); };

/** Cliente supabase-js autenticado (para criar dados de teste "como" um perfil, via RPC). */
async function cliente(perfil) {
  const c = createClient(URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email: `${perfil}@demo.local`, password: 'Demo-1234' });
  if (error) throw new Error(error.message);
  return c;
}

/** Roda um arquivo de persona: `executar({ b, passo, entrar })`. Sai com 1 se algum passo ou JS da página falhar. */
async function rodar(titulo, executar) {
  let ok = 0, tot = 0, errosJS = 0;
  const b = await chromium.launch();
  async function passo(nome, fn) {
    tot++;
    try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 400)}`); }
  }
  async function entrar(perfil, largura = 1440) {
    const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
    await p.goto(BASE + '/login'); await p.fill('input[name=email]', `${perfil}@demo.local`); await p.fill('input[name=senha]', 'Demo-1234');
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
    return p;
  }
  try { await executar({ b, passo, entrar }); } catch (e) { tot++; console.log(`✘ falha geral — ${e.message.slice(0, 400)}`); }
  console.log(`\n${titulo}: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && tot > 0 && errosJS === 0 ? 0 : 1);
}
const ir = async (p, url) => { await p.goto(BASE + url); await p.waitForLoadState('networkidle'); };
module.exports = { BASE, DIR, admin, um, hoje, somarDias, marca, confere, cliente, rodar, ir };
