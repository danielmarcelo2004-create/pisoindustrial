const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '.saida');
fs.mkdirSync(DIR, { recursive: true });
const BASE = 'http://127.0.0.1:3000';
const SENHA = 'Demo-1234';
const pdfPath = path.join(DIR, 'boleto-teste.pdf');
fs.writeFileSync(pdfPath, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const erros = [];
let passo = 0;
const ok = (m) => console.log(`✔ ${++passo}. ${m}`);

async function entrar(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.push(`[${email}] pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') erros.push(`[${email}] console: ${m.text()}`); });
  await page.goto(BASE + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=senha]', SENHA);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button:has-text("Entrar")')]);
  return { ctx, page };
}
const shot = (page, nome) => page.screenshot({ path: path.join(DIR, nome + '.png'), fullPage: true });

(async () => {
  const browser = await chromium.launch();

  // 1. Suprimentos cadastra pagamento com boleto
  let { ctx, page } = await entrar(browser, 'suprimentos@demo.local');
  await shot(page, '01-painel-suprimentos');
  await page.goto(BASE + '/pagamentos/novo');
  await page.selectOption('select[name=obra_id]', { label: /Galpão/ }).catch(async () => {
    const v = await page.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão')).value);
    await page.selectOption('select[name=obra_id]', v);
  });
  const fornV = await page.$eval('select[name=fornecedor_id]', (s) => [...s.options].find((o) => o.text.includes('Aço Forte')).value);
  await page.selectOption('select[name=fornecedor_id]', fornV);
  await page.fill('input[name=descricao]', 'Fibra de aço para concreto — 800 kg');
  await page.fill('input[name=valor]', '3.500,75');
  await page.fill('input[name=vencimento]', new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10));
  await page.setInputFiles('input[name=boleto]', pdfPath);
  await shot(page, '02-novo-pagamento');
  await Promise.all([page.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/), page.click('button:has-text("Cadastrar e encaminhar")')]);
  await page.getByText('Aguardando engenheiro').first().waitFor();
  await page.getByText('boleto-teste.pdf').first().waitFor();
  const urlNovo = page.url();
  await shot(page, '03-pagamento-criado');
  ok('Suprimentos cadastrou pagamento com boleto → aguardando engenheiro');

  // Suprimentos NÃO pode cadastrar na obra C (sem acesso): opção não aparece
  await page.goto(BASE + '/pagamentos/novo');
  const opcoes = await page.$$eval('select[name=obra_id] option', (os) => os.map((o) => o.textContent));
  if (opcoes.some((o) => o.includes('Aracaju'))) throw new Error('Suprimentos vê obra sem acesso no cadastro');
  ok('Suprimentos só vê no cadastro as obras liberadas');
  // e não acessa usuários
  await page.goto(BASE + '/usuarios');
  if (!page.url().includes('sem-permissao')) throw new Error('Suprimentos acessou /usuarios');
  ok('Suprimentos é barrado em Usuários');
  await ctx.close();

  // 2. Engenheiro assina em lote
  ({ ctx, page } = await entrar(browser, 'engenheiro@demo.local'));
  await shot(page, '04-painel-engenheiro');
  await page.goto(BASE + '/aprovacoes');
  const linhas = await page.locator('tbody tr').count();
  await page.check('input[aria-label="Selecionar todos"]');
  await page.click('text=Revisar e assinar selecionados');
  await page.check('input[name=conferi]');
  await page.fill('input[name=senha]', 'senha-errada');
  await page.click('[role=dialog] button[type=submit]');
  await page.getByText('Senha incorreta').waitFor();
  ok('Assinatura recusada com senha errada');
  await page.fill('input[name=senha]', SENHA);
  await shot(page, '05-assinatura-lote');
  await page.click('[role=dialog] button[type=submit]');
  await page.getByText(/documentos assinados|Documento assinado/).waitFor();
  ok(`Engenheiro assinou ${linhas} documento(s) em lote`);
  await ctx.close();

  // 3. Administrador assina individualmente o novo pagamento
  ({ ctx, page } = await entrar(browser, 'administrador@demo.local'));
  await page.goto(urlNovo);
  await page.getByText('Sua assinatura').waitFor();
  await page.check('input[name=conferi]');
  await page.fill('input[name=senha]', SENHA);
  await shot(page, '06-detalhe-assinatura-admin');
  await page.click('button:has-text("Assinar e aprovar")');
  await page.getByText('Documento assinado e encaminhado').waitFor();
  await page.getByText('Liberado p/ pagamento').first().waitFor();
  ok('Administrador assinou → liberado para o Financeiro');
  await ctx.close();

  // 4. Isolamento: administrador2 não abre pagamento de outra obra
  ({ ctx, page } = await entrar(browser, 'administrador2@demo.local'));
  const resp = await page.goto(urlNovo);
  if (resp.status() !== 404) throw new Error('administrador2 abriu pagamento de outra obra: ' + resp.status());
  const docId = null;
  await page.goto(BASE + '/pagamentos');
  const textoLista = await page.locator('main').innerText();
  if (textoLista.includes('Galpão')) throw new Error('administrador2 vê pagamentos da obra A');
  ok('Administrador de outra obra recebe 404 e não vê a obra na lista');
  await ctx.close();

  // 5. Financeiro dá baixa com comprovante
  ({ ctx, page } = await entrar(browser, 'financeiro@demo.local'));
  await shot(page, '07-painel-financeiro');
  await page.goto(urlNovo);
  await page.getByText('Registrar pagamento').first().waitFor();
  await page.setInputFiles('input[name=comprovante]', pdfPath);
  await page.click('button:has-text("Confirmar pagamento")');
  await page.getByText('Pagamento registrado como pago').waitFor();
  await page.reload();
  await page.locator('text=Comprovante de pagamento').first().waitFor();
  await shot(page, '08-pagamento-pago');
  ok('Financeiro registrou o pagamento com comprovante');

  // download do documento funciona para o financeiro
  const href = await page.locator('a[href^="/documentos/"]').first().getAttribute('href');
  const r = await ctx.request.get(BASE + href + '?baixar=1', { maxRedirects: 5 });
  if (r.status() !== 200) throw new Error('download falhou ' + r.status());
  ok('Download de documento via link temporário');

  for (const [rota, nome] of [['/agenda', '09-agenda'], ['/pagamentos', '10-pagamentos'], ['/auditoria', '11-auditoria'], ['/obras', '12-obras'], ['/usuarios', '13-usuarios'], ['/notificacoes', '14-notificacoes'], ['/fornecedores', '15-fornecedores']]) {
    const rr = await page.goto(BASE + rota);
    if (rr.status() !== 200) throw new Error(rota + ' ' + rr.status());
    await shot(page, nome);
  }
  await page.goto(BASE + '/obras');
  await page.click('text=Galpão Logístico Camaçari');
  await page.waitForURL(/\/obras\/[0-9a-f-]{36}/);
  await shot(page, '16-obra');
  ok('Agenda, listas, auditoria, obras, usuários, notificações e fornecedores abrem');

  // exportação CSV
  const csv = await ctx.request.get(BASE + '/pagamentos/exportar');
  const corpo = await csv.text();
  if (!corpo.includes('Favorecido') || !corpo.includes('Concreteira')) throw new Error('CSV inválido');
  ok('Exportação para planilha (CSV)');

  // 6. Financeiro cria usuário
  await page.goto(BASE + '/usuarios/novo');
  await page.fill('input[name=nome]', 'Paula Teste');
  await page.fill('input[name=email]', 'paula@demo.local');
  await page.selectOption('select[name=perfil]', 'suprimentos');
  const senhaProv = await page.inputValue('input[name=senha]');
  await page.locator('label:has-text("Galpão") input').check();
  await page.click('button:has-text("Criar usuário")');
  await page.getByText('Credenciais provisórias').waitFor();
  await shot(page, '17-usuario-criado');
  ok('Financeiro criou usuário com senha provisória');
  await ctx.close();

  // 7. Primeiro acesso obriga troca de senha
  ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  page = await ctx.newPage();
  await page.goto(BASE + '/login');
  await page.fill('input[name=email]', 'paula@demo.local');
  await page.fill('input[name=senha]', senhaProv);
  await Promise.all([page.waitForURL(/trocar-senha/), page.click('button[type=submit]')]);
  await shot(page, '18-primeiro-acesso');
  await page.fill('input[name=senha]', 'NovaSenha123');
  await page.fill('input[name=confirmacao]', 'NovaSenha123');
  await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button[type=submit]')]);
  await page.getByText('Senha definida com sucesso').waitFor();
  ok('Primeiro acesso exige criar senha própria');
  await ctx.close();

  // 8. Mobile
  ctx = await browser.newContext({ ...require('playwright').devices['iPhone 13'] });
  page = await ctx.newPage();
  await page.goto(BASE + '/login');
  await shot(page, '19-login-mobile');
  await page.fill('input[name=email]', 'engenheiro@demo.local');
  await page.fill('input[name=senha]', SENHA);
  await Promise.all([page.waitForURL((u) => u.pathname === '/'), page.click('button[type=submit]')]);
  await shot(page, '20-painel-mobile');
  const largura = await page.evaluate(() => document.documentElement.scrollWidth);
  if (largura > 400) erros.push('Rolagem horizontal no celular: ' + largura);
  ok('Layout no celular');
  await ctx.close();

  await browser.close();
  console.log(erros.length ? '\nERROS:\n' + erros.join('\n') : '\nSem erros de console.');
})().catch((e) => { console.error('✘ FALHOU:', e.message); console.log(erros.join('\n')); process.exit(1); });
