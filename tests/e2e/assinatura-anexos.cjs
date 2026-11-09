// Assinatura: lote, rejeição e assinatura do documento com a imagem (PNG/JPG) no anexo.
const { chromium } = require('playwright');
const { carimbarPendentes } = require('./carimbo.cjs');
const BASE = 'http://127.0.0.1:3000';
const path = require('path');
const BOLETO = path.join(__dirname, '..', 'exemplos', 'nfse-pdf-tabela-tomada-pela-empresa.pdf');
const ASSINATURA = path.join(__dirname, '..', '..', 'public', 'logo-empresa.jpg');
const SENHA = 'Demo-1234';
const resultados = [];
const ok = (m) => { resultados.push('✔ ' + m); console.log('✔', m); };
const falha = (m, extra = '') => { resultados.push('✘ ' + m); console.log('✘', m, extra); };

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

async function criarPagamento(fin, rotulo) {
  await fin.p.goto(`${BASE}/pagamentos/novo`);
  const obra = await fin.p.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão'))?.value);
  await fin.p.selectOption('select[name=obra_id]', obra);
  await fin.p.fill('input[name=favorecido]', 'Fornecedor ' + rotulo);
  await fin.p.fill('input[name=descricao]', rotulo);
  await fin.p.fill('input[name=valor]', '500,00');
  await fin.p.fill('input[name=vencimento]', new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10));
  await fin.p.setInputFiles('input[name=boleto]', BOLETO);
  await Promise.all([fin.p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 120000 }), fin.p.click('button:has-text("Cadastrar e encaminhar")')]);
  return fin.p.url().match(/[0-9a-f-]{36}/)[0];
}

(async () => {
  const browser = await chromium.launch();
  const fin = await entrar(browser, 'financeiro@demo.local');
  const eng = await entrar(browser, 'engenheiro@demo.local');
  const adm = await entrar(browser, 'administrador@demo.local');

  // A) Lote: 2 pagamentos assinados de uma vez pelo engenheiro
  const r1 = 'Lote A ' + Date.now();
  const r2 = 'Lote B ' + Date.now();
  await criarPagamento(fin, r1);
  await criarPagamento(fin, r2);
  await carimbarPendentes('engenheiro@demo.local', SENHA, 'aguardando_engenheiro');
  await eng.p.goto(`${BASE}/aprovacoes`);
  const la = eng.p.locator('tr', { hasText: r1 }).first();
  const lb = eng.p.locator('tr', { hasText: r2 }).first();
  if ((await la.count()) && (await lb.count())) {
    await la.locator('input[type=checkbox]').check();
    await lb.locator('input[type=checkbox]').check();
    await eng.p.click('button:has-text("Revisar e assinar selecionados")');
    await eng.p.waitForTimeout(800);
    await eng.p.check('input[name=conferi]');
    await eng.p.fill('input[name=senha]', SENHA);
    await eng.p.click('button:has-text("Assinar 2 documentos")');
    await eng.p.waitForTimeout(2000);
    const t = await eng.p.textContent('main');
    t.includes('2 documentos assinados') ? ok('lote: 2 pagamentos assinados de uma vez') : falha('lote: confirmação inesperada', t.slice(0, 200));
    await eng.p.goto(`${BASE}/aprovacoes`);
    const restantes = await eng.p.locator('tr', { hasText: r1 }).count() + await eng.p.locator('tr', { hasText: r2 }).count();
    restantes === 0 ? ok('lote: os dois saíram da lista do engenheiro') : falha('lote: ainda aparecem para o engenheiro', String(restantes));
  } else falha('lote: pagamentos não aparecem para o engenheiro');

  // B) Rejeição exige motivo
  const r3 = 'Rejeição ' + Date.now();
  const idRej = await criarPagamento(fin, r3);
  await eng.p.goto(`${BASE}/aprovacoes`);
  const lr = eng.p.locator('tr', { hasText: r3 }).first();
  if (await lr.count()) {
    await lr.locator('input[type=checkbox]').check();
    await eng.p.click('button:has-text("Revisar e assinar selecionados")');
    await eng.p.waitForTimeout(800);
    await eng.p.check('input[name=conferi]');
    await eng.p.fill('input[name=senha]', SENHA);
    await eng.p.click('input[name=decisao][value=rejeitado]');
    await eng.p.waitForTimeout(300);
    const motivoObrigatorio = await eng.p.$eval('textarea[name=comentario]', (el) => el.required).catch(() => false);
    motivoObrigatorio ? ok('rejeição: motivo é obrigatório no formulário') : falha('rejeição: motivo não é obrigatório');
    await eng.p.click('button:has-text("Rejeitar")');
    await eng.p.waitForTimeout(2000);
    await eng.p.fill('textarea[name=comentario]', 'Valor divergente do contrato');
    await eng.p.click('button:has-text("Rejeitar")');
    await eng.p.waitForTimeout(2000);
    await fin.p.goto(`${BASE}/pagamentos/${idRej}`);
    (await fin.p.textContent('main')).includes('Rejeitado') ? ok('rejeição: pagamento ficou rejeitado') : falha('rejeição: status não é rejeitado');
  } else falha('rejeição: pagamento não aparece para o administrador');

  // C) Assinatura do documento com a imagem (PNG/JPG) no anexo
  await eng.p.goto(`${BASE}/perfil`);
  const temFormulario = await eng.p.$('input[type=file]');
  if (temFormulario) {
    await eng.p.setInputFiles('input[type=file]', ASSINATURA);
    await eng.p.click('button:has-text("Salvar assinatura")');
    await eng.p.getByText('Assinatura salva').waitFor({ timeout: 60000 }).then(() => ok('assinatura (imagem) enviada no perfil do engenheiro'))
      .catch(async () => falha('assinatura não foi salva no perfil', (await eng.p.textContent('main')).slice(0, 200)));
  } else falha('perfil do engenheiro não tem campo para enviar a assinatura');

  const r4 = 'Anexo assinado ' + Date.now();
  const idDoc = await criarPagamento(fin, r4);
  await eng.p.goto(`${BASE}/pagamentos/${idDoc}`);
  const abrir = eng.p.locator('button:has-text("Abrir e posicionar a assinatura")');
  if (await abrir.count()) {
    await abrir.click();
    await eng.p.getByText('Posicione sua assinatura').waitFor({ timeout: 120000 });
    await eng.p.click('button:has-text("Confirmar assinatura")');
    await eng.p.getByText(/Documento assinado\. O original/).waitFor({ timeout: 120000 })
      .then(() => ok('documento assinado com a imagem: versão assinada anexada'))
      .catch(async () => falha('assinatura do documento não confirmou', (await eng.p.textContent('main')).slice(0, 200)));
    await eng.p.goto(`${BASE}/pagamentos/${idDoc}`);
    const tx = await eng.p.textContent('main');
    tx.includes('Documento assinado') && tx.includes('Anexo assinado') ? ok('anexos mostram o documento assinado (tipo "Documento assinado")') : falha('anexos não mostram o documento assinado');
  } else falha('botão de assinar documento não aparece para o engenheiro', (await eng.p.textContent('main')).slice(0, 200));

  console.log('\nRESUMO:');
  resultados.forEach((r) => console.log(r));
  await browser.close();
})().catch((e) => { console.error('✘ teste interrompido:', e.message.slice(0, 300)); process.exit(1); });
