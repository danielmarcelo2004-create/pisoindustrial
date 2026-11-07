// Teste de ponta a ponta: fundo fixo (criar, lançar, assinar comprovante, aprovar, esgotar, fechar).
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const URL = 'http://127.0.0.1:54321';
const PUB = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SENHA = 'Demo-1234';
const ASSINATURA = path.join(__dirname, '..', '..', 'public', 'logo-empresa.jpg');
const APP = 'http://127.0.0.1:3000';
const hoje = new Date().toISOString().slice(0, 10);

(async () => {
  const sb = createClient(URL, PUB, { auth: { persistSession: false } });
  await sb.auth.signInWithPassword({ email: 'financeiro@demo.local', password: SENHA });
  const { data: eng } = await sb.from('profiles').select('id').eq('email', 'engenheiro@demo.local').single();
  const { data: adm } = await sb.from('profiles').select('id').eq('email', 'administrador@demo.local').single();
  const { data: obra } = await sb.from('obras').select('id, nome').eq('administrador_id', adm.id).limit(1).single();
  console.log('✔ obra com administrador:', obra.nome);

  const browser = await chromium.launch();
  const novoPagina = async () => (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const entrar = async (page, email) => {
    await page.goto(`${APP}/login`);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=senha]', SENHA);
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button:has-text("Entrar")')]);
  };
  const erros = [];
  const monitorar = (page) => page.on('pageerror', (e) => erros.push(e.message.slice(0, 200)));

  // 1. Financeiro cria o fundo de R$ 100,00 para o engenheiro
  const fin = await novoPagina();
  monitorar(fin);
  await entrar(fin, 'financeiro@demo.local');
  await fin.goto(`${APP}/fundos-fixos`);
  await fin.selectOption('select[name=obra_id]', obra.id);
  await fin.selectOption('select[name=pessoa_id]', eng.id);
  await fin.fill('input[name=valor]', '100,00');
  await fin.click('button:has-text("Criar fundo")');
  await fin.getByText('Fundo fixo criado').waitFor({ timeout: 60000 });
  console.log('✔ fundo fixo de R$ 100,00 criado');

  // 2. Engenheiro cadastra assinatura, lança gasto de R$ 60,00 e assina o comprovante
  const engPage = await novoPagina();
  monitorar(engPage);
  await entrar(engPage, 'engenheiro@demo.local');
  await engPage.goto(`${APP}/perfil`);
  await engPage.setInputFiles('input[type=file]', ASSINATURA);
  await engPage.click('button:has-text("Salvar assinatura")');
  await engPage.getByText('Assinatura salva').waitFor({ timeout: 60000 });
  await engPage.goto(`${APP}/fundos-fixos`);
  await engPage.click('text=Ver fundo');
  await engPage.fill('input[name=descricao]', 'Combustível');
  await engPage.fill('input[name=data_gasto]', hoje);
  await engPage.fill('input[name=valor]', '60,00');
  await engPage.click('button:has-text("Lançar gasto")');
  await engPage.getByText('Gasto lançado').waitFor({ timeout: 60000 });
  console.log('✔ gasto de R$ 60,00 lançado (aguardando administrador)');

  await engPage.setInputFiles('input[type=file]', ASSINATURA);
  await engPage.getByText('Posicione sua assinatura').waitFor({ timeout: 60000 });
  await engPage.click('button:has-text("Confirmar assinatura")');
  await engPage.getByText(/Comprovante assinado\. O original/).waitFor({ timeout: 120000 });
  console.log('✔ comprovante anexado e assinado pelo engenheiro');

  // 3. Administrador aprova o primeiro gasto e o segundo
  const adminPage = await novoPagina();
  monitorar(adminPage);
  await entrar(adminPage, 'administrador@demo.local');
  for (const descricao of ['Combustível']) {
    await adminPage.goto(`${APP}/fundos-fixos`);
    await adminPage.click('text=Decidir');
    await adminPage.click('button:has-text("Aprovar gasto")');
    await adminPage.getByText('Gasto aprovado e somado ao saldo').waitFor({ timeout: 60000 });
    console.log(`✔ gasto "${descricao}" aprovado pelo administrador`);
  }

  // 4. Segundo gasto de R$ 60,00 esgota o fundo (gastos de R$ 120,00 num fundo de R$ 100,00)
  await engPage.goto(`${APP}/fundos-fixos`);
  await engPage.click('text=Ver fundo');
  await engPage.fill('input[name=descricao]', 'Material');
  await engPage.fill('input[name=data_gasto]', hoje);
  await engPage.fill('input[name=valor]', '60,00');
  await engPage.click('button:has-text("Lançar gasto")');
  await engPage.getByText('Gasto lançado').waitFor({ timeout: 60000 });
  await adminPage.goto(`${APP}/fundos-fixos`);
  await adminPage.click('text=Decidir');
  await adminPage.click('button:has-text("Aprovar gasto")');
  await adminPage.getByText('Gasto aprovado e somado ao saldo').waitFor({ timeout: 60000 });
  await adminPage.goto(`${APP}/fundos-fixos`);
  await adminPage.click('text=Ver fundo');
  await adminPage.getByText('Esgotado').first().waitFor({ timeout: 60000 });
  console.log('✔ fundo esgotado após o segundo gasto');

  // 5. Financeiro fecha o fundo: reposição R$ 100,00 + reembolso R$ 20,00 num único pagamento
  await fin.goto(`${APP}/fundos-fixos`);
  await fin.click('text=Ver fundo');
  await fin.click('button:has-text("Fechar fundo")');
  await fin.getByText(/Fundo fechado\. A reposição/).waitFor({ timeout: 60000 });
  const { data: pag } = await sb.from('pagamentos').select('descricao, valor, fluxo, status').like('descricao', 'Fundo fixo%').single();
  if (!/reposição de R\$ 100,00 \+ reembolso de R\$ 20,00/.test(pag.descricao) || Number(pag.valor) !== 120 || pag.fluxo !== 'C') {
    throw new Error(`pagamento de fechamento inesperado: ${JSON.stringify(pag)}`);
  }
  console.log('✔ pagamento de fechamento:', pag.descricao, '-', pag.valor);

  if (erros.length) console.log('[erros de página]', erros);
  await browser.close();
  if (erros.length) process.exit(1);
  console.log('✔ fundo fixo: teste concluído');
})().catch((e) => {
  console.error('✘', e.message);
  process.exit(1);
});
