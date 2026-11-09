// Teste de ponta a ponta: notas identificadas no cadastro do pagamento vão para a aba de contabilidade.
// Rodar com o banco recém-zerado (rodar.sh faz isso). Anexa NFS-e em XML e em PDF, e uma DANFE (produto) em PDF:
// só as três NFS-e de serviço entram na lista (XML de PJ com retenção, PDF de PF, PDF de MEI com hidráulica).
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:3000';
const EX = path.join(__dirname, '..', 'exemplos');
const PJ_XML = path.join(EX, 'nfse-pj-retencao.xml');
const PF_PDF = path.join(EX, 'nfse-pdf-pf.pdf');
const MEI_PDF = path.join(EX, 'nfse-pdf-mei-hidraulica.pdf');
const MEI_OUTROS_PDF = path.join(EX, 'nfse-pdf-mei-outros-servicos.pdf');
const DANFE_PDF = path.join(EX, 'danfe-produto.pdf');
const MEDICAO_PDF = path.join(EX, 'nfse-pdf-tabela-emitida-pela-empresa.pdf');

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
  await fin.setInputFiles('input[name=nota_fiscal]', [PJ_XML, PF_PDF, MEI_PDF, MEI_OUTROS_PDF, DANFE_PDF, MEDICAO_PDF]);
  await Promise.all([fin.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/), fin.click('button:has-text("Cadastrar e encaminhar")')]);
  console.log('✔ pagamento cadastrado com 5 arquivos de nota anexados');

  // 2. A aba mostra só as duas NFS-e identificadas
  await fin.goto(`${BASE}/notas-contabeis`);
  await fin.getByText('Instalações Elétricas Exemplo LTDA').waitFor({ timeout: 60000 });
  await fin.getByText('Maria Hidráulica MEI').first().waitFor({ timeout: 60000 });
  await fin.getByText('529.982.247-25').waitFor({ timeout: 60000 });
  const linhas = await fin.$$eval('tbody tr', (trs) => trs.length);
  if (linhas !== 3) throw new Error(`esperava 3 notas de serviço na aba, veio ${linhas}`);
  await fin.getByText('Serviço tomado de PJ com retenção').first().waitFor();
  await fin.getByText('MEI — serviços específicos').first().waitFor();
  console.log('✔ aba mostra as 3 NFS-e identificadas (XML e PDF); MEI com outro serviço e a DANFE ficaram de fora');

  // 2b. Notas de medição: anexo direto na aba (recebimento, não é pagamento)
  await fin.goto(`${BASE}/notas-medicao`);
  await fin.selectOption('select[name=obra_id]', obraV);
  await fin.setInputFiles('input[name=arquivo]', MEDICAO_PDF);
  await fin.fill('input[name=valor]', '224.599,00');
  await fin.fill('input[name=valor_liquido]', '208.652,47');
  await fin.click('button:has-text("Anexar nota")');
  await fin.getByText('Nota de medição anexada').waitFor({ timeout: 90000 });
  await fin.getByText('R$ 15.946,53').first().waitFor({ timeout: 60000 });
  await fin.getByText('R$ 15.497,33').first().waitFor();
  console.log('✔ medição anexada na aba: retido R$ 15.946,53 (7,10%), devido R$ 15.497,33 (6,90%)');

  // 3. Financeiro marca como enviada (volta à aba de notas)
  await fin.goto(`${BASE}/notas-contabeis`);
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
  await sup.getByText('Maria Hidráulica MEI').first().waitFor({ timeout: 60000 });
  const botoes = await sup.locator('button:has-text("Marcar como enviada")').count();
  if (botoes !== 0) throw new Error('suprimentos não deveria marcar notas como enviadas');
  console.log('✔ suprimentos lê a aba e não marca como enviada');

  await browser.close();
  console.log('✔ notas para contabilidade: teste concluído');
})().catch((e) => {
  console.error('✘', e.message);
  process.exit(1);
});
