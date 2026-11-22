// Regressões dos bugs relatados pelo usuário (um teste por bug, dados fictícios).
// Cada teste diz qual problema foi relatado; ele falha se o problema voltar.
// Pré-requisitos: banco local recriado + seed (`npm run seed:demo`) e o sistema em http://127.0.0.1:3000.
const { chromium, devices } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const SENHA = 'Demo-1234';
const DIR = path.join(__dirname, '.saida');
fs.mkdirSync(DIR, { recursive: true });
const pdf = (nome) => { const p = path.join(DIR, nome); fs.writeFileSync(p, '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'); return p; };
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const um = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };

let ok = 0, tot = 0, errosJS = 0;
const falhas = [];
async function regressao(nome, fn) {
  tot++;
  try {
    const ev = await fn();
    ok++;
    console.log(`✔ regressão: ${nome}${ev ? ` — ${ev}` : ''}`);
  } catch (e) {
    falhas.push(nome);
    console.log(`✘ regressão: ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`);
  }
}
const confere = (cond, msg) => { if (!cond) throw new Error(msg); };

async function entrar(b, email, opcoes = { viewport: { width: 1440, height: 900 } }) {
  const p = await (await b.newContext(opcoes)).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS [${email}] ${e.message.slice(0, 200)}`); });
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=senha]', SENHA);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
  return p;
}
async function cliente(email) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  await c.auth.signInWithPassword({ email, password: SENHA });
  return c;
}
const ir = async (p, url) => { await p.goto(BASE + url); await p.waitForLoadState('networkidle'); };
const br = (iso) => iso.split('-').reverse().join('/');

(async () => {
  const b = await chromium.launch();
  const cf = await cliente('financeiro@demo.local');
  const obraC = (await um(admin.from('obras').select('id').eq('fluxo', 'C').order('nome').limit(1)))[0].id;
  const obraA = (await um(admin.from('obras').select('id, nome').eq('fluxo', 'A').order('nome').limit(1)))[0];
  const conta = (await um(admin.from('contas_bancarias').select('id').limit(1)))[0].id;
  const fin = await entrar(b, 'financeiro@demo.local');
  const sup = await entrar(b, 'suprimentos@demo.local');

  // Despesa parcelada (3x, vencimentos em meses diferentes), liberada (centro de custo do fluxo C)
  const parcelado = await um(cf.rpc('criar_pagamento', { p_obra_id: obraC, p_fornecedor_id: null, p_favorecido: 'Regressao Parcelado', p_descricao: 'Três parcelas', p_valor: 900, p_vencimento: '2027-03-10', p_forma_pagamento: 'pix' }));
  await um(cf.rpc('definir_parcelas', { p_pagamento_id: parcelado, p_parcelas: ['2027-03-10', '2027-04-10', '2027-05-10'].map((v) => ({ valor: 300, vencimento: v, multa: 0, juros: 0, desconto: 0, motivo: null })) }));

  await regressao('OP pode ter mais de uma parcela (relato: "não está aparecendo a possibilidade de criar uma OP com mais de uma parcela")', async () => {
    await ir(sup, '/pagamentos/novo');
    await sup.selectOption('select[aria-label="Forma de pagamento"]', 'pix');
    await sup.getByText('Dados da solicitação').waitFor();
    await sup.fill('input[name=parcelas]', '3');
    await sup.waitForTimeout(300);
    // A 1ª parcela usa o vencimento da OP; todas têm o campo de valor
    const linhas = await sup.locator('input[aria-label^="Valor da parcela"]').count();
    const titulo = await sup.getByText('Parcelas (3)').count();
    confere(linhas === 3 && titulo === 1, `formulário mostra ${linhas} parcela(s) em vez de 3`);
    return '"Parcelas (3)" com 3 linhas no formulário da OP';
  });

  await regressao('OP enviada gera pagamento COM o PDF da OP anexado (relato: "pagamento aparece como sem documento, mesmo sendo gerada a OP")', async () => {
    await ir(sup, '/pagamentos/novo');
    await sup.selectOption('select[aria-label="Forma de pagamento"]', 'pix');
    await sup.getByText('Dados da solicitação').waitFor();
    await sup.selectOption('select[name=obra_id]', obraA.id);
    await sup.click('button[aria-label="Categoria"]'); await sup.locator('[role=option]').first().click();
    await sup.selectOption('select[aria-label="Conta bancária"]', conta).catch(() => {});
    await sup.fill('input[name=favorecido]', 'Regressao OP Documento');
    await sup.fill('input[name=descricao]', 'Serviço avulso');
    await sup.fill('input[name=vencimento]', '2027-02-15');
    await sup.fill('input[name=banco]', 'Banco Teste');
    await sup.fill('input[name=chave_pix]', '529.982.247-25');
    await sup.fill('input[aria-label="Descrição do item 1"]', 'Serviço');
    await sup.fill('input[aria-label="Unidade do item 1"]', 'un');
    await sup.fill('input[aria-label="Quantidade do item 1"]', '1');
    await sup.fill('input[aria-label="Valor unitário do item 1"]', '410,00');
    await Promise.all([sup.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 60000 }), sup.click('button:has-text("Salvar e enviar")')]);
    const id = sup.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const docs = await um(admin.from('documentos').select('id').eq('pagamento_id', id).eq('ativo', true));
    confere(docs.length >= 1, 'pagamento da OP ficou sem documento');
    await ir(fin, '/pagamentos?periodo=todos&busca=Regressao OP Documento');
    const temClipe = await fin.locator(`tr[data-linha="pag:${id}"] a[title], tr[data-linha="pag:${id}"]`).first().innerHTML();
    confere(/📎|clipe|Anexo|svg/i.test(temClipe), 'lista não mostra o anexo');
    return `${docs.length} documento(s) no pagamento`;
  });

  await regressao('pagamento parcelado aparece parcela por parcela, cada uma no próprio vencimento (relato: "as parcelas com datas diferentes aparecem em pagamentos e em agenda")', async () => {
    await ir(fin, '/pagamentos?periodo=todos&busca=Regressao Parcelado');
    const linhas = await fin.locator('tr[data-linha^="parc:"]').allInnerTexts();
    confere(linhas.length === 3, `${linhas.length} linha(s) de parcela na lista em vez de 3`);
    for (const [i, v] of ['2027-03-10', '2027-04-10', '2027-05-10'].entries()) confere(linhas[i].includes(br(v)) && linhas[i].includes(`parcela ${i + 1}/3`), `parcela ${i + 1} fora do vencimento ${br(v)}`);
    await ir(fin, '/agenda?mes=2027-04&dia=2027-04-10');
    const dia = await fin.locator('main').innerText();
    confere(/Regressao Parcelado/.test(dia), 'parcela 2/3 não aparece no dia 10/04 da agenda');
    return '3 linhas (10/03, 10/04, 10/05) e a 2ª na agenda de 10/04';
  });

  await regressao('detalhe do pagamento de 3 parcelas mostra as 3 e não oferece criar mais (relato: "só aparecem 2 e permite criar mais parcelas")', async () => {
    await ir(fin, `/pagamentos/${parcelado}`);
    const t = await fin.locator('main').innerText();
    const n = (t.match(/Parcela \d de 3/g) || []).length;
    confere(n >= 3, `detalhe mostra ${n} parcela(s)`);
    confere(!/Dividir em parcelas|Adicionar parcela/i.test(t), 'ainda oferece dividir/adicionar parcelas');
    return `${n} parcelas, sem "Dividir em parcelas"`;
  });

  await regressao('provisão aparece na agenda no dia do vencimento e em Contas a pagar (relato: "no dia 10, por mais que tenha uma provisão, ela não aparece")', async () => {
    await um(admin.from('provisoes').insert({ obra_id: obraC, descricao: 'Regressao Provisao Luz', vencimento: '2027-06-10', mes_referencia: '2027-06', valor_estimado: 180, status: 'provisionada', created_by: (await um(admin.from('profiles').select('id').eq('email', 'financeiro@demo.local').single())).id }));
    await ir(fin, '/agenda?mes=2027-06&dia=2027-06-10');
    confere(/Regressao Provisao Luz/.test(await fin.locator('main').innerText()), 'provisão não aparece no dia da agenda');
    await ir(fin, '/pagamentos?periodo=personalizado&de=2027-06-01&ate=2027-06-30');
    confere(/Regressao Provisao Luz/.test(await fin.locator('main').innerText()), 'provisão não aparece em Contas a pagar');
    return 'na agenda (10/06) e em Contas a pagar';
  });

  await regressao('vários arquivos no mesmo campo de anexo (relato: "não consigo anexar mais de um boleto ou nota fiscal")', async () => {
    await ir(fin, '/pagamentos/novo');
    const multiplo = await fin.locator('input[type=file][aria-label="Escolher arquivos"]').first().getAttribute('multiple');
    confere(multiplo !== null, 'campo de boleto não aceita vários arquivos');
    await fin.selectOption('select[name=obra_id]', obraC);
    await fin.click('button[aria-label="Categoria"]'); await fin.locator('[role=option]').first().click();
    await fin.selectOption('select[aria-label="Conta bancária"]', conta).catch(() => {});
    await fin.fill('input[name=favorecido]', 'Regressao Dois Boletos');
    await fin.fill('input[name=descricao]', 'Duas notas na mesma duplicata');
    await fin.fill('input[name=valor]', '200,00');
    await fin.fill('input[name=vencimento]', '2027-02-20');
    await fin.locator('input[type=file][aria-label="Escolher arquivos"]').nth(1).setInputFiles([pdf('nota-a.pdf'), pdf('nota-b.pdf')]);
    await fin.waitForTimeout(1500);
    await Promise.all([fin.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 60000 }), fin.click('button:has-text("Cadastrar e encaminhar")')]);
    const id = fin.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const docs = await um(admin.from('documentos').select('nome_arquivo').eq('pagamento_id', id).eq('ativo', true));
    confere(docs.length === 2, `${docs.length} arquivo(s) salvo(s) em vez de 2`);
    return docs.map((d) => d.nome_arquivo).join(' + ');
  });

  await regressao('um campo só de descrição na OP, sem "Observação" duplicada (relato: "não entendi a lógica de ter 2 campos para preencher com observação")', async () => {
    await ir(sup, '/pagamentos/novo');
    await sup.selectOption('select[aria-label="Forma de pagamento"]', 'pix');
    await sup.getByText('Dados da solicitação').waitFor();
    const obs = await sup.locator('[name=observacoes]').count();
    const desc = await sup.locator('input[name=descricao]').count();
    confere(obs === 0 && desc === 1, `descrição=${desc} observação=${obs}`);
    return 'só "Descrição"';
  });

  await regressao('sem o botão "Assinatura do cadastro" (relato: "para que está servindo esse botão se já aparece quem criou na linha do tempo?")', async () => {
    await ir(fin, '/pagamentos/novo');
    const a = await fin.locator('main').innerText();
    await ir(fin, `/pagamentos/${parcelado}`);
    const b2 = await fin.locator('main').innerText();
    confere(!/Assinatura do cadastro|Assinar no cadastro/i.test(a + b2), 'texto de assinatura do cadastro ainda aparece');
    return 'ausente na nova despesa e no detalhe';
  });

  await regressao('o botão é "Baixar" (não "Baixar em lote") e existe baixa individual pelas Ações (relato: "não tem a opção de baixar individualmente")', async () => {
    await ir(fin, '/pagamentos?periodo=todos');
    const botoes = (await fin.locator('#form-baixar button').allInnerTexts()).map((x) => x.trim());
    confere(botoes.includes('Baixar') && !botoes.some((x) => /^Baixar em lote/i.test(x)), `botões: ${botoes.join(' | ')}`);
    const linha = fin.locator('tr[data-linha] input.caixa-baixar[data-baixavel="1"]').first();
    const chave = await linha.getAttribute('value');
    await fin.locator(`tr[data-linha="${chave}"]`).getByRole('button', { name: /^Ações/ }).click();
    const itens = await fin.locator(`tr[data-linha="${chave}"] [role=menuitem]`).allInnerTexts();
    confere(itens.map((x) => x.trim()).includes('Baixar'), `Ações sem "Baixar": ${itens.join(' | ')}`);
    return '"Baixar" na barra e nas Ações da linha';
  });

  await regressao('editar o valor de um pagamento com boleto avisa para anexar o boleto novo (relato: "o boleto antigo depois de editar o valor")', async () => {
    const pg = await um(admin.from('documentos').select('pagamento_id, pagamento:pagamentos(status)').eq('tipo', 'boleto').eq('ativo', true).limit(20));
    const alvo = pg.find((x) => x.pagamento && !['pago', 'cancelado'].includes(x.pagamento.status));
    confere(alvo, 'sem pagamento com boleto para testar');
    await ir(fin, `/pagamentos/${alvo.pagamento_id}/editar`);
    const t = await fin.locator('main').innerText();
    confere(/Se o valor ou o vencimento mudou, anexe o\s+boleto novo/.test(t), 'aviso do boleto novo não aparece');
    return 'aviso presente na edição';
  });

  await regressao('"Mais filtros": a janela fecha ao aplicar e o filtro vira etiqueta (relato: "a janela de filtro ainda fica aberta e atrapalha"; "layout desconfigurado")', async () => {
    await ir(fin, '/pagamentos?periodo=todos');
    await fin.getByRole('button', { name: /^Mais filtros/ }).click();
    await fin.getByRole('menuitem', { name: 'Forma de pagamento' }).click();
    await fin.getByRole('dialog').locator('label', { hasText: 'PIX' }).click();
    await fin.getByRole('dialog').getByRole('button', { name: 'Aplicar' }).click();
    await fin.waitForURL(/forma=pix/);
    await fin.waitForLoadState('networkidle');
    confere((await fin.locator('[role=dialog], [role=menu]').count()) === 0, 'janela continuou aberta');
    confere(/Forma de pagamento: PIX/.test(await fin.locator('[data-filtro="forma"]').innerText()), 'etiqueta do filtro não apareceu');
    return 'janela fechou; etiqueta "Forma de pagamento: PIX"';
  });

  await regressao('as contas marcadas continuam marcadas ao abrir uma e voltar (relato: "seleciono 5, abro um e volto… já não estão mais selecionados")', async () => {
    await ir(fin, '/pagamentos?periodo=todos');
    const v = await fin.locator('input.caixa-baixar').evaluateAll((els) => els.slice(0, 3).map((e) => e.value));
    for (const x of v) await fin.locator(`input.caixa-baixar[value="${x}"]`).check();
    await Promise.all([fin.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/), fin.locator(`tr[data-linha="${v[0]}"] a[href^="/pagamentos/"]`).first().click()]);
    await Promise.all([fin.waitForURL(/\/pagamentos\?/), fin.getByRole('link', { name: '← Contas a pagar' }).click()]);
    await fin.waitForLoadState('networkidle'); await fin.waitForTimeout(400);
    const marcadas = await fin.locator('input.caixa-baixar:checked').count();
    confere(marcadas === 3, `${marcadas} marcada(s) depois de voltar`);
    await fin.getByRole('button', { name: 'Desmarcar todas' }).click();
    return '3 continuam marcadas';
  });

  await regressao('engenheiro que abre uma conta pela lista volta para "Contas a pagar" pela seta', async () => {
    const eng = await entrar(b, 'engenheiro@demo.local');
    await ir(eng, '/pagamentos?periodo=todos');
    await Promise.all([eng.waitForURL(/origem=contas/), eng.locator('tr[data-linha] a[href^="/pagamentos/"]').first().click()]);
    const seta = (await eng.locator('a', { hasText: /^← / }).first().innerText()).trim();
    await eng.context().close();
    confere(seta === '← Contas a pagar', `seta: ${seta}`);
    return seta;
  });

  await regressao('nada sobreposto nem estourando no celular nas telas principais (relato: "tem itens sobrepostos")', async () => {
    const p = await entrar(b, 'financeiro@demo.local', { ...devices['iPhone 13'] });
    const r = [];
    for (const u of ['/', '/pagamentos', '/pagamentos/novo', `/pagamentos/${parcelado}`, '/agenda', '/provisoes', '/contas-bancarias', '/fundos-fixos']) {
      await ir(p, u);
      const e = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (e > 4) r.push(`${u} (+${e}px)`);
    }
    await p.context().close();
    confere(!r.length, `estoura: ${r.join(', ')}`);
    return '8 telas sem estouro';
  });

  console.log(`\nRegressões: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  if (falhas.length || errosJS) process.exit(1);
})();
