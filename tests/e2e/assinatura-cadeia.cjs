// Cadeia de assinaturas: engenheiro assina o documento e aprova; administrador assina sobre a versão do
// engenheiro e aprova. O documento final tem as duas assinaturas (páginas 1 e 3).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');
const BASE = 'http://127.0.0.1:3000';
const CONTRATO = path.join(__dirname, '..', 'exemplos', 'contrato-3-paginas.pdf');
const ASSINATURA = path.join(__dirname, '..', '..', 'public', 'logo-empresa.jpg');
const SENHA = 'Demo-1234';
let falhas = 0;
const ok = (m) => console.log('✔ ' + m);
const falha = (m, x = '') => { falhas++; console.log('✘ ' + m, x); };

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
async function paginasComImagem(bytes) {
  const doc = await PDFDocument.load(bytes);
  const paginas = [];
  doc.getPages().forEach((pg, i) => {
    const xo = pg.node.Resources()?.lookup(PDFName.of('XObject'));
    let tem = false;
    if (xo instanceof PDFDict) for (const k of xo.keys()) { const o = xo.lookup(k); if (o && o.dict && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') tem = true; }
    if (tem) paginas.push(i + 1);
  });
  return paginas;
}
async function assinarNaPagina(p, pagina) {
  await p.click('button:has-text("Abrir e posicionar a assinatura")');
  await p.getByText('Posicione sua assinatura').waitFor({ timeout: 120000 });
  if (pagina) await p.locator('select').filter({ hasText: 'de 3' }).selectOption(String(pagina));
  await p.waitForTimeout(1200);
  await p.click('button:has-text("Confirmar assinatura")');
  return p.getByText(/Documento assinado\. O original/).waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
}
async function aprovar(p, descricao) {
  await p.goto(`${BASE}/aprovacoes`);
  const linha = p.locator('tr', { hasText: descricao.slice(0, 16) }).first();
  await linha.locator('input[type=checkbox]').check();
  await p.click('button:has-text("Revisar e assinar selecionados")');
  await p.waitForTimeout(800);
  await p.check('input[name=conferi]');
  await p.fill('input[name=senha]', SENHA);
  await p.click('button:has-text("Assinar e aprovar")');
  await p.waitForTimeout(2000);
  return p.textContent('main');
}

(async () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
  const supa = createClient('http://127.0.0.1:54321', env.match(/^SUPABASE_SECRET_KEY=(.+)$/m)[1].trim(), { auth: { persistSession: false } });
  const browser = await chromium.launch();
  const fin = await entrar(browser, 'financeiro@demo.local');
  await fin.goto(`${BASE}/pagamentos/novo`);
  const obra = await fin.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão'))?.value);
  await fin.selectOption('select[name=obra_id]', obra);
  await fin.fill('input[name=favorecido]', 'Cadeia de assinaturas');
  const desc = 'Cadeia ' + Date.now();
  await fin.fill('input[name=descricao]', desc);
  await fin.fill('input[name=valor]', '640,00');
  await fin.fill('input[name=vencimento]', new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10));
  await fin.setInputFiles('input[name=boleto]', CONTRATO);
  await Promise.all([fin.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 120000 }), fin.click('button:has-text("Cadastrar e encaminhar")')]);
  const id = fin.url().match(/[0-9a-f-]{36}/)[0];
  ok('pagamento com documento de 3 páginas criado');

  const eng = await entrar(browser, 'engenheiro@demo.local');
  await eng.goto(`${BASE}/perfil`);
  if (await eng.$('input[type=file]')) { await eng.setInputFiles('input[type=file]', ASSINATURA); await eng.click('button:has-text("Salvar assinatura")'); await eng.getByText('Assinatura salva').waitFor({ timeout: 60000 }).catch(() => {}); }

  // 1) Aprovar sem assinar o documento deve ser bloqueado
  const t1 = await aprovar(eng, desc);
  t1.includes('Posicione sua assinatura no documento') ? ok('engenheiro não consegue aprovar sem assinar o documento') : falha('aprovação sem assinatura não foi bloqueada', t1.slice(0, 200));

  // 2) Engenheiro assina o documento (página 1) e aprova
  await eng.goto(`${BASE}/pagamentos/${id}`);
  (await assinarNaPagina(eng, 1)) ? ok('engenheiro assinou o documento na página 1') : falha('engenheiro: assinatura do documento não confirmou');
  const t2 = await aprovar(eng, desc);
  (t2.includes('Documento assinado') || t2.includes('encaminhado')) ? ok('engenheiro aprovou após assinar') : falha('engenheiro: aprovação não confirmou', t2.slice(0, 200));

  // 3) Administrador: a janela parte da versão do engenheiro; assina na página 3 e aprova
  const adm = await entrar(browser, 'administrador@demo.local');
  await adm.goto(`${BASE}/perfil`);
  if (await adm.$('input[type=file]')) { await adm.setInputFiles('input[type=file]', ASSINATURA); await adm.click('button:has-text("Salvar assinatura")'); await adm.getByText('Assinatura salva').waitFor({ timeout: 60000 }).catch(() => {}); }
  await adm.goto(`${BASE}/pagamentos/${id}`);
  await adm.click('button:has-text("Abrir e posicionar a assinatura")');
  await adm.getByText('Posicione sua assinatura').waitFor({ timeout: 120000 });
  const doc = await adm.locator('select').first().inputValue();
  const { data: versoes } = await supa.from('documentos').select('id, tipo').eq('pagamento_id', id).eq('ativo', true).eq('tipo', 'documento_assinado');
  (versoes && versoes.length && doc === versoes[versoes.length - 1].id) ? ok('janela do administrador parte da versão assinada pelo engenheiro') : falha('janela do administrador não partiu da versão assinada', doc);
  await adm.keyboard.press('Escape').catch(() => {});
  await adm.reload();
  (await assinarNaPagina(adm, 3)) ? ok('administrador assinou na página 3') : falha('administrador: assinatura não confirmou');
  const t3 = await aprovar(adm, desc);
  (t3.includes('Documento assinado') || t3.includes('encaminhado') || t3.includes('assinado')) ? ok('administrador aprovou') : falha('administrador: aprovação não confirmou', t3.slice(0, 200));

  // 4) Documento final: assinaturas nas páginas 1 e 3
  const { data: finais } = await supa.from('documentos').select('storage_path').eq('pagamento_id', id).eq('tipo', 'documento_assinado').eq('ativo', true).order('created_at', { ascending: false }).limit(1);
  if (!finais || !finais.length) falha('documento assinado final não encontrado');
  else {
    const { data: arq } = await supa.storage.from('documentos').download(finais[0].storage_path);
    const paginas = await paginasComImagem(Buffer.from(await arq.arrayBuffer()));
    JSON.stringify(paginas) === '[1,3]' ? ok('documento final tem as duas assinaturas (páginas 1 e 3)') : falha('assinaturas no documento final', JSON.stringify(paginas));
  }
  await browser.close();
  console.log(falhas ? `RESULTADO: ${falhas} falha(s)` : 'RESULTADO: tudo certo');
  if (falhas) process.exit(1);
})().catch((e) => { console.error('✘ interrompido:', e.message.slice(0, 300)); process.exit(1); });
