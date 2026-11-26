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
  const { data: eng } = await sb.from('profiles_completo').select('id').eq('email', 'engenheiro@demo.local').single();
  const { data: adm } = await sb.from('profiles_completo').select('id').eq('email', 'administrador@demo.local').single();
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
  await fin.selectOption('select[name=conta_id]', { index: 1 }); // conta de onde sai o desembolso
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
  await engPage.click('a:visible:has-text("Ver fundo")');
  // Antes do primeiro gasto: dados bancários (sem eles não há formulário de gasto)
  await engPage.locator('[data-dados-bancarios-obrigatorio]').waitFor({ timeout: 30000 });
  if (await engPage.locator('button:has-text("Lançar gasto")').count()) throw new Error('regressão: o formulário de gasto aparece antes dos dados bancários');
  await engPage.fill('input[name=favorecido]', 'Eduardo Nunes da Silva');
  await engPage.fill('input[name=banco]', 'Banco Teste');
  await engPage.fill('input[name=agencia]', '1234');
  await engPage.fill('input[name=conta]', '56789-0');
  await engPage.click('button:has-text("Salvar dados bancários")');
  await engPage.locator('[data-dados-recebimento]').waitFor({ timeout: 60000 }); // o formulário dá lugar ao resumo dos dados
  await engPage.reload();
  console.log('✔ dados bancários informados antes do primeiro gasto');
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
  await engPage.click('a:visible:has-text("Ver fundo")');
  await engPage.fill('input[name=descricao]', 'Material');
  await engPage.fill('input[name=data_gasto]', hoje);
  await engPage.fill('input[name=valor]', '60,00');
  await engPage.click('button:has-text("Lançar gasto")');
  // É o último gasto (passa do valor do fundo): o formulário some e o gasto aparece na lista
  await engPage.locator('li', { hasText: 'Material' }).first().waitFor({ timeout: 60000 });
  // Sem o comprovante assinado, o administrador não consegue aprovar: o gasto avisa o que falta
  await engPage.locator('li', { hasText: 'Material' }).getByText('Aguardando comprovante assinado').first().waitFor({ timeout: 30000 });
  await engPage.locator('li', { hasText: 'Material' }).locator('input[type=file]').setInputFiles(ASSINATURA);
  await engPage.getByText('Posicione sua assinatura').waitFor({ timeout: 60000 });
  await engPage.click('button:has-text("Confirmar assinatura")');
  await engPage.getByText(/Comprovante assinado\. O original/).waitFor({ timeout: 120000 });
  await adminPage.goto(`${APP}/fundos-fixos`);
  await adminPage.click('text=Decidir');
  await adminPage.click('button:has-text("Aprovar gasto")');
  await adminPage.getByText('Gasto aprovado e somado ao saldo').waitFor({ timeout: 60000 });
  await adminPage.goto(`${APP}/fundos-fixos`);
  await adminPage.click('a:visible:has-text("Ver fundo")');
  await adminPage.getByText('Esgotado').first().waitFor({ timeout: 60000 });
  console.log('✔ fundo esgotado após o segundo gasto');

  // Sem limite: mesmo esgotado, o responsável continua podendo lançar gastos e pode solicitar o fechamento ao Financeiro
  await engPage.goto(`${APP}/fundos-fixos`);
  await engPage.click('a:visible:has-text("Ver fundo")');
  await engPage.locator('button:has-text("Lançar gasto")').first().waitFor({ timeout: 30000 });
  console.log('✔ fundo esgotado continua aceitando novo gasto');
  engPage.on('dialog', (d) => d.accept());
  await engPage.click('button:has-text("Solicitar fechamento do fundo")');
  await engPage.locator('[data-fechamento-solicitado]').waitFor({ timeout: 30000 });
  await fin.goto(`${APP}/fundos-fixos`);
  await fin.locator('[data-fechamentos-solicitados]').waitFor({ timeout: 30000 });
  await fin.locator('[data-fechamento-solicitado]').first().waitFor({ timeout: 30000 });
  console.log('✔ pedido de fechamento visível para o Financeiro (aviso na lista)');
  // Depois de solicitar: a pessoa não lança novos gastos (o formulário some)
  await engPage.reload();
  await engPage.locator('[data-fechamento-solicitado]').waitFor({ timeout: 30000 });
  if (await engPage.locator('button:has-text("Lançar gasto")').count()) throw new Error('regressão: depois de solicitar o fechamento ainda aparece "Lançar gasto"');
  console.log('✔ depois de solicitar o fechamento, não dá para lançar novo gasto');
  // O Financeiro recusa o pedido: a pessoa volta a lançar gastos e pode solicitar de novo
  fin.on('dialog', (d) => d.accept());
  await fin.click('a:visible:has-text("Ver fundo")');
  await fin.fill('input[name=motivo]', 'Ainda tem saldo');
  await fin.click('button:has-text("Recusar pedido de fechamento")');
  await fin.locator('[data-fechamento-solicitado]').waitFor({ state: 'detached', timeout: 30000 });
  await engPage.reload();
  await engPage.locator('button:has-text("Lançar gasto")').first().waitFor({ timeout: 30000 });
  if (await engPage.locator('[data-fechamento-solicitado]').count()) throw new Error('o pedido continua marcado depois da recusa');
  await engPage.click('button:has-text("Solicitar fechamento do fundo")');
  await engPage.locator('[data-fechamento-solicitado]').waitFor({ timeout: 30000 });
  console.log('✔ Financeiro recusou o pedido: a pessoa voltou a lançar gastos e solicitou de novo');

  // 5. Financeiro fecha o fundo: reposição R$ 100,00 + reembolso R$ 20,00 num único pagamento
  await fin.goto(`${APP}/fundos-fixos`);
  await fin.click('a:visible:has-text("Ver fundo")');
  await fin.click('button:has-text("Fechar e repor")');
  await fin.getByText(/Fundo reposto/).waitFor({ timeout: 60000 });
  const { data: ini } = await sb.from('pagamentos').select('valor, status').like('descricao', '%desembolso inicial').single();
  if (Number(ini.valor) !== 100 || ini.status !== 'aguardando_pagamento') throw new Error(`desembolso inicial inesperado: ${JSON.stringify(ini)}`);
  console.log('✔ criar o fundo gerou o desembolso de R$ 100,00 em Contas a pagar');
  const { data: novos } = await sb.from('fundos_fixos').select('valor, status, fundo_anterior_id').not('fundo_anterior_id', 'is', null);
  if (novos.length !== 1 || Number(novos[0].valor) !== 100 || novos[0].status === 'fechado') throw new Error(`novo fundo não abriu: ${JSON.stringify(novos)}`);
  console.log('✔ "Fechar e repor" abriu um novo fundo de R$ 100,00');
  // A lista mostra o reembolso do fundo fechado (R$ 20,00 acima do valor) e não repete "—" onde há valor
  await fin.goto(`${APP}/fundos-fixos`);
  const textoReemb = await fin.locator('td[data-reembolso]').allInnerTexts();
  if (!textoReemb.some((t) => /20,00/.test(t))) throw new Error('a lista de fundos não mostra o reembolso de R$ 20,00: ' + JSON.stringify(textoReemb));
  console.log('✔ lista de fundos mostra o reembolso quando existe');
  // A lista é separada por centro de custo (um bloco para cada), sem misturar os fundos numa tabela só
  const blocos = await fin.locator('section[data-centro-de-custo]').evaluateAll((els) => els.map((e) => ({ centro: e.getAttribute('data-centro-de-custo'), linhas: e.querySelectorAll('tbody tr').length, titulo: e.querySelector('h3')?.textContent })));
  const centrosUnicos = new Set(blocos.map((b) => b.centro));
  if (!blocos.length || centrosUnicos.size !== blocos.length) throw new Error('lista de fundos não está separada por centro de custo: ' + JSON.stringify(blocos));
  if (!blocos.some((b) => b.centro === obra.nome && b.linhas >= 2)) throw new Error('o centro de custo do teste não reúne os seus fundos: ' + JSON.stringify(blocos));
  console.log('✔ lista de fundos separada por centro de custo:', blocos.map((b) => `${b.centro} (${b.linhas})`).join(', '));
  const mob = await (await browser.newContext({ viewport: { width: 390, height: 800 } })).newPage();
  await entrar(mob, 'financeiro@demo.local');
  await mob.goto(`${APP}/fundos-fixos`);
  if (await mob.evaluate(() => [...document.querySelectorAll('table')].some((t) => t.parentElement.scrollWidth > t.parentElement.clientWidth + 2))) throw new Error('lista de fundos com rolagem lateral no celular');
  console.log('✔ lista de fundos sem rolagem lateral no celular');
  await fin.goto(`${APP}/fundos-fixos`);
  if (await fin.getByText('Criar novo de mesmo valor').count()) throw new Error('regressão: a lista de fundos ainda oferece "Criar novo de mesmo valor" depois de "Fechar e repor"');
  console.log('✔ fundo fechado não oferece "Criar novo de mesmo valor"');
  const { data: pag } = await sb.from('pagamentos').select('id, descricao, valor, fluxo, status, forma_pagamento, observacoes, favorecido').like('descricao', 'Fundo fixo%reposição%').single();
  if (pag.forma_pagamento !== 'transferencia' || !/Agência: 1234/.test(pag.observacoes)) throw new Error(`forma/dados do pagamento: ${pag.forma_pagamento} / ${pag.observacoes}`);
  if (pag.favorecido !== 'Eduardo Nunes da Silva') throw new Error(`favorecido do pagamento: ${pag.favorecido}`);
  // A OP em PDF (modelo da empresa) foi anexada ao pagamento e aparece junto com a despesa
  const { data: docs } = await sb.from('documentos').select('tipo, nome_arquivo, storage_path').eq('pagamento_id', pag.id).eq('ativo', true);
  const op = (docs ?? []).find((d) => d.tipo === 'ordem_pagamento');
  if (!op || !/^FF-\d{4}\.pdf$/.test(op.nome_arquivo)) throw new Error(`OP não anexada ao pagamento: ${JSON.stringify(docs)}`);
  const baixado = await sb.storage.from('documentos').download(op.storage_path);
  const bytes = Buffer.from(await baixado.data.arrayBuffer());
  if (bytes.slice(0, 4).toString() !== '%PDF') throw new Error('o anexo não é um PDF');
  console.log('✔ OP em PDF anexada ao pagamento do fechamento:', op.nome_arquivo);
  if (!/reposição de R\$ 100,00 \+ reembolso de R\$ 20,00/.test(pag.descricao) || Number(pag.valor) !== 120 || pag.fluxo !== 'C') {
    throw new Error(`pagamento de fechamento inesperado: ${JSON.stringify(pag)}`);
  }
  console.log('✔ pagamento de fechamento:', pag.descricao, '-', pag.valor);

  // Quem não tem assinatura cadastrada não lança gasto: aparece o aviso com o link para cadastrar
  const { data: sup } = await sb.from('profiles_completo').select('id').eq('email', 'suprimentos@demo.local').single();
  await fin.goto(`${APP}/fundos-fixos`);
  await fin.selectOption('select[name=obra_id]', obra.id);
  await fin.selectOption('select[name=pessoa_id]', sup.id);
  await fin.fill('input[name=valor]', '50,00');
  await fin.selectOption('select[name=conta_id]', { index: 1 });
  await fin.click('button:has-text("Criar fundo")');
  await fin.getByText('Fundo fixo criado').waitFor({ timeout: 60000 });
  const supPage = await novoPagina();
  monitorar(supPage);
  await entrar(supPage, 'suprimentos@demo.local');
  await supPage.goto(`${APP}/fundos-fixos`);
  await supPage.click('a:visible:has-text("Ver fundo")');
  await supPage.locator('[data-sem-assinatura]').waitFor({ timeout: 30000 });
  if (await supPage.locator('button:has-text("Lançar gasto")').count()) throw new Error('sem assinatura cadastrada ainda mostra o botão "Lançar gasto"');
  console.log('✔ sem assinatura cadastrada: não lança gasto (aviso com o link para cadastrar)');

  if (erros.length) console.log('[erros de página]', erros);
  await browser.close();
  if (erros.length) process.exit(1);
  console.log('✔ fundo fixo: teste concluído');
})().catch((e) => {
  console.error('✘', e.message);
  process.exit(1);
});
