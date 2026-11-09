// Fluxo de assinatura de pagamento (fluxo A: engenheiro -> administrador -> financeiro).
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:3000';
const path = require('path');
const BOLETO = path.join(__dirname, '..', 'exemplos', 'nfse-pdf-tabela-tomada-pela-empresa.pdf');
const SENHA = 'Demo-1234';
const resultados = [];
const ok = (msg) => { resultados.push('✔ ' + msg); console.log('✔', msg); };
const falha = (msg, extra = '') => { resultados.push('✘ ' + msg); console.log('✘', msg, extra); };

async function entrar(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => falha(`erro de página (${email})`, e.message.slice(0, 160)));
  await p.goto(`${BASE}/login`);
  await p.fill('input[name=email]', email);
  await p.fill('input[name=senha]', SENHA);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 }), p.click('button:has-text("Entrar")')]);
  return { ctx, p };
}

(async () => {
  const browser = await chromium.launch();

  // 1) Financeiro cadastra o pagamento (boleto) com o boleto anexado
  const fin = await entrar(browser, 'financeiro@demo.local');
  await fin.p.goto(`${BASE}/pagamentos/novo`);
  const obra = await fin.p.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão'))?.value);
  await fin.p.selectOption('select[name=obra_id]', obra);
  await fin.p.fill('input[name=favorecido]', 'Fornecedor do fluxo de assinatura');
  const descricao = 'Fluxo assinatura ' + Date.now();
  await fin.p.fill('input[name=descricao]', descricao);
  await fin.p.fill('input[name=valor]', '1.234,56');
  await fin.p.fill('input[name=vencimento]', new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10));
  await fin.p.setInputFiles('input[name=boleto]', BOLETO);
  await Promise.all([fin.p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 120000 }), fin.p.click('button:has-text("Cadastrar e encaminhar")')]);
  const urlPagamento = fin.p.url();
  const texto0 = await fin.p.textContent('main');
  texto0.includes('Aguardando engenheiro') ? ok('pagamento criado: aguardando engenheiro') : falha('status inicial inesperado', texto0.slice(0, 200));
  const idPag = urlPagamento.match(/[0-9a-f-]{36}/)[0];

  // 2) Engenheiro assina pela aprovação
  const eng = await entrar(browser, 'engenheiro@demo.local');
  await eng.p.goto(`${BASE}/aprovacoes`);
  const linhaEng = eng.p.locator('tr', { hasText: descricao.slice(0, 14) }).first();
  if ((await linhaEng.count()) === 0) falha('engenheiro não vê o pagamento para assinar', (await eng.p.textContent('main')).slice(0, 300));
  else {
    await linhaEng.locator('input[type=checkbox]').check();
    await eng.p.click('button:has-text("Revisar e assinar selecionados")');
    await eng.p.waitForTimeout(800);
    await eng.p.check('input[name=conferi]');
    await eng.p.fill('input[name=senha]', 'senha-errada-123');
    await eng.p.click('button:has-text("Aprovar")');
    await eng.p.waitForTimeout(1500);
    (await eng.p.textContent('main')).includes('Senha incorreta') ? ok('senha errada é recusada (engenheiro)') : falha('senha errada não foi recusada');
    await eng.p.fill('input[name=senha]', SENHA);
    await eng.p.click('button:has-text("Aprovar")');
    await eng.p.waitForTimeout(2000);
    const t = await eng.p.textContent('main');
    (t.includes('Documento assinado') || t.includes('encaminhado')) ? ok('engenheiro assinou') : falha('engenheiro: sem confirmação', t.slice(0, 300));
  }
  await eng.p.goto(`${BASE}/pagamentos/${idPag}`);
  const st1 = await eng.p.textContent('main');
  st1.includes('Aguardando administrador') ? ok('após assinatura do engenheiro: aguardando administrador') : falha('status após engenheiro', st1.slice(0, 200));

  // 3) Administrador assina
  const adm = await entrar(browser, 'administrador@demo.local');
  await adm.p.goto(`${BASE}/aprovacoes`);
  const linhaAdm = adm.p.locator('tr', { hasText: descricao.slice(0, 14) }).first();
  if ((await linhaAdm.count()) === 0) falha('administrador não vê o pagamento para assinar', (await adm.p.textContent('main')).slice(0, 300));
  else {
    await linhaAdm.locator('input[type=checkbox]').check();
    await adm.p.click('button:has-text("Revisar e assinar selecionados")');
    await adm.p.waitForTimeout(800);
    await adm.p.check('input[name=conferi]');
    await adm.p.fill('input[name=senha]', SENHA);
    await adm.p.click('button:has-text("Aprovar")');
    await adm.p.waitForTimeout(2000);
    const t = await adm.p.textContent('main');
    (t.includes('Documento assinado') || t.includes('encaminhado')) ? ok('administrador assinou') : falha('administrador: sem confirmação', t.slice(0, 300));
  }
  await adm.p.goto(`${BASE}/aprovacoes`);
  (await adm.p.locator('tr', { hasText: descricao.slice(0, 14) }).count()) === 0
    ? ok('administrador: pagamento saiu da lista de pendências')
    : falha('administrador: pagamento continua pendente na lista');
  await fin.p.goto(`${BASE}/pagamentos/${idPag}`);
  const st2 = await fin.p.textContent('main');
  st2.includes('Aguardando pagamento') || st2.includes('Liberado') ? ok('após o administrador: liberado para pagamento') : falha('status final inesperado', st2.slice(0, 200));

  console.log('\nRESUMO:');
  resultados.forEach((r) => console.log(r));
  await browser.close();
})().catch((e) => { console.error('✘ teste interrompido:', e.message.slice(0, 300)); process.exit(1); });
