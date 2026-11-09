const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:3000';
const res = [];
const ok = (m) => { res.push('✔ ' + m); console.log('✔ ' + m); };
const falha = (m, x = '') => { res.push('✘ ' + m); console.log('✘ ' + m, x); };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => falha('erro de página', e.message.slice(0, 160)));
  await p.goto(`${BASE}/login`);
  await p.fill('input[name=email]', 'financeiro@demo.local');
  await p.fill('input[name=senha]', 'Demo-1234');
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login')), p.click('button:has-text("Entrar")')]);

  // Fornecedor
  await p.goto(`${BASE}/fornecedores/novo`);
  const nomeF = 'Fornecedor revisão ' + Date.now();
  if (await p.locator('main input[name=nome]').count()) {
    await p.fill('main input[name=nome]', nomeF);
    await p.fill('main input[name=cpf_cnpj]', '11.222.333/0001-81');
    await p.locator('main button[type=submit]').first().click();
    await p.waitForTimeout(2000);
    await p.goto(`${BASE}/fornecedores`);
    (await p.textContent('main')).includes(nomeF) ? ok('fornecedor cadastrado e listado') : falha('fornecedor não apareceu na lista');
  } else falha('formulário de fornecedor não encontrado');

  // Centro de custo (obra)
  await p.goto(`${BASE}/obras`);
  const nomeO = 'Obra revisão ' + Date.now();
  const linkNova = p.locator('main a:has-text("Novo"), main a:has-text("Nova")').first();
  if (await linkNova.count()) {
    await linkNova.click();
    await p.waitForURL(/\/obras\/novo|\/obras\/nova/, { timeout: 20000 }).catch(() => {});
    const campoNome = p.locator('input[name=nome]').first();
    if (await campoNome.count()) {
      await campoNome.fill(nomeO);
      await p.locator('input[name=cidade]').fill('Feira de Santana').catch(() => {});
      await p.locator('select[name=uf]').selectOption('BA').catch(() => {});
      await p.locator('input[name=codigo]').fill('OB-' + String(Date.now()).slice(-4)).catch(() => {});
      await p.check('main input[name=fluxo][value=C]').catch(() => {});
      await p.locator('main button[type=submit]').first().click();
      await p.waitForTimeout(2000);
      (await p.textContent('main')).includes(nomeO) || (await p.goto(`${BASE}/obras`)) && (await p.textContent('main')).includes(nomeO)
        ? ok('centro de custo criado')
        : falha('centro de custo não aparece depois de salvar', (await p.textContent('main')).slice(0, 200));
    } else falha('formulário de centro de custo sem campo nome');
  } else falha('botão de novo centro de custo não encontrado');

  // Provisões: converter e cancelar
  await p.goto(`${BASE}/provisoes`);
  const descP = 'Provisão revisão ' + Date.now();
  const obraSel = await p.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.value)?.value);
  await p.selectOption('select[name=obra_id]', obraSel);
  await p.fill('input[name=descricao]', descP);
  await p.click('button:has-text("Registrar provisão")');
  await p.waitForTimeout(1500);
  const linhaP = p.locator('tr', { hasText: descP }).first();
  if (await linhaP.count()) {
    await linhaP.locator('button:has-text("Marcar como lançada")').click();
    await p.waitForTimeout(1500);
    (await p.textContent('main')).includes('Provisão marcada como lançada') ? ok('provisão marcada como lançada') : falha('provisão: lançar não confirmou');
  } else falha('provisão criada não aparece na lista');
  const descC = 'Cancelar revisão ' + Date.now();
  await p.fill('input[name=descricao]', descC);
  await p.selectOption('select[name=obra_id]', obraSel);
  await p.click('button:has-text("Registrar provisão")');
  await p.waitForTimeout(1500);
  const linhaC = p.locator('tr', { hasText: descC }).first();
  if (await linhaC.count()) {
    p.once('dialog', (d) => d.accept());
    await linhaC.locator('button:has-text("Cancelar")').click();
    await p.waitForTimeout(1500);
    (await p.textContent('main')).includes('Provisão cancelada') ? ok('provisão cancelada') : falha('provisão: cancelar não confirmou');
  } else falha('segunda provisão não aparece');

  // Exportações
  for (const rota of ['/pagamentos/exportar', '/relatorios/exportar?tipo=obra', '/notas-contabeis/exportar?situacao=todas', '/compras/exportar']) {
    const r = await ctx.request.get(BASE + rota).catch((e) => null);
    if (!r) { falha('exportação sem resposta', rota); continue; }
    r.status() === 200 ? ok(`exportação ${rota} (${r.headers()['content-type'].split(';')[0]})`) : falha(`exportação ${rota}`, r.status());
  }

  // Usuários: criar usuário novo
  await p.goto(`${BASE}/usuarios/novo`);
  const emailU = `revisao${Date.now()}@demo.local`;
  if (await p.locator('input[name=email]').count()) {
    await p.fill('input[name=nome]', 'Usuário Revisão');
    await p.fill('input[name=email]', emailU);
    await p.selectOption('select[name=perfil]', 'suprimentos').catch(() => {});
    await p.click('main button[type=submit]');
    await p.waitForTimeout(3000);
    const t = await p.textContent('main');
    t.includes('Senha provisória') || t.includes('criado') ? ok('usuário criado com senha provisória') : falha('criação de usuário não confirmou', t.slice(0, 200));
  } else falha('formulário de novo usuário não encontrado');

  console.log('\nRESUMO:', res.filter((r) => r.startsWith('✘')).length, 'falha(s) de', res.length);
  await b.close();
})().catch((e) => { console.error('✘ interrompido', e.message.slice(0, 300)); process.exit(1); });
