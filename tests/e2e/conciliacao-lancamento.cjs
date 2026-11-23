// Conciliação: "Novo lançamento" e "Nova transferência" para movimentações sem conta a pagar correspondente.
// Extratos OFX fictícios gerados aqui. Inclui a regressão da planilha que ignorava o filtro "Conta bancária".
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const SENHA = 'Demo-1234';
const DIR = path.join(__dirname, '.saida');
fs.mkdirSync(DIR, { recursive: true });
const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const um = async (q) => { const { data, error } = await q; if (error) throw new Error(error.message); return data; };

// OFX fictício no formato da Caixa (tudo numa linha)
function ofx(nome, banco, agencia, conta, linhas) {
  const t = linhas.map(([d, v, memo, id]) => `<STMTTRN><TRNTYPE>${v < 0 ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${d.replace(/-/g, '')}030000<TRNAMT>${v}<FITID>${id}<MEMO>${memo}</STMTTRN>`).join('');
  const txt = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:1252\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>${banco}<BRANCHID>${agencia}<ACCTID>${conta}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261201<DTEND>20261231${t}</BANKTRANLIST><LEDGERBAL><BALAMT>1000.00<DTASOF>20261231</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const p = path.join(DIR, nome);
  fs.writeFileSync(p, Buffer.from(txt, 'latin1'));
  return p;
}

