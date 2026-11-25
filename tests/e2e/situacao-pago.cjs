// Contas a pagar: "Pago ✓" = baixa conciliada com o extrato; "Pago" + "baixa manual" = ainda sem conciliação.
// Dados fictícios.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const DIR = path.join(__dirname, '.saida');
fs.mkdirSync(DIR, { recursive: true });
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const um = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const b = await chromium.launch();
  const marca = `Sit-${Date.now() % 100000}`;
  const obra = (await um(admin.from('obras').select('id, fluxo').eq('fluxo', 'C').limit(1)))[0] ?? (await um(admin.from('obras').select('id, fluxo').limit(1)))[0];
  const fin = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
  const conta = (await um(admin.from('contas_bancarias').insert({ nome: `Conta ${marca}`, banco: '777', agencia: '1', conta: String(Date.now()).slice(-8), created_by: fin }).select('id').single())).id;
  const imp = (await um(admin.from('extrato_importacoes').insert({ conta_id: conta, arquivo: 'sit.ofx', created_by: fin }).select('id').single())).id;
  const linha = (await um(admin.from('extrato_linhas').insert({ conta_id: conta, importacao_id: imp, data: hoje, valor: -100, tipo: 'DEBIT', descricao: `PAGTO ${marca}`, fitid: marca, situacao: 'conciliada' }).select('id').single())).id;
  const pago = async (favorecido) => (await um(admin.from('pagamentos').insert({ obra_id: obra.id, favorecido, descricao: `Pago ${marca}`, valor: 100, vencimento: hoje, forma_pagamento: 'pix', status: 'pago', pago_em: hoje, valor_pago: 100, fluxo: obra.fluxo, created_by: fin, pago_por: fin }).select('id').single())).id;
  const conc = await pago(`Fornecedor conciliado ${marca}`);
  const man = await pago(`Fornecedor manual ${marca}`);
  await um(admin.from('conciliacao_itens').insert({ linha_id: linha, pagamento_id: conc, valor: 100, baixou: true, created_by: fin }));

  const entrar = async (email, width = 1440) => {
    const p = await (await b.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1.5 })).newPage();
    p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS [${email}] ${e.message.slice(0, 200)}`); });
    await p.goto(BASE + '/login'); await p.fill('input[name=email]', email); await p.fill('input[name=senha]', 'Demo-1234');
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);
    return p;
  };
  const url = `/pagamentos?periodo=todos&busca=${encodeURIComponent(marca)}`;
  const situacao = async (p, id) => {
    const cel = p.locator(`tr[data-linha="pag:${id}"] [data-pago-via]`);
    await cel.waitFor({ timeout: 15000 });
    return { tipo: await cel.getAttribute('data-pago-via'), texto: (await cel.innerText()).replace(/\s+/g, ' ').trim(), dica: await cel.getAttribute('title') };
  };

  await passo('Financeiro: conciliado = "Pago ✓"; baixa manual = "Pago" + "baixa manual" (sem ✓)', async () => {
    const f = await entrar('financeiro@demo.local');
    await f.goto(BASE + url); await f.waitForLoadState('networkidle');
    const c = await situacao(f, conc), m = await situacao(f, man);
    confere(c.tipo === 'conciliado' && c.texto === 'Pago ✓' && /Conciliado com o extrato/.test(c.dica), JSON.stringify(c));
    confere(m.tipo === 'manual' && /^Pago baixa manual$/.test(m.texto) && !m.texto.includes('✓') && /Baixa manual/.test(m.dica), JSON.stringify(m));
    await f.screenshot({ path: path.join(DIR, 'situacao-pago.png') });
  });

  await passo('Suprimentos também vê a diferença (o banco só informa "foi conciliado", sem expor o extrato)', async () => {
    const s = await entrar('suprimentos@demo.local');
    await s.goto(BASE + url); await s.waitForLoadState('networkidle');
    confere((await situacao(s, conc)).tipo === 'conciliado' && (await situacao(s, man)).tipo === 'manual', 'perfil sem acesso ao extrato não vê a diferença');
  });

  console.log(`\nSituação do pagamento: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
