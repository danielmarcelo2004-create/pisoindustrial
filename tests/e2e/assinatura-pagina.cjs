// Assinatura em PDF de várias páginas: quem assina escolhe a página e a imagem vai nela (e só nela).
const { chromium } = require('playwright');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');
const { carimbarPendentes } = require('./carimbo.cjs');
const BASE = 'http://127.0.0.1:3000';
const CONTRATO = path.join(__dirname, '..', 'exemplos', 'contrato-3-paginas.pdf');
const ASSINATURA = path.join(__dirname, '..', '..', 'public', 'logo-empresa.jpg');
const SENHA = 'Demo-1234';
const ok = (m) => console.log('✔ ' + m);
const falha = (m, x = '') => { console.log('✘ ' + m, x); process.exitCode = 1; };

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

// Quantas páginas têm imagem.
async function paginasComImagem(bytes) {
  const doc = await PDFDocument.load(bytes);
  const paginas = [];
  doc.getPages().forEach((pg, i) => {
    const xo = pg.node.Resources()?.lookup(PDFName.of('XObject'));
    let tem = false;
    if (xo instanceof PDFDict) {
      for (const k of xo.keys()) {
        const obj = xo.lookup(k);
        if (obj && obj.dict && obj.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') tem = true;
      }
    }
    if (tem) paginas.push(i + 1);
  });
  return { total: doc.getPageCount(), paginas };
}

(async () => {
  const env = require('fs').readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8');
  const chave = env.match(/^SUPABASE_SECRET_KEY=(.+)$/m)[1].trim();
  const supa = createClient('http://127.0.0.1:54321', chave, { auth: { persistSession: false } });
  const browser = await chromium.launch();
  const fin = await entrar(browser, 'financeiro@demo.local');
  await fin.goto(`${BASE}/pagamentos/novo`);
  const obra = await fin.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão'))?.value);
  await fin.selectOption('select[name=obra_id]', obra);
  await fin.fill('input[name=favorecido]', 'Locadora pagina');
  const desc = 'Contrato paginas ' + Date.now();
  await fin.fill('input[name=descricao]', desc);
  await fin.fill('input[name=valor]', '900,00');
  await fin.fill('input[name=vencimento]', new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10));
  await fin.setInputFiles('input[name=boleto]', CONTRATO);
  await Promise.all([fin.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 120000 }), fin.click('button:has-text("Cadastrar e encaminhar")')]);
  const idPag = fin.url().match(/[0-9a-f-]{36}/)[0];
  ok('contrato de 3 páginas cadastrado');

  const eng = await entrar(browser, 'engenheiro@demo.local');
  await eng.goto(`${BASE}/perfil`);
  if (await eng.$('input[type=file]')) {
    await eng.setInputFiles('input[type=file]', ASSINATURA);
    await eng.click('button:has-text("Salvar assinatura")');
    await eng.getByText('Assinatura salva').waitFor({ timeout: 60000 }).catch(() => {});
  }
  await eng.goto(`${BASE}/pagamentos/${idPag}`);
  await eng.click('button:has-text("Abrir e posicionar a assinatura")');
  await eng.getByText('Posicione sua assinatura').waitFor({ timeout: 120000 });
  const seletor = eng.locator('select').filter({ hasText: 'de 3' });
  const seletorVisivel = await seletor.waitFor({ timeout: 60000 }).then(() => true).catch(() => false);
  seletorVisivel ? ok('janela mostra seletor de página (3 páginas)') : falha('seletor de página não aparece');
  await seletor.selectOption('1');
  await eng.waitForTimeout(1500);
  await eng.click('button:has-text("Confirmar assinatura")');
  const confirmou = await eng.getByText(/Documento assinado\. O original/).waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
  confirmou ? ok('assinatura confirmada na página 1') : falha('assinatura não confirmou');

  // Confere no arquivo gravado: a imagem deve estar só na página 1
  const { data: docs } = await supa.from('documentos').select('storage_path, tipo, ativo').eq('pagamento_id', idPag).eq('tipo', 'documento_assinado').eq('ativo', true);
  if (!docs || docs.length === 0) falha('versão assinada não foi gravada');
  else {
    const { data: arq } = await supa.storage.from('documentos').download(docs[0].storage_path);
    const r = await paginasComImagem(Buffer.from(await arq.arrayBuffer()));
    r.total === 3 ? ok('versão assinada mantém as 3 páginas') : falha('número de páginas mudou', r.total);
    JSON.stringify(r.paginas) === '[1]' ? ok('imagem da assinatura só na página 1') : falha('imagem nas páginas', JSON.stringify(r.paginas));
  }
  // Parte B: administrador assina o documento com a imagem (depois da aprovação do engenheiro)
  const desc2 = 'Contrato admin ' + Date.now();
  await fin.goto(`${BASE}/pagamentos/novo`);
  await fin.selectOption('select[name=obra_id]', obra);
  await fin.fill('input[name=favorecido]', 'Locadora admin');
  await fin.fill('input[name=descricao]', desc2);
  await fin.fill('input[name=valor]', '450,00');
  await fin.fill('input[name=vencimento]', new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10));
  await fin.setInputFiles('input[name=boleto]', CONTRATO);
  await Promise.all([fin.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 120000 }), fin.click('button:has-text("Cadastrar e encaminhar")')]);
  const idAdm = fin.url().match(/[0-9a-f-]{36}/)[0];
  await carimbarPendentes('engenheiro@demo.local', SENHA, 'aguardando_engenheiro');
  await eng.goto(`${BASE}/aprovacoes`);
  const linhaE = eng.locator('tr', { hasText: desc2.slice(0, 16) }).first();
  await linhaE.locator('input[type=checkbox]').check();
  await eng.click('button:has-text("Revisar e assinar selecionados")');
  await eng.waitForTimeout(800);
  await eng.check('input[name=conferi]');
  await eng.fill('input[name=senha]', SENHA);
  await eng.click('button:has-text("Assinar e aprovar")');
  await eng.waitForTimeout(2000);
  const adm = await entrar(browser, 'administrador@demo.local');
  await adm.goto(`${BASE}/perfil`);
  if (await adm.$('input[type=file]')) {
    await adm.setInputFiles('input[type=file]', ASSINATURA);
    await adm.click('button:has-text("Salvar assinatura")');
    await adm.getByText('Assinatura salva').waitFor({ timeout: 60000 }).catch(() => {});
  }
  await adm.goto(`${BASE}/pagamentos/${idAdm}`);
  const etapaOk = (await adm.textContent('main')).includes('Aguardando administrador');
  etapaOk ? ok('admin: pagamento aguardando a assinatura do administrador') : falha('admin: etapa inesperada');
  await adm.click('button:has-text("Abrir e posicionar a assinatura")');
  await adm.getByText('Posicione sua assinatura').waitFor({ timeout: 120000 });
  await adm.click('button:has-text("Confirmar assinatura")');
  const confirmouA = await adm.getByText(/Documento assinado\. O original/).waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
  confirmouA ? ok('administrador assinou o documento com a imagem') : falha('administrador: assinatura do documento não confirmou');
  const { data: docsA } = await supa.from('documentos').select('id').eq('pagamento_id', idAdm).eq('tipo', 'documento_assinado').eq('ativo', true);
  (docsA && docsA.length === 2) ? ok('versões assinadas gravadas: engenheiro e administrador') : falha('versões assinadas inesperadas', docsA?.length);

  await browser.close();
  console.log(process.exitCode ? 'RESULTADO: com falhas' : 'RESULTADO: tudo certo');
})().catch((e) => { console.error('✘ interrompido:', e.message.slice(0, 300)); process.exit(1); });
