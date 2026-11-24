// Contas a receber: "+ Nova receita" manual e nota de medição › "Lançar receita e impostos" (receita total,
// imposto retido a pagar, devido pago na baixa manual). Na conciliação, a entrada líquida é sugerida como
// "receita − retido" e um clique baixa as duas. Também: Provisões sem rolagem lateral e com filtros. Dados fictícios.
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
const ir = async (p, url) => { await p.goto(BASE + url); await p.waitForLoadState('networkidle'); };

(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);
  const obraA = (await um(admin.from('obras').select('id, nome, cliente').eq('fluxo', 'A').limit(1).single()));
  const fin = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
  await um(admin.from('categorias').insert([{ nome: 'Medição de obra', tipo: 'receita' }, { nome: 'Impostos e taxas', tipo: 'despesa' }]));
  const bb = (await um(admin.from('contas_bancarias').insert({ nome: 'BB Fictício', banco: '001', agencia: '', conta: '777888X', created_by: fin }).select('id').single())).id;

  await passo('Contas a receber › "+ Nova receita" (janela) › receita em aberto', async () => {
    await ir(p, '/recebimentos?periodo=todos');
    await p.getByRole('button', { name: '+ Nova receita' }).click();
    const d = p.getByRole('dialog', { name: 'Nova receita' });
    await d.locator('input[name=descricao]').fill('Aporte fictício');
    await d.locator('select[name=obra_id]').selectOption(obraA.id);
    confere((await d.locator('input[name=cliente]').inputValue()) === (obraA.cliente ?? ''), 'cliente não veio da obra');
    if (!obraA.cliente) await d.locator('input[name=cliente]').fill('Sócio');
    await d.locator('input[name=valor]').fill('5.000,00');
    await d.locator('input[name=vencimento]').fill(hoje);
    await Promise.all([p.waitForURL(/\/recebimentos\/[0-9a-f-]{36}\?criada=1/), d.getByRole('button', { name: 'Lançar receita' }).click()]);
    await ir(p, '/recebimentos?periodo=todos');
    const t = await p.locator('[data-cartao="avencer"], [data-cartao="hoje"]').allInnerTexts();
    confere(t.join(' ').includes('5.000,00'), t.join(' | '));
  });

  let rec = '';
  await passo('Nota de medição › "Lançar receita" mostra o cálculo (retido 600, devido 14% = 800) e lança receita + impostos', async () => {
    await um(admin.from('notas_medicao').insert({ obra_id: obraA.id, storage_path: `${obraA.id}/medicoes/e2e-${Date.now()}.pdf`, nome_arquivo: 'medicao-12.pdf', numero: '12', sha256: 'e'.repeat(64), valor: 10000, valor_liquido: 9400, data_emissao: hoje, criada_por: fin }));
    await ir(p, '/notas-medicao');
    await p.getByRole('button', { name: 'Lançar receita' }).first().click();
    const d = p.getByRole('dialog', { name: 'Lançar receita e impostos' });
    const calc = await d.locator('[data-calculo-medicao]').innerText();
    const ret = await d.locator('input[aria-label="Imposto retido"]').inputValue();
    const dev = await d.locator('input[aria-label="Imposto devido"]').inputValue();
    confere(/10\.000,00/.test(calc) && ret === '600,00' && dev === '800,00' && /9\.400,00/.test(calc), `${ret} / ${dev} / ${calc.replace(/\s+/g, ' ')}`);
    await d.locator('select[name=conta_id]').selectOption(bb);
    await d.locator('input[aria-label="Imposto devido"]').fill('750,00'); // valores editáveis
    // Regressão: a janela abria dentro de uma célula sem quebra de linha e o conteúdo passava da borda (cortado)
    const corta = await d.evaluate((el) => { const f = el.querySelector('form'); return f.scrollWidth > f.clientWidth + 1; });
    confere(!corta, 'regressão: a janela "Lançar receita e impostos" está cortando o conteúdo');
    await p.screenshot({ path: path.join(DIR, 'med-lancar.png'), fullPage: false });
    await d.getByRole('button', { name: 'Lançar receita e impostos' }).click();
    await p.waitForURL(/\/recebimentos\/[0-9a-f-]{36}\?criada=1/, { timeout: 20000 }).catch(async () => { throw new Error('ficou na janela: ' + (await d.innerText()).slice(-200).replace(/\s+/g, ' ')); });
    rec = p.url().match(/recebimentos\/([0-9a-f-]{36})/)[1];
    const imp = await p.locator('[data-impostos-medicao]').innerText();
    confere(/retido/.test(imp) && /devido/.test(imp) && /600,00/.test(imp) && /750,00/.test(imp), imp.replace(/\s+/g, ' '));
    await p.screenshot({ path: path.join(DIR, 'med-recebimento.png'), fullPage: true });
  });

  await passo('Conciliação: entrada de R$ 9.400 sugerida como "receita − retido" › Conciliar › receita recebida e retido pago', async () => {
    const imp = (await um(admin.from('extrato_importacoes').insert({ conta_id: bb, arquivo: 'e2e.ofx', created_by: fin }).select('id').single())).id;
    await um(admin.from('extrato_linhas').insert({ conta_id: bb, importacao_id: imp, data: hoje, valor: 9400, tipo: 'CREDIT', descricao: 'TED RECEBIDA MEDICAO 12', fitid: 'M1' }));
    await ir(p, `/contas-bancarias?conta=${bb}`);
    const l = p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: 'MEDICAO 12' }) });
    confere(await l.locator('[data-sugestao="receita"]').count() === 1, 'sem sugestão da receita');
    confere(/imposto retido/.test(await l.locator('[data-receita-sugerida]').innerText()), 'sem "− retido"');
    await p.screenshot({ path: path.join(DIR, 'med-conciliacao.png'), fullPage: false });
    await l.locator('[data-conciliar-novo]').click();
    await p.waitForTimeout(1500); await p.waitForLoadState('networkidle');
    const r = await um(admin.from('recebimentos').select('status').eq('id', rec).single());
    const ret = await um(admin.from('pagamentos').select('status').eq('recebimento_id', rec).eq('imposto_medicao', 'retido').single());
    confere(r.status === 'recebido' && ret.status === 'pago', `${r.status} / ${ret.status}`);
  });

  await passo('Conciliação: "🔍 Buscar lançamento" numa entrada pesquisa as receitas em aberto (aporte de R$ 5.000)', async () => {
    const imp = (await um(admin.from('extrato_importacoes').insert({ conta_id: bb, arquivo: 'e2e2.ofx', created_by: fin }).select('id').single())).id;
    await um(admin.from('extrato_linhas').insert({ conta_id: bb, importacao_id: imp, data: hoje, valor: 5000, tipo: 'CREDIT', descricao: 'TED RECEBIDA SOCIO', fitid: 'M2' }));
    await ir(p, `/contas-bancarias?conta=${bb}`);
    const l = p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: 'SOCIO' }) });
    if (await l.getByRole('button', { name: 'Não é esta receita' }).count()) await l.getByRole('button', { name: 'Não é esta receita' }).click(); // já vinha sugerida
    await l.getByRole('button', { name: /Buscar lançamento/ }).click();
    const d = p.getByRole('dialog', { name: 'Buscar receita' });
    await d.locator('input[aria-label="Pesquisar receita"]').fill('Aporte');
    await d.locator('li', { hasText: 'Aporte fictício' }).locator('input').check();
    await d.getByRole('button', { name: 'Conciliar' }).click();
    await d.waitFor({ state: 'detached', timeout: 20000 });
    const r = await um(admin.from('recebimentos').select('status').eq('descricao', 'Aporte fictício').single());
    confere(r.status === 'recebido', r.status);
  });

  await passo('Contas a receber: a medição aparece como Recebida', async () => {
    await ir(p, '/recebimentos?periodo=todos');
    const row = p.locator(`tr[data-linha="rec:${rec}"]`);
    confere(/Recebido ✓/.test(await row.innerText()), await row.innerText());
  });

  await passo('Provisões: sem rolagem lateral (1440px) e filtro por centro de custo/situação', async () => {
    await um(admin.from('provisoes').insert([{ obra_id: obraA.id, descricao: 'Provisão filtro A', vencimento: hoje, created_by: fin }]));
    await ir(p, '/provisoes');
    const rola = await p.evaluate(() => [...document.querySelectorAll('.overflow-x-auto')].some((e) => e.scrollWidth > e.clientWidth + 2));
    confere(!rola, 'tabela ainda rola para o lado');
    await p.screenshot({ path: path.join(DIR, 'prov-layout.png'), fullPage: true });
    await ir(p, `/provisoes?obra=${obraA.id}&ver=abertas&busca=filtro`);
    const linhas = await p.locator('tr[data-provisao]').count();
    confere(linhas === 1, `${linhas} linha(s)`);
  });

  console.log(`\nMedição e receita: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
