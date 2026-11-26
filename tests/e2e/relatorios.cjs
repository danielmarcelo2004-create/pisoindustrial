// Relatórios: página limpa. Períodos prontos, filtros recolhidos, 4 indicadores, uma visão por vez (abas),
// filtros por clique com "x" para tirar, lista de lançamentos enxuta e sem rolagem lateral (1280px e 390px).
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
const semRolagem = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && ![...document.querySelectorAll('table')].some((t) => t.parentElement.scrollWidth > t.parentElement.clientWidth + 2));

(async () => {
  const b = await chromium.launch();
  const entrar = async (width) => {
    const p = await (await b.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1.5 })).newPage();
    p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS ${e.message.slice(0, 200)}`); });
    await p.goto(BASE + '/login'); await p.fill('input[name=email]', 'financeiro@demo.local'); await p.fill('input[name=senha]', 'Demo-1234');
    await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);
    return p;
  };
  const obras = await um(admin.from('obras').select('id, nome, fluxo').limit(2));
  const fin = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
  const marca = `Rel-${Date.now() % 100000}`;
  for (const [i, o] of obras.entries()) {
    await um(admin.from('pagamentos').insert({ obra_id: o.id, favorecido: `Fornecedor ${marca} ${i}`, descricao: `Despesa do relatório ${marca}`, valor: 1000 * (i + 1), vencimento: hoje, forma_pagamento: 'pix', status: 'aguardando_pagamento', fluxo: o.fluxo, created_by: fin }));
  }
  const p = await entrar(1280);

  await passo('abre no extrato do mês inteiro, com períodos prontos, filtros recolhidos, busca e 5 indicadores (receitas e despesas)', async () => {
    await p.goto(BASE + '/relatorios'); await p.waitForLoadState('networkidle');
    const chips = await p.locator('[data-filtros-relatorio] > div:nth-of-type(1) > a').allInnerTexts();
    confere(['Este mês', 'Mês passado', 'Últimos 3 meses', 'Este ano'].every((t, i) => chips[i] === t), chips.join(' | '));
    confere(await p.locator('[data-filtros-relatorio] a[aria-current="true"]').innerText() === 'Este mês', 'período ativo');
    confere((await p.locator('[data-filtros-relatorio] details').getAttribute('open')) === null, 'filtros deveriam estar recolhidos');
    confere(await p.locator('[data-indicadores-extrato] > *').count() === 5, 'indicadores do extrato');
    confere(await p.locator('[data-busca-relatorio] input[name=busca]').count() === 1, 'sem a busca');
    const sub = await p.locator('main h1 + p, main header p').first().innerText().catch(() => '');
    const fimMes = new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7), 0)).toISOString().slice(8, 10);
    confere(new RegExp(`${fimMes}/${hoje.slice(5, 7)}/${hoje.slice(0, 4)}`).test(await p.locator('body').innerText()), 'o mês vai até o último dia (antes parava em hoje)');
    await p.screenshot({ path: path.join(DIR, 'relatorios-resumo.png'), fullPage: true });
  });

  await passo('uma visão por vez: Resumo mostra os maiores; cada aba traz uma tabela só', async () => {
    await p.goto(BASE + '/relatorios?ver=resumo'); await p.waitForLoadState('networkidle');
    confere(await p.locator('[data-indicadores-relatorio] > *').count() === 4, 'indicadores das despesas');
    confere(await p.locator('table').count() === 0, 'o Resumo não deve ter tabelas empilhadas');
    confere(await p.getByText('Maiores centros de custo').count() === 1 && await p.getByText('Maiores categorias').count() === 1, 'listas dos maiores');
    const abas = await p.locator('[data-abas-relatorio] a').allInnerTexts();
    confere(abas.join('|') === 'Extrato|Resumo das despesas|Centro de custo|Categoria|Fornecedor|Situação|Lançamentos', abas.join('|'));
    for (const nome of ['Centro de custo', 'Categoria', 'Fornecedor', 'Situação']) {
      await p.locator('[data-abas-relatorio]').getByRole('link', { name: nome, exact: true }).click();
      await p.locator('[data-abas-relatorio] a[aria-current="page"]', { hasText: nome }).waitFor({ timeout: 15000 });
      await p.waitForLoadState('networkidle');
      confere(await p.locator('table').count() === 1, `${nome}: deveria haver uma tabela só`);
      confere(await p.locator('[data-abas-relatorio] a[aria-current="page"]').innerText() === nome, `aba ${nome} não marcada`);
    }
  });

  await passo('clicar num centro de custo filtra e mostra o filtro com "x" para tirar', async () => {
    await p.goto(BASE + '/relatorios?ver=centro'); await p.waitForLoadState('networkidle');
    await p.locator('table[data-resumo="Centro de custo"]').getByRole('link', { name: obras[0].nome }).first().click();
    await p.waitForURL(/obra=/, { timeout: 15000 });
    await p.waitForLoadState('networkidle');
    confere(p.url().includes('obra='), p.url());
    const chip = p.locator('[data-filtros-ativos] a');
    confere(await chip.count() === 1 && (await chip.innerText()).includes(obras[0].nome), 'chip do filtro');
    await chip.click(); await p.waitForURL((u) => !u.search.includes('obra='), { timeout: 15000 }); await p.waitForLoadState('networkidle');
    confere(!p.url().includes('obra=') && await p.locator('[data-filtros-ativos]').count() === 0, 'o x não tirou o filtro');
  });

  await passo('Lançamentos: lista enxuta (5 colunas) com os pagamentos do período', async () => {
    await p.goto(BASE + '/relatorios?ver=lancamentos'); await p.waitForLoadState('networkidle');
    const cab = await p.locator('table[data-lancamentos] thead th').allInnerTexts();
    confere(cab.length === 5, cab.join(' | '));
    confere((await p.locator('table[data-lancamentos]').innerText()).includes(`Fornecedor ${marca} 0`), 'pagamento do teste não aparece');
    confere(await p.locator('table[data-lancamentos] tbody tr').count() <= 100, 'mais de 100 linhas');
  });

  await passo('"Mês passado" muda o período e a exportação leva os filtros', async () => {
    await p.goto(BASE + '/relatorios'); await p.waitForLoadState('networkidle');
    await p.getByRole('link', { name: 'Mês passado' }).click(); await p.waitForURL(/de=/, { timeout: 15000 }); await p.waitForLoadState('networkidle');
    confere(await p.locator('[data-filtros-relatorio] a[aria-current="true"]').innerText() === 'Mês passado', 'chip ativo');
    const href = await p.getByRole('link', { name: 'Exportar para Excel' }).getAttribute('href');
    confere(/de=\d{4}-\d{2}-01/.test(href) && /ate=\d{4}-\d{2}-\d{2}/.test(href), href);
  });

  await passo('"Outro período e filtros" abre o formulário e aplica', async () => {
    await p.goto(BASE + '/relatorios'); await p.waitForLoadState('networkidle');
    await p.getByText('Outro período e filtros').click();
    await p.locator('select[name=obra]').selectOption(obras[1].id);
    await p.getByRole('button', { name: 'Aplicar' }).click(); await p.waitForURL(/obra=/, { timeout: 15000 }); await p.waitForLoadState('networkidle');
    confere(p.url().includes(`obra=${obras[1].id}`), p.url());
    confere(await p.locator('[data-filtros-ativos]').count() === 1, 'chip do filtro');
  });

  await passo('sem rolagem lateral em 1280px e 390px, em todas as visões', async () => {
    const m = await entrar(390);
    for (const [largura, pg] of [[1280, p], [390, m]]) {
      for (const ver of ['resumo', 'centro', 'categoria', 'fornecedor', 'situacao', 'lancamentos']) {
        await pg.goto(`${BASE}/relatorios?ver=${ver}&de=${hoje.slice(0, 4)}-01-01&ate=${hoje.slice(0, 4)}-12-31`); await pg.waitForLoadState('networkidle');
        confere(await semRolagem(pg), `rolagem lateral em ${ver} (${largura}px)`);
      }
    }
    await m.goto(`${BASE}/relatorios?ver=lancamentos`); await m.waitForLoadState('networkidle');
    await m.screenshot({ path: path.join(DIR, 'relatorios-celular.png'), fullPage: false });
  });

  console.log(`\nRelatórios: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
