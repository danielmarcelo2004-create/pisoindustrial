// Contas a pagar › Ações › "Excluir lançamento": janela com as opções do escopo (só o atual / não vencidos /
// em aberto / todos). Parcela excluída sai da despesa e o total diminui; despesa de repetição cancela as
// outras e as provisões. A janela não pode cortar nem passar da tela (1440px e 390px). Dados fictícios.
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
const mais = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };

let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };
async function entrar(b, email, width = 1440) {
  const p = await (await b.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', email); await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
  return p;
}
const ir = async (p, url) => { await p.goto(BASE + url); await p.waitForLoadState('networkidle'); };
const cabe = (dlg) => dlg.evaluate((el) => { const c = el.firstElementChild; const r = c.getBoundingClientRect(); return c.scrollWidth <= c.clientWidth + 1 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; });
async function abrir(p, chave) {
  await p.locator(`tr[data-linha="${chave}"]`).getByRole('button', { name: /Ações/ }).click();
  await p.getByRole('menuitem', { name: 'Excluir lançamento' }).click();
  const d = p.getByRole('dialog', { name: 'Excluir lançamento' });
  await d.waitFor();
  return d;
}

(async () => {
  const b = await chromium.launch();
  const obra = (await um(admin.from('obras').select('id, fluxo').eq('fluxo', 'C').limit(1))).at(0) ?? (await um(admin.from('obras').select('id, fluxo').limit(1)))[0];
  const fin = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
  const marca = `Excl-${Date.now() % 100000}`;
  const nova = async (favorecido, valor, vencimento) =>
    (await um(admin.from('pagamentos').insert({ obra_id: obra.id, favorecido, descricao: marca, valor, vencimento, forma_pagamento: 'boleto', status: 'aguardando_pagamento', fluxo: obra.fluxo, created_by: fin }).select('id').single())).id;
  // Parcelada em 3 (a 1ª venceu no mês passado, a 2ª vence hoje, a 3ª no mês que vem)
  const parc = await nova(`Parcelada ${marca}`, 600, hoje);
  await um(admin.from('pagamento_parcelas').insert([1, 2, 3].map((n) => ({ pagamento_id: parc, numero: n, valor_base: 200, vencimento: mais(hoje, n - 2) }))));
  const pcs = await um(admin.from('pagamento_parcelas').select('id, numero').eq('pagamento_id', parc).order('numero'));
  // Repetição: despesa de hoje + 2 provisões
  const rep = await nova(`Repetida ${marca}`, 300, hoje);
  await um(admin.from('provisoes').insert([1, 2].map((n) => ({ obra_id: obra.id, descricao: `${marca} (${n + 1}/3)`, vencimento: mais(hoje, n), valor_estimado: 300, pagamento_origem_id: rep, created_by: fin }))));
  const avulsa = await nova(`Avulsa ${marca}`, 80, hoje);
  const f = await entrar(b, 'financeiro@demo.local');
  const lista = `/pagamentos?periodo=todos&busca=${marca}`;

  await passo('regressão: janela com largura própria (não esticada); despesa avulsa: só "Somente o lançamento atual"; motivo obrigatório; janela cabe', async () => {
    await ir(f, lista);
    const d = await abrir(f, `pag:${avulsa}`);
    const opcoes = await d.locator('input[type=radio]').count();
    confere(opcoes === 1, `${opcoes} opções`);
    confere(await d.getByRole('button', { name: 'Excluir lançamento' }).isDisabled(), 'sem motivo e o botão já habilitado');
    confere(await cabe(d), 'janela cortando');
    // Regressão: a regra global de largura das janelas anulava o max-w-lg e a janela ocupava a tela toda
    const larg = await d.evaluate((el) => el.firstElementChild.getBoundingClientRect().width);
    confere(larg <= 520, `regressão: janela esticada (${Math.round(larg)}px)`);
    await d.getByRole('button', { name: 'Cancelar' }).click();
    await d.waitFor({ state: 'detached' });
    confere((await um(admin.from('pagamentos').select('status').eq('id', avulsa).single())).status === 'aguardando_pagamento', 'Cancelar excluiu');
  });

  await passo('parcelada: as 4 opções; "não vencidos" a partir da 2ª tira a 2ª e a 3ª e o total cai para R$ 200', async () => {
    await ir(f, lista);
    const d = await abrir(f, `parc:${pcs[1].id}`);
    const t = await d.innerText();
    confere(['Somente o lançamento atual', 'não vencidos que não possuam baixas', 'em aberto (vencidos + a vencer)', 'Todos os lançamentos'].every((x) => t.includes(x)), t.replace(/\s+/g, ' '));
    confere(await cabe(d), 'janela cortando');
    await d.getByLabel(/não vencidos/).check();
    await d.getByLabel('Motivo da exclusão').fill('Parcelamento renegociado');
    await f.screenshot({ path: path.join(DIR, 'excluir-1440.png') });
    await d.getByRole('button', { name: 'Excluir lançamento' }).click();
    await d.waitFor({ state: 'detached', timeout: 20000 });
    const resto = await um(admin.from('pagamento_parcelas').select('numero').eq('pagamento_id', parc));
    const p = await um(admin.from('pagamentos').select('valor, status').eq('id', parc).single());
    confere(resto.length === 1 && Number(p.valor) === 200 && p.status === 'aguardando_pagamento', `${resto.length} parcela(s), ${p.valor} ${p.status}`);
    await f.locator(`tr[data-linha="parc:${pcs[2].id}"]`).waitFor({ state: 'detached', timeout: 10000 }).catch(() => { throw new Error('parcela excluída ainda na lista'); });
  });

  await passo('repetição: "em aberto" cancela a despesa e as 2 provisões', async () => {
    await ir(f, lista);
    const d = await abrir(f, `pag:${rep}`);
    confere(await d.locator('input[type=radio]').count() === 4, 'sem as opções da repetição');
    await d.getByLabel(/em aberto \(vencidos/).check();
    await d.getByLabel('Motivo da exclusão').fill('Contrato encerrado');
    await d.getByRole('button', { name: 'Excluir lançamento' }).click();
    await d.waitFor({ state: 'detached', timeout: 20000 });
    const p = await um(admin.from('pagamentos').select('status').eq('id', rep).single());
    const pv = await um(admin.from('provisoes').select('status').eq('pagamento_origem_id', rep));
    confere(p.status === 'cancelado' && pv.every((x) => x.status === 'cancelada'), `${p.status} / ${pv.map((x) => x.status)}`);
  });

  await passo('página da despesa: o cartão "Cancelar pagamento" virou "Excluir lançamento" e abre a mesma janela', async () => {
    await ir(f, `/pagamentos/${avulsa}`);
    confere(await f.getByText('Cancelar este pagamento…').count() === 0, 'cartão antigo ainda aparece');
    await f.locator('main').getByRole('button', { name: 'Excluir lançamento' }).click();
    const d = f.getByRole('dialog', { name: 'Excluir lançamento' });
    confere(await cabe(d), 'janela cortando');
    await d.getByLabel('Motivo da exclusão').fill('Lançado em duplicidade');
    await d.getByRole('button', { name: 'Excluir lançamento' }).click();
    await d.waitFor({ state: 'detached', timeout: 20000 });
    confere((await um(admin.from('pagamentos').select('status').eq('id', avulsa).single())).status === 'cancelado', 'não excluiu');
  });

  await passo('celular (390px): a janela cabe na tela', async () => {
    const c = await entrar(b, 'financeiro@demo.local', 390);
    await ir(c, lista);
    const d = await abrir(c, `parc:${pcs[0].id}`);
    confere(await cabe(d), 'janela cortando no celular');
    await c.screenshot({ path: path.join(DIR, 'excluir-390.png') });
  });

  console.log(`\nExcluir lançamento: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
