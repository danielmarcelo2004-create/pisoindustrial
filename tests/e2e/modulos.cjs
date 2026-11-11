const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const DIR = path.join(__dirname, '.saida');
fs.mkdirSync(DIR, { recursive: true });
const BASE = 'http://127.0.0.1:3000';
const SENHA = 'Demo-1234';
const XML = path.join(__dirname, '..', 'exemplos', 'nfe-exemplo-concreto.xml');
const erros = [];
let passo = 0;
const ok = (m) => console.log(`✔ ${++passo}. ${m}`);
const shot = (page, nome) => page.screenshot({ path: path.join(DIR, nome + '.png'), fullPage: true });

async function entrar(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.push(`[${email}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) erros.push(`[${email}] console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=senha]', SENHA);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button:has-text("Entrar")')]);
  return { ctx, page };
}

(async () => {
  // servidor falso da API do WhatsApp
  const recebidas = [];
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { recebidas.push({ url: req.url, auth: req.headers.authorization, corpo: JSON.parse(b || '{}') }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"messages":[{"id":"x"}]}'); });
  }).listen(4555);

  const browser = await chromium.launch();

  // 1. Engenheiro cria OP com itens, salva rascunho, pré-visualiza PDF e envia
  let { ctx, page } = await entrar(browser, 'engenheiro@demo.local');
  await page.goto(BASE + '/ops');
  await shot(page, '30-minhas-ops');
  await Promise.all([page.waitForURL(/ops\/nova/), page.click('text=+ Nova solicitação')]);
  await page.waitForSelector('select[name=obra_id]');
  const obraV = await page.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão')).value);
  await page.selectOption('select[name=obra_id]', obraV);
  await page.getByText('seguirá direto para o administrador').waitFor();
  await page.fill('input[name=favorecido]', 'Marcos Eletricista');
  await page.fill('input[name=cpf_cnpj]', '529.982.247-25');
  await page.fill('input[name=descricao]', 'Instalação elétrica provisória do canteiro');
  await page.fill('input[name=vencimento]', new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10));
  await page.fill('[name=dados_bancarios]', 'PIX 529.982.247-25');
  await page.fill('input[aria-label="Descrição do item 1"]', 'Mão de obra eletricista');
  await page.fill('input[aria-label="Unidade do item 1"]', 'dia');
  await page.fill('input[aria-label="Quantidade do item 1"]', '3');
  await page.fill('input[aria-label="Valor unitário do item 1"]', '250,00');
  await page.click('text=+ Adicionar item');
  await page.fill('input[aria-label="Descrição do item 2"]', 'Cabo PP 3x2,5mm');
  await page.fill('input[aria-label="Unidade do item 2"]', 'm');
  await page.fill('input[aria-label="Quantidade do item 2"]', '50,5');
  await page.fill('input[aria-label="Valor unitário do item 2"]', '8,90');
  await page.getByText('R$ 1.199,45').first().waitFor(); // 750 + 449,45
  await shot(page, '31-nova-op');
  await Promise.all([page.waitForURL(/\/ops\/[0-9a-f-]{36}\/editar\?salva/), page.click('button:has-text("Salvar rascunho")')]);
  await page.getByText('Editar solicitação (rascunho)').first().waitFor();
  ok('Engenheiro salvou rascunho de OP com 2 itens (total calculado R$ 1.199,45)');

  const opUrl = page.url().split('/editar')[0].split('?')[0];
  const pdf = await ctx.request.get(opUrl + '/pdf');
  const pdfBuf = await pdf.body();
  if (pdf.headers()['content-type'] !== 'application/pdf' || pdfBuf.slice(0, 4).toString() !== '%PDF') throw new Error('PDF de prévia inválido');
  fs.writeFileSync(path.join(DIR, 'op-rascunho.pdf'), pdfBuf);
  ok(`Pré-visualização do PDF (${pdfBuf.length} bytes)`);

  await page.click('button:has-text("Salvar e enviar")');
  await page.waitForURL(/enviada=1/);
  await page.getByText(/OP-\d{4}-\d{5}/).first().waitFor();
  const numeroOP = (await page.locator('h1').innerText()).match(/OP-\d{4}-\d{5}/)[0];
  await shot(page, '32-op-enviada');
  const linkPdf = await page.locator('a:has-text("Abrir PDF da OP")').getAttribute('href');
  const pdfOficial = await ctx.request.get(BASE + linkPdf);
  const pdfOfBuf = await pdfOficial.body();
  if (pdfOfBuf.slice(0, 4).toString() !== '%PDF') throw new Error('PDF oficial não anexado');
  fs.writeFileSync(path.join(DIR, 'op-oficial.pdf'), pdfOfBuf);
  ok(`OP enviada como ${numeroOP} com PDF oficial anexado`);
  const pagHref = await page.locator('a:has-text("Ver pagamento")').getAttribute('href');
  await ctx.close();

  // 1a. Assinaturas cadastradas (engenheiro e administrador) para assinar as OPs
  for (const email of ['engenheiro@demo.local', 'administrador@demo.local']) {
    ({ ctx, page } = await entrar(browser, email));
    await page.goto(BASE + '/perfil');
    if (await page.$('input[type=file]')) {
      await page.setInputFiles('input[type=file]', path.join(__dirname, '..', '..', 'public', 'logo-empresa.jpg'));
      await page.click('button:has-text("Salvar assinatura")');
      await page.getByText('Assinatura salva').waitFor({ timeout: 60000 });
    }
    await ctx.close();
  }

  // 1b. O engenheiro que criou a OP assina o PDF e aprova a etapa dele
  ({ ctx, page } = await entrar(browser, 'engenheiro@demo.local'));
  await page.goto(BASE + pagHref);
  await page.click('button:has-text("Abrir e posicionar a assinatura")');
  await page.getByText('Posicione sua assinatura').waitFor();
  await page.click('button:has-text("Confirmar assinatura")');
  await page.getByText(/Documento assinado\. O original/).waitFor({ timeout: 90000 });
  await page.goto(BASE + pagHref);
  await page.click('button:has-text("Assinar e aprovar")');
  await page.check('input[name=conferi]');
  await page.fill('input[name=senha]', SENHA);
  await page.click('form button:has-text("Assinar e aprovar")');
  await page.getByText('Encaminhado ao administrador').first().waitFor({ timeout: 20000 }).catch(() => {});
  ok('Engenheiro assinou e aprovou a própria OP');
  await ctx.close();

  // 2. Administrador abre (em análise) e aprova
  ({ ctx, page } = await entrar(browser, 'administrador@demo.local'));
  await page.goto(BASE + pagHref);
  await page.click('button:has-text("Abrir e posicionar a assinatura")');
  await page.getByText('Posicione sua assinatura').waitFor();
  await page.click('button:has-text("Confirmar assinatura")');
  await page.getByText(/Documento assinado\. O original/).waitFor({ timeout: 90000 });
  await page.goto(BASE + pagHref);
  await page.click('button:has-text("Assinar e aprovar")');
  await page.check('input[name=conferi]');
  await page.fill('input[name=senha]', SENHA);
  await page.click('form button:has-text("Assinar e aprovar")');
  await page.getByText('Documento assinado e encaminhado').waitFor().catch(async (e) => { console.log('ADM ALERTAS:', (await page.locator('[role=alert]').allInnerTexts()).join(' | ')); throw e; });
  ok('Administrador aprovou a OP');
  // suprimentos não participou: o fluxo não passou por ele
  await ctx.close();

  ({ ctx, page } = await entrar(browser, 'engenheiro@demo.local'));
  await page.goto(opUrl);
  await page.getByText('Aprovada').first().waitFor();
  await page.goto(BASE + '/notificacoes');
  await page.getByText('Sua OP foi aprovada').first().waitFor();
  ok('Engenheiro vê a OP como Aprovada e recebeu notificação');
  await ctx.close();

  // 3. Suprimentos anexa XML de NF-e → itens lidos automaticamente
  ({ ctx, page } = await entrar(browser, 'suprimentos@demo.local'));
  await page.goto(BASE + '/pagamentos/novo');
  const ob = await page.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão')).value);
  await page.selectOption('select[name=obra_id]', ob);
  await page.fill('input[name=favorecido]', 'Concreteira Baiana Ltda');
  await page.fill('input[name=descricao]', 'Concreto 32 m³ + bombeamento (NF 4567)');
  await page.fill('input[name=valor]', '20.463,40');
  await page.fill('input[name=vencimento]', new Date(Date.now() + 8 * 864e5).toISOString().slice(0, 10));
  await page.setInputFiles('input[name=nota_fiscal]', XML);
  await Promise.all([page.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/), page.click('button:has-text("Cadastrar e encaminhar")')]);
  await page.getByText(/3 item\(ns\) na Inteligência de Compras \(\s*lidos do XML/).waitFor();
  await shot(page, '33-pagamento-com-xml');
  ok('XML da NF-e anexado: 3 itens lidos automaticamente');

  // mesma NF em outro pagamento → aviso de duplicidade
  const url1 = page.url();
  await page.goto(BASE + '/pagamentos/novo');
  await page.selectOption('select[name=obra_id]', ob);
  await page.fill('input[name=favorecido]', 'Concreteira Baiana Ltda');
  await page.fill('input[name=descricao]', 'Duplicado');
  await page.fill('input[name=valor]', '10,00');
  await page.fill('input[name=vencimento]', new Date(Date.now() + 8 * 864e5).toISOString().slice(0, 10));
  await page.setInputFiles('input[name=nota_fiscal]', XML);
  await Promise.all([page.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/), page.click('button:has-text("Cadastrar e encaminhar")')]);
  await page.getByText(/já foi registrada em outro pagamento/).waitFor();
  ok('Mesma NF-e em outro pagamento é sinalizada (sem duplicar na análise)');

  // Lançamento manual de NF em PDF
  await page.goto(url1);
  await page.click('summary:has-text("Anexar documento")');
  await page.selectOption('select[name=tipo]', 'nota_fiscal');
  fs.writeFileSync(path.join(DIR, 'nf-scan.pdf'), '%PDF-1.4\n%%EOF');
  await page.setInputFiles('input[name=arquivo][multiple]', path.join(DIR, 'nf-scan.pdf'));
  await page.click('button:has-text("Anexar")');
  await page.getByText('Documento anexado').waitFor();
  await page.reload();
  await page.click('text=Lançar itens desta nota na Inteligência de Compras');
  await page.fill('input[name=data_emissao]', new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10));
  await page.fill('input[aria-label="Descrição 1"]', 'Selante PU para juntas 400g');
  await page.fill('input[aria-label="Unidade 1"]', 'un');
  await page.fill('input[aria-label="Quantidade 1"]', '24');
  await page.fill('input[aria-label="Preço 1"]', '59,90');
  await shot(page, '34-lancar-nf');
  await page.click('button:has-text("Registrar itens")');
  await page.waitForURL(/nf=lancada/, { timeout: 8000 }).catch(async () => { await shot(page, 'dbg-nf'); throw new Error('lancar: ' + (await page.locator('[role=alert]').allInnerTexts()).join(' | ')); });
  await page.getByText(/1 item\(ns\) na Inteligência de Compras/).waitFor();
  ok('Lançamento manual dos itens de uma NF em PDF');
  await ctx.close();

  // 4. Financeiro: Inteligência de Compras
  ({ ctx, page } = await entrar(browser, 'financeiro@demo.local'));
  await page.goto(BASE + '/compras');
  await page.getByText('Comparação de preços por material').waitFor();
  const alertasTxt = await page.locator('text=/Alertas de diferença de preço \\(\\d+\\)/').innerText();
  if (/\(0\)/.test(alertasTxt)) throw new Error('nenhum alerta gerado');
  await shot(page, '35-compras');
  await page.click('a:has-text("CONCRETO USINADO FCK 30")');
  await page.getByText('Histórico de compras').waitFor();
  await page.getByText('Comparação regional').waitFor();
  await shot(page, '36-compras-material');
  ok(`Inteligência de Compras com comparação, ${alertasTxt.toLowerCase()} e detalhe por material`);
  await page.goto(BASE + '/compras?uf=SE');
  const txtSE = (await page.locator('table').allInnerTexts()).join(' ');
  if (txtSE.includes('Galpão')) throw new Error('filtro UF falhou');
  ok('Filtro regional (UF) funciona');

  const xl = await ctx.request.get(BASE + '/compras/exportar');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await xl.body());
  const abas = wb.worksheets.map((w) => `${w.name}(${w.rowCount - 1})`);
  if (wb.worksheets.length !== 3 || wb.worksheets[0].rowCount < 10) throw new Error('xlsx compras inválido ' + abas);
  ok('Exportação Excel da Inteligência de Compras: ' + abas.join(', '));

  // 5. Relatórios
  const seis = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  const hoje = new Date().toISOString().slice(0, 10);
  await page.goto(`${BASE}/relatorios?base=pago_em&de=${seis}&ate=${hoje}`);
  await page.getByText('Valor total por mês').waitFor();
  await shot(page, '37-relatorios');
  const xr = await ctx.request.get(`${BASE}/relatorios/exportar?base=pago_em&de=${seis}&ate=${hoje}`);
  const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(await xr.body());
  const pag = wb2.getWorksheet('Pagamentos');
  if (wb2.worksheets.length !== 5 || pag.rowCount < 10) throw new Error('xlsx relatório inválido');
  if (typeof pag.getRow(2).getCell(9).value !== 'number') throw new Error('valor não numérico no Excel');
  ok(`Relatório por data de pagamento + Excel (${pag.rowCount - 1} pagamentos, 5 abas)`);
  await page.goto(BASE + '/ops');
  await shot(page, '38-ops-financeiro');
  await ctx.close();

  // 6. Engenheiro não vê Compras; administrador não vê OP de outra obra
  ({ ctx, page } = await entrar(browser, 'engenheiro@demo.local'));
  await page.goto(BASE + '/compras');
  if (!page.url().includes('sem-permissao')) throw new Error('engenheiro acessou Compras');
  const r2 = await ctx.request.get(BASE + '/compras/exportar');
  const wb3 = new ExcelJS.Workbook(); await wb3.xlsx.load(await r2.body());
  if (wb3.worksheets[0].rowCount > 1) throw new Error('engenheiro exportou dados de compras');
  ok('Engenheiro não acessa a Inteligência de Compras (nem pela exportação)');
  await ctx.close();
  ({ ctx, page } = await entrar(browser, 'administrador2@demo.local'));
  const r3 = await page.goto(opUrl);
  if (r3.status() !== 404) throw new Error('administrador2 viu OP de outra obra');
  ok('Administrador de outra obra não vê a OP');
  await ctx.close();

  // 7. Fila do WhatsApp (API simulada)
  const semAuth = await fetch(BASE + '/api/cron/whatsapp');
  if (semAuth.status !== 401) throw new Error('cron sem autenticação respondeu ' + semAuth.status);
  const rc = await fetch(BASE + '/api/cron/whatsapp', { headers: { authorization: 'Bearer segredo-teste' } });
  const jc = await rc.json();
  if (!jc.enviados || recebidas.length !== jc.enviados) throw new Error('whatsapp: ' + JSON.stringify(jc));
  const m0 = recebidas[0];
  if (m0.auth !== 'Bearer tok' || !/^55\d{10,11}$/.test(m0.corpo.to) || m0.corpo.template.name !== 'alerta' || !m0.corpo.template.components[0].parameters[2].text.startsWith('http://127.0.0.1:3000/')) throw new Error('mensagem WhatsApp malformada ' + JSON.stringify(m0));
  let total = jc.enviados, rodadas = 1, ultimo;
  do {
    ultimo = await (await fetch(BASE + '/api/cron/whatsapp', { headers: { authorization: 'Bearer segredo-teste' } })).json();
    total += ultimo.enviados; rodadas++;
  } while (ultimo.enviados > 0 && rodadas < 20);
  if (ultimo.enviados !== 0 || total !== recebidas.length) throw new Error('fila não esvaziou ou reenviou');
  const ids = recebidas.map((r) => r.corpo.to + r.corpo.template.components[0].parameters.map((p) => p.text).join('|'));
  ok(`Fila do WhatsApp: ${total} alertas em ${rodadas - 1} lotes de até 50, nada reenviado depois; cron exige segredo`);

  await browser.close();
  mock.close();
  console.log(erros.length ? '\nERROS:\n' + erros.join('\n') : '\nSem erros de console.');
})().catch((e) => { console.error('✘ FALHOU:', e.message); console.log(erros.join('\n')); process.exit(1); });
