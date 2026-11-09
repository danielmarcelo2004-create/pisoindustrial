// Substituir o documento depois de assinado: o fluxo volta ao engenheiro e a janela parte do conteúdo novo.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const BASE = 'http://127.0.0.1:3000';
const CONTRATO = path.join(__dirname, '..', 'exemplos', 'contrato-3-paginas.pdf');
const NOVO = path.join(__dirname, '..', 'exemplos', 'nfse-pdf-pf.pdf');
const ASSINATURA = path.join(__dirname, '..', '..', 'public', 'logo-empresa.jpg');
const SENHA = 'Demo-1234';
let falhas = 0;
const ok = (m) => console.log('✔ ' + m);
const falha = (m, x = '') => { falhas++; console.log('✘ ' + m, x); };
const { carimbarPendentes } = require('./carimbo.cjs');

async function entrar(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => falha('erro de página', e.message.slice(0, 160)));
  await p.goto(`${BASE}/login`);
  await p.fill('input[name=email]', email);
  await p.fill('input[name=senha]', SENHA);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 60000 }), p.click('button:has-text("Entrar")')]);
  return p;
}

(async () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
  const supa = createClient('http://127.0.0.1:54321', env.match(/^SUPABASE_SECRET_KEY=(.+)$/m)[1].trim(), { auth: { persistSession: false } });
  const browser = await chromium.launch();
  const fin = await entrar(browser, 'financeiro@demo.local');
  await fin.goto(`${BASE}/pagamentos/novo`);
  const obra = await fin.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão'))?.value);
  await fin.selectOption('select[name=obra_id]', obra);
  await fin.fill('input[name=favorecido]', 'Substituição assinada');
  const desc = 'Substituir ' + Date.now();
  await fin.fill('input[name=descricao]', desc);
  await fin.fill('input[name=valor]', '310,00');
  await fin.fill('input[name=vencimento]', new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10));
  await fin.setInputFiles('input[name=boleto]', CONTRATO);
  await Promise.all([fin.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 120000 }), fin.click('button:has-text("Cadastrar e encaminhar")')]);
  const id = fin.url().match(/[0-9a-f-]{36}/)[0];

  // Engenheiro assina o documento e aprova
  const eng = await entrar(browser, 'engenheiro@demo.local');
  await eng.goto(`${BASE}/perfil`);
  if (await eng.$('input[type=file]')) { await eng.setInputFiles('input[type=file]', ASSINATURA); await eng.click('button:has-text("Salvar assinatura")'); await eng.getByText('Assinatura salva').waitFor({ timeout: 60000 }).catch(() => {}); }
  await eng.goto(`${BASE}/pagamentos/${id}`);
  await eng.click('button:has-text("Abrir e posicionar a assinatura")');
  await eng.getByText('Posicione sua assinatura').waitFor({ timeout: 120000 });
  await eng.click('button:has-text("Confirmar assinatura")');
  await eng.getByText(/Documento assinado\. O original/).waitFor({ timeout: 120000 });
  await eng.goto(`${BASE}/aprovacoes`);
  const linha = eng.locator('tr', { hasText: desc.slice(0, 14) }).first();
  await linha.locator('input[type=checkbox]').check();
  await eng.click('button:has-text("Revisar e assinar selecionados")');
  await eng.waitForTimeout(800);
  await eng.check('input[name=conferi]');
  await eng.fill('input[name=senha]', SENHA);
  await eng.click('button:has-text("Assinar e aprovar")');
  await eng.waitForTimeout(2000);
  const { data: st1 } = await supa.from('pagamentos').select('status, versao').eq('id', id).single();
  st1.status === 'aguardando_administrador' ? ok('engenheiro aprovou: aguardando administrador') : falha('status após aprovação do engenheiro', st1.status);

  // Financeiro substitui o documento (conteúdo mudou)
  await fin.goto(`${BASE}/pagamentos/${id}`);
  await fin.locator('details:has-text("Substituir por nova versão")').first().click();
  await fin.setInputFiles('details:has-text("Substituir por nova versão") input[type=file]', NOVO);
  await fin.fill('details:has-text("Substituir por nova versão") input[name=motivo]', 'Contrato revisado');
  await fin.click('details:has-text("Substituir por nova versão") button:has-text("Substituir")');
  await fin.waitForTimeout(3000);
  const { data: st2 } = await supa.from('pagamentos').select('status, versao').eq('id', id).single();
  st2.status === 'aguardando_engenheiro' ? ok('substituição reinicia o fluxo: volta ao engenheiro') : falha('após substituir, status', st2.status);
  st2.versao === st1.versao + 1 ? ok('nova versão do pagamento criada') : falha('versão não incrementou', `${st1.versao} -> ${st2.versao}`);

  // Janela do engenheiro não pode partir da assinatura da versão anterior
  await eng.goto(`${BASE}/pagamentos/${id}`);
  const ok1 = await eng.locator('button:has-text("Abrir e posicionar a assinatura")').count();
  if (ok1) {
    await eng.click('button:has-text("Abrir e posicionar a assinatura")');
    await eng.getByText('Posicione sua assinatura').waitFor({ timeout: 120000 });
    const nomeAtual = await eng.locator('select').first().evaluate((s) => s.options[s.selectedIndex]?.text || '');
    nomeAtual.includes('assinado') ? falha('janela partiu de assinatura de versão anterior', nomeAtual) : ok('janela parte do conteúdo novo (não da assinatura anterior)');
    await eng.click('button:has-text("Cancelar")').catch(() => {});
  } else falha('engenheiro não vê a opção de assinar após substituição');

  await browser.close();
  console.log(falhas ? `RESULTADO: ${falhas} falha(s)` : 'RESULTADO: tudo certo');
  if (falhas) process.exit(1);
})().catch((e) => { console.error('✘ interrompido:', e.message.slice(0, 300)); process.exit(1); });
