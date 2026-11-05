// Teste de ponta a ponta: envio da assinatura no perfil e assinatura de um documento com posicionamento.
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const URL = 'http://127.0.0.1:54321';
const PUB = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';
const SENHA = 'Demo-1234';
const ASSINATURA = path.join(__dirname, '..', '..', 'public', 'logo-empresa.jpg');

(async () => {
  const sb = createClient(URL, PUB, { auth: { persistSession: false } });
  await sb.auth.signInWithPassword({ email: 'financeiro@demo.local', password: SENHA });
  const { data: doc } = await sb.from('documentos').select('id, pagamento_id, nome_arquivo').eq('tipo', 'boleto').eq('ativo', true).limit(1).single();
  const antes = await sb.from('documentos').select('id', { count: 'exact', head: true }).eq('pagamento_id', doc.pagamento_id).eq('tipo', 'documento_assinado');
  console.log('✔ documento escolhido:', doc.nome_arquivo);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto('http://127.0.0.1:3000/login');
  await page.fill('input[name=email]', 'financeiro@demo.local');
  await page.fill('input[name=senha]', SENHA);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button:has-text("Entrar")')]);

  await page.goto('http://127.0.0.1:3000/perfil');
  await page.setInputFiles('input[type=file]', ASSINATURA);
  await page.click('button:has-text("Salvar assinatura")');
  await page.getByText('Assinatura salva').waitFor({ timeout: 60000 });
  console.log('✔ assinatura enviada ao perfil');

  await page.goto(`http://127.0.0.1:3000/pagamentos/${doc.pagamento_id}`);
  await page.getByText('Assinar documento').first().waitFor();
  await page.click('button:has-text("Abrir e posicionar a assinatura")');
  await page.getByText('Posicione sua assinatura').waitFor({ timeout: 120000 });
  await page.screenshot({ path: path.join(__dirname, '.saida', 'assinatura-posicionar.png'), fullPage: false });
  await page.click('button:has-text("Confirmar assinatura")');
  await page.getByText(/Documento assinado\. O original/).waitFor({ timeout: 120000 });
  console.log('✔ versão assinada gerada');

  const depois = await sb.from('documentos').select('id, nome_arquivo', { count: 'exact' }).eq('pagamento_id', doc.pagamento_id).eq('tipo', 'documento_assinado');
  const original = await sb.from('documentos').select('ativo').eq('id', doc.id).single();
  console.log(`Versões assinadas: ${antes.count} → ${depois.count}; original ativo: ${original.data.ativo}`);
  if (depois.count !== antes.count + 1 || !original.data.ativo) throw new Error('resultado inesperado');
  console.log('✔ original preservado e versão assinada anexada');
  await browser.close();
})().catch((e) => { console.error('✘ FALHOU:', e.message); process.exit(1); });
