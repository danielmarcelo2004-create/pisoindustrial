// Teste de ponta a ponta: notas identificadas no cadastro do pagamento vão para a aba de contabilidade.
// Rodar com o banco recém-zerado (rodar.sh faz isso). Anexa 2 NFS-e e 1 NF-e de produto: só as NFS-e entram.
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:3000';
const EX = path.join(__dirname, '..', 'exemplos');
const PJ = path.join(EX, 'nfse-pj-retencao.xml');
const PF = path.join(EX, 'nfse-pf-avulsa.xml');
const PRODUTO = path.join(EX, 'nfe-exemplo-concreto.xml');

(async () => {
  const browser = await chromium.launch();
  const novaPagina = async () => (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const entrar = async (page, email) => {
    await page.goto(`${BASE}/login`);
    await page.fill('input[name=email]', email);
    await page.fill('input[name=senha]', 'Demo-1234');
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button:has-text("Entrar")')]);
  };

  // 1. Financeiro cadastra o pagamento anexando as três notas
  const fin = await novaPagina();
  await entrar(fin, 'financeiro@demo.local');
  await fin.goto(`${BASE}/pagamentos/novo`);
  const obraV = await fin.$eval('select[name=obra_id]', (s) => [...s.options].find((o) => o.text.includes('Galpão')).value);
  await fin.selectOption('select[name=obra_id]', obraV);
  await fin.fill('input[name=favorecido]', 'Instalações Elétricas Exemplo LTDA');
  await fin.fill('input[name=descricao]', 'Serviços elétrico e de assentamento');
  await fin.fill('input[name=valor]', '5.000,00');
  await fin.fill('input[name=vencimento]', new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10));
  await fin.setInputFiles('input[name=nota_fiscal]', [PJ, PF, PRODUTO]);
  await Promise.all([fin.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/), fin.click('button:has-text("Cadastrar e encaminhar")')]);
  console.log('✔ pagamento cadastrado com 3 notas anexadas');

  // 2. A aba mostra só as duas NFS-e identificadas
  await fin.goto(`${BASE}/notas-contabeis`);
  await fin.getByText('Instalações Elétricas Exemplo LTDA').waitFor({ timeout: 60000 });
  await fin.getByText('Joana Pedreira da Silva', { exact: false }).first().waitFor({ timeout: 60000 }).catch(() => {});
  const linhas = await fin.$$eval('tbody tr', (trs) => trs.length);
  if (linhas !== 2) throw new Error(`esperava 2 notas na aba, veio ${linhas}`);
  await fin.getByText('Serviço tomado de PJ com retenção').first().waitFor();
  console.log('✔ aba mostra as 2 NFS-e identificadas (a NF-e de produto ficou de fora)');

  // 3. Financeiro marca como enviada
  await fin.click('button:has-text("Marcar como enviada")');
  await fin.getByText('Nota marcada como enviada à contabilidade').waitFor({ timeout: 60000 });
  console.log('✔ nota marcada como enviada');

  // 4. Exportação em Excel
  const resp = await fin.request.get(`${BASE}/notas-contabeis/exportar?situacao=todas`);
  if (resp.status() !== 200 || !String(resp.headers()['content-type']).includes('spreadsheetml')) {
    throw new Error(`exportação falhou: ${resp.status()} ${resp.headers()['content-type']}`);
  }
  console.log('✔ exportação Excel gerada');

  // 5. Suprimentos vê a aba, sem poder marcar como enviada
  const sup = await novaPagina();
  await entrar(sup, 'suprimentos@demo.local');
  await sup.goto(`${BASE}/notas-contabeis?situacao=todas`);
  await sup.getByText('Instalações Elétricas Exemplo LTDA').waitFor({ timeout: 60000 });
  const botoes = await sup.locator('button:has-text("Marcar como enviada")').count();
  if (botoes !== 0) throw new Error('suprimentos não deveria marcar notas como enviadas');
  console.log('✔ suprimentos lê a aba e não marca como enviada');

  await browser.close();
  console.log('✔ notas para contabilidade: teste concluído');
})().catch((e) => {
  console.error('✘', e.message);
  process.exit(1);
});