let ok = 0, tot = 0, errosJS = 0;
const falhas = [];
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { falhas.push(nome); console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };
async function entrar(b, email) {
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS [${email}] ${e.message.slice(0, 200)}`); });
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', email); await p.fill('input[name=senha]', SENHA);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
  return p;
}
const ir = async (p, url) => { await p.goto(BASE + url); await p.waitForLoadState('networkidle'); };
// Pela descrição do banco (as listas de fornecedores da linha também contêm nomes)
const linha = (p, texto) => p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: texto }) }).first();
async function importar(p, arquivo) {
  await ir(p, '/contas-bancarias');
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: 'Importar extrato OFX' }).first().click()]);
  await fc.setFiles(arquivo);
  await p.waitForURL(/importado=/, { timeout: 60000 });
  await p.waitForLoadState('networkidle');
}

(async () => {
  const b = await chromium.launch();
  const fin = await entrar(b, 'financeiro@demo.local');
  const obraA = (await um(admin.from('obras').select('id, nome, engenheiro_id').eq('fluxo', 'A').order('nome').limit(1)))[0];
  const cats = await um(admin.from('categorias').select('id, nome').eq('ativo', true).order('nome'));
  const forn = (await um(admin.from('fornecedores').select('id, nome').order('nome').limit(1)))[0];
  // Histórico para o ⚡: um lançamento anterior desse fornecedor (o nome aparece na descrição do banco)
  const cf = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  await cf.auth.signInWithPassword({ email: 'financeiro@demo.local', password: SENHA });
  const ant = await um(cf.rpc('criar_pagamento', { p_obra_id: obraA.id, p_fornecedor_id: forn.id, p_favorecido: forn.nome, p_descricao: 'Compra anterior', p_valor: 10, p_vencimento: '2026-11-01', p_forma_pagamento: 'pix' }));
  await um(cf.rpc('definir_categoria', { p_pagamento_id: ant, p_categoria_id: cats[1].id }));

  const nomeForn = forn.nome.toUpperCase();
  const origem = ofx('origem.ofx', '0104', '0099', '0001231231234', [
    ['2026-12-05', -3000, 'SAQUE DIN ATM 05/12 10:16 SOP-FULANA DE TAL', 'A1'],
    ['2026-12-06', -1212, `PIX ENVIADO 06/12 ${nomeForn}`, 'A2'],
    ['2026-12-07', -2700, 'ENVIO TRANSF INTERNET TEV', 'A3'],
    ['2026-12-08', -77, 'BOLETO SEM HISTORICO', 'A4'],
  ]);
  const destino = ofx('destino.ofx', '001', '', '98765-4', [['2026-12-08', 2700, 'TRANSFERENCIA RECEBIDA 08/12', 'B1']]);

  await passo('importar os dois extratos fictícios (origem Caixa e destino BB)', async () => {
    await importar(fin, origem); await importar(fin, destino);
    const contas = await um(admin.from('contas_bancarias').select('id, nome, banco').in('banco', ['104', '001']));
    confere(contas.length >= 2, 'contas não criadas');
    return contas.map((c) => c.nome).join(' · ');
  });
  const cOrigem = (await um(admin.from('contas_bancarias').select('id').eq('banco', '104').eq('agencia', '99').single())).id;
  const cDestino = (await um(admin.from('contas_bancarias').select('id').eq('banco', '001').eq('conta', '987654').single())).id;

  await passo('sem conta a pagar parecida: o sistema mostra "Novo lançamento" e "Nova transferência", com a descrição do banco já preenchida', async () => {
    await ir(fin, `/contas-bancarias?conta=${cOrigem}`);
    const l = linha(fin, 'SAQUE DIN ATM');
    confere(await l.getByRole('tab', { name: 'Novo lançamento' }).count() === 1, 'aba Novo lançamento ausente');
    confere(await l.getByRole('tab', { name: 'Nova transferência' }).count() === 1, 'aba Nova transferência ausente');
    const desc = await l.locator('input[aria-label="Descrição do novo lançamento"]').inputValue();
    confere(/SAQUE DIN ATM 05\/12 10:16 SOP-FULANA DE TAL/.test(desc), `descrição: ${desc}`);
    confere(await l.locator('[data-conciliar-novo]').isDisabled(), 'Conciliar deveria esperar categoria e centro de custo');
    await fin.screenshot({ path: path.join(DIR, 'conc-novo-lancamento.png') });
    return 'abas, descrição e Conciliar bloqueado até escolher categoria e centro de custo';
  });

  await passo('⚡ sugestão: fornecedor do histórico na descrição → categoria, centro de custo e fornecedor já vêm preenchidos', async () => {
    const l = linha(fin, nomeForn);
    const [c, o, f] = await Promise.all(['Categoria', 'Centro de custo', 'Fornecedor'].map((r) => l.locator(`select[aria-label="${r} do novo lançamento"]`).inputValue()));
    confere(c === cats[1].id && o === obraA.id && f === forn.id, `categoria=${c} obra=${o} fornecedor=${f}`);
    confere(await l.locator('text=⚡ sugerido').count() >= 2, 'marcação ⚡ ausente');
    return `${cats[1].nome} · ${obraA.nome} · ${forn.nome}`;
  });

  await passo('Conciliar o novo lançamento: despesa paga e conciliada, sem aprovação, marcada e com aviso ao engenheiro', async () => {
    const l = linha(fin, nomeForn);
    await l.locator('[data-conciliar-novo]').click();
    await fin.waitForFunction((t) => !Array.from(document.querySelectorAll('[data-linha-banco]')).some((e) => e.textContent.includes(t)), nomeForn, { timeout: 20000 });
    const p = (await um(admin.from('pagamentos').select('id, status, pago_em, valor_pago, lancado_conciliacao, categoria_id, fornecedor_id, conta_bancaria_id').eq('lancado_conciliacao', true).eq('fornecedor_id', forn.id)))[0];
    confere(p && p.status === 'pago' && p.pago_em === '2026-12-06' && Number(p.valor_pago) === 1212 && p.conta_bancaria_id === cOrigem, JSON.stringify(p));
    const aviso = await um(admin.from('notificacoes').select('id').eq('pagamento_id', p.id).eq('titulo', 'Despesa lançada pela conciliação'));
    confere(aviso.length >= 1, 'sem aviso');
    return `pago em 06/12, R$ 1.212,00, ${aviso.length} aviso(s)`;
  });

  await passo('"Completar informações": tela completa com juros/multa/desconto; total precisa bater com o banco', async () => {
    await ir(fin, `/contas-bancarias?conta=${cOrigem}`);
    const l = linha(fin, 'SAQUE DIN ATM');
    await l.getByRole('button', { name: 'Completar informações' }).click();
    const d = fin.getByRole('dialog', { name: 'Completar informações do lançamento' });
    await d.locator('select[name=categoria_id]').selectOption(cats[0].id);
    await d.locator('select[name=obra_id]').selectOption(obraA.id);
    await d.locator('input[aria-label="Valor da despesa"]').fill('2.990,00');
    const bloq = await d.getByRole('button', { name: 'Salvar e conciliar' }).isDisabled();
    await d.locator('input[aria-label="juros"]').fill('10,00');
    await d.locator('textarea[name=observacoes]').fill('Saque para pagamento de diárias');
    await fin.screenshot({ path: path.join(DIR, 'conc-completar.png') });
    await d.getByRole('button', { name: 'Salvar e conciliar' }).click();
    await d.waitFor({ state: 'detached', timeout: 30000 });
    const p = (await um(admin.from('pagamentos').select('valor, valor_pago, observacoes, status').eq('lancado_conciliacao', true).eq('descricao', 'SAQUE DIN ATM 05/12 10:16 SOP-FULANA DE TAL')))[0];
    confere(bloq && p && Number(p.valor) === 2990 && Number(p.valor_pago) === 3000 && /Juros: R\$ 10,00/.test(p.observacoes) && /diárias/.test(p.observacoes), JSON.stringify(p));
    return 'bloqueado até bater; salvo com valor 2.990 + juros 10 = 3.000';
  });

  await passo('Nova transferência na origem → na conta destino a entrada aparece "Encontramos: transferência de…" e concilia com um clique', async () => {
    await ir(fin, `/contas-bancarias?conta=${cOrigem}`);
    const l = linha(fin, 'ENVIO TRANSF INTERNET TEV');
    await l.getByRole('tab', { name: 'Nova transferência' }).click();
    await l.locator('select[aria-label="Conta de destino"]').selectOption(cDestino);
    await l.locator('[data-conciliar-novo]').click();
    await fin.waitForFunction(() => !Array.from(document.querySelectorAll('[data-linha-banco]')).some((e) => e.textContent.includes('ENVIO TRANSF INTERNET TEV')), null, { timeout: 20000 });
    await ir(fin, `/contas-bancarias?conta=${cDestino}`);
    const e = linha(fin, 'TRANSFERENCIA RECEBIDA');
    const sug = await e.locator('[data-sugestao]').first().getAttribute('data-sugestao');
    const txt = await e.locator('[data-transferencia-sugerida]').innerText();
    await fin.screenshot({ path: path.join(DIR, 'conc-transferencia-destino.png') });
    await e.locator('[data-conciliar-novo]').click();
    await fin.waitForFunction(() => !document.querySelector('[data-linha-banco]'), null, { timeout: 20000 });
    const t = (await um(admin.from('transferencias').select('linha_origem, linha_destino, valor').eq('conta_origem', cOrigem).eq('conta_destino', cDestino)))[0];
    confere(sug === 'transferencia' && /Transferência de/.test(txt) && t.linha_origem && t.linha_destino && Number(t.valor) === 2700, `${sug} · ${txt} · ${JSON.stringify(t)}`);
    await ir(fin, `/contas-bancarias?conta=${cDestino}&ver=conciliada`);
    const mov = await fin.locator('[data-transferencia]').first().innerText();
    confere(/as duas pontas conciliadas/.test(mov), mov);
    return `${txt.split('\n')[0]} → ${mov}`;
  });

  await passo('desfazer o lançamento criado pela conciliação oferece "cancelar o lançamento" e cancela', async () => {
    await ir(fin, `/contas-bancarias?conta=${cOrigem}&ver=conciliada`);
    const linhaId = (await um(admin.from('extrato_linhas').select('id').eq('conta_id', cOrigem).like('descricao', 'SAQUE DIN ATM%').single())).id;
    await fin.locator(`[data-conciliada="${linhaId}"]`).getByRole('button', { name: 'Desfazer' }).click();
    const d = fin.getByRole('dialog', { name: 'Desfazer conciliação' });
    await d.getByText('Desfazer e cancelar o lançamento criado pela conciliação').click();
    await d.locator('input[aria-label="Motivo"]').fill('lançado em duplicidade');
    await d.getByRole('button', { name: 'Desfazer' }).click(); await d.waitFor({ state: 'detached' });
    const p = (await um(admin.from('pagamentos').select('status').eq('lancado_conciliacao', true).eq('descricao', 'SAQUE DIN ATM 05/12 10:16 SOP-FULANA DE TAL')))[0];
    confere(p.status === 'cancelado', p.status);
    return 'cancelado e o lançamento do banco voltou para as pendentes';
  });

  await passo('Contas a pagar: etiqueta "Lançado pela conciliação" e filtro "Lançados pela conciliação"', async () => {
    await ir(fin, '/pagamentos?periodo=todos&lancados=1');
    const linhas = await fin.locator('tr[data-linha]').allInnerTexts();
    confere(linhas.length === 1 && /Lançado pela conciliação/.test(linhas[0]), `${linhas.length} linha(s)`);
    confere(/Só lançados pela conciliação/.test(await fin.locator('[data-filtro="lancados"]').innerText()), 'etiqueta do filtro ausente');
    return '1 despesa (a cancelada some sem "Mostrar cancelados")';
  });

  await passo('regressão: a planilha exportada respeita o filtro "Conta bancária" (antes ignorava)', async () => {
    const todas = await (await fin.request.get(`${BASE}/pagamentos/exportar?lista=contas&periodo=todos`)).text();
    const daConta = await (await fin.request.get(`${BASE}/pagamentos/exportar?lista=contas&periodo=todos&conta=${cOrigem}`)).text();
    const n = (csv) => csv.trim().split('\n').length - 1;
    confere(n(daConta) === 1 && n(todas) > n(daConta), `todas=${n(todas)} da conta=${n(daConta)}`);
    return `todas=${n(todas)} · só da conta=${n(daConta)}`;
  });

  console.log(`\nConciliação (novo lançamento e transferência): ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  if (falhas.length || errosJS) process.exit(1);
})();
