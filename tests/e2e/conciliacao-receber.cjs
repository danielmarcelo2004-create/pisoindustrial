// Conciliação sem "arquivar" para dinheiro de verdade: estorno em pares, BB Rende Fácil conciliado na própria conta
// (aplicação/resgate automático), tarifa como novo lançamento com a categoria certa e entrada como recebimento
// (Contas a receber, com nota de medição opcional). Extrato OFX fictício gerado aqui.
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

function ofx(nome, banco, agencia, conta, linhas) {
  const t = linhas.map(([d, v, memo, id]) => `<STMTTRN><TRNTYPE>${v < 0 ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${d.replace(/-/g, '')}030000<TRNAMT>${v}<FITID>${id}<MEMO>${memo}</STMTTRN>`).join('');
  const txt = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:1252\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>${banco}<BRANCHID>${agencia}<ACCTID>${conta}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20261201<DTEND>20261231${t}</BANKTRANLIST><LEDGERBAL><BALAMT>1000.00<DTASOF>20261231</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const p = path.join(DIR, nome);
  fs.writeFileSync(p, Buffer.from(txt, 'latin1'));
  return p;
}

let ok = 0, tot = 0, errosJS = 0;
async function passo(nome, fn) {
  tot++;
  try { const ev = await fn(); ok++; console.log(`✔ ${nome}${ev ? ` — ${ev}` : ''}`); } catch (e) { console.log(`✘ ${nome} — ${String(e.message).split('\n')[0].slice(0, 300)}`); }
}
const confere = (c, m) => { if (!c) throw new Error(m); };
async function entrar(b, email) {
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  p.on('pageerror', (e) => { errosJS++; console.log(`  ERRO JS [${email}] ${e.message.slice(0, 200)}`); });
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/login'); await p.fill('input[name=email]', email); await p.fill('input[name=senha]', SENHA);
  await Promise.all([p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), p.click('button:has-text("Entrar")')]);
  return p;
}
const ir = async (p, url) => { await p.goto(BASE + url); await p.waitForLoadState('networkidle'); };
const linha = (p, texto) => p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: texto }) }).first();
const foto = (p, nome) => p.screenshot({ path: path.join(DIR, `rec-${nome}.png`), fullPage: true });
const pendente = async (p, texto) => (await linha(p, texto).count()) > 0;

(async () => {
  const b = await chromium.launch();
  const fin = await entrar(b, 'financeiro@demo.local');
  const obraA = (await um(admin.from('obras').select('id, nome, cliente').eq('fluxo', 'A').order('nome').limit(1)))[0];
  const obraC = (await um(admin.from('obras').select('id, nome').eq('fluxo', 'C').order('nome').limit(1)))[0];
  const catTar = (await um(admin.from('categorias').insert({ nome: 'Tarifas bancárias', tipo: 'despesa' }).select('id').single())).id;
  const catRec = (await um(admin.from('categorias').insert({ nome: 'Medição de obra', tipo: 'receita' }).select('id').single())).id;

  const arq = ofx('receber.ofx', '0104', '0077', '0005556667778', [
    ['2026-12-03', -480, 'PIX ENVIADO 03/12 FULANO FICTICIO', 'E1'],
    ['2026-12-04', 480, 'PIX DEVOLVIDO 04/12 FULANO FICTICIO', 'E2'],
    ['2026-12-05', -5000, 'BB RENDE FACIL', 'R1'],
    ['2026-12-06', 1200, 'BB RENDE FACIL', 'R2'],
    ['2026-12-06', -3000, 'ENVIO TRANSF INTERNET TEV', 'X1'],
    ['2026-12-06', -8.5, 'TAR PIX', 'T1'],
    ['2026-12-07', 12000, 'TED RECEBIDA CONSTRUTORA FICTICIA', 'C1'],
  ]);
  await passo('importar extrato fictício', async () => {
    await ir(fin, '/contas-bancarias');
    const [fc] = await Promise.all([fin.waitForEvent('filechooser'), fin.getByRole('button', { name: 'Importar extrato OFX' }).first().click()]);
    await fc.setFiles(arq);
    await fin.waitForURL(/importado=/, { timeout: 60000 });
  });
  const conta = (await um(admin.from('contas_bancarias').select('id').eq('banco', '104').eq('agencia', '77').single())).id;
  const fu0 = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
  const outra = (await um(admin.from('contas_bancarias').insert({ nome: 'BB Fictício Destino', banco: '001', agencia: '', conta: '1112223', created_by: fu0 }).select('id').single())).id;
  const abrir = () => ir(fin, `/contas-bancarias?conta=${conta}`);

  await passo('nenhuma linha recebe a dica "Arquivar como…" (tarifa, aplicação, entrada e estorno têm destino)', async () => {
    await abrir();
    const n = await fin.locator('[data-sugestao="classificar"]').count();
    confere(n === 0, `${n} dica(s) de arquivar`);
    await foto(fin, 'pendentes');
  });

  await passo('estorno: "Encontramos" liga o PIX devolvido à saída de mesmo valor; ao conciliar, as duas saem das pendentes', async () => {
    await abrir();
    const l = linha(fin, 'PIX DEVOLVIDO');
    confere(await l.locator('[data-sugestao="estorno"]').count() === 1, 'sem sugestão de estorno');
    const txt = await l.locator('[data-estorno-sugerido]').innerText();
    confere(/PIX ENVIADO 03\/12 FULANO FICTICIO/.test(txt) && /saiu e voltou/.test(txt), txt);
    await l.locator('[data-conciliar-novo]').click();
    await fin.waitForLoadState('networkidle');
    await fin.waitForTimeout(800);
    confere(!(await pendente(fin, 'PIX DEVOLVIDO')) && !(await pendente(fin, 'PIX ENVIADO 03/12')), 'as linhas ainda estão pendentes');
    await ir(fin, `/contas-bancarias?conta=${conta}&ver=conciliada`);
    const pares = await fin.locator('[data-estorno-par]').count();
    confere(pares === 2, `${pares} linha(s) com "Estorno ↔"`);
    await foto(fin, 'estorno-movimentacoes');
  });

  await passo('Rende Fácil fica na própria conta: aplicação e resgate sugeridos como automáticos, sem conta separada', async () => {
    await abrir();
    const ap = fin.locator('[data-linha-banco]').filter({ has: fin.locator('[data-descricao-banco]', { hasText: 'BB RENDE FACIL' }) });
    confere(await ap.count() === 2, `${await ap.count()} linha(s) do Rende Fácil`);
    const rotulos = await fin.locator('[data-sugestao="aplicacao"]').allInnerTexts();
    confere(rotulos.includes('Aplicação automática') && rotulos.includes('Resgate automático'), rotulos.join(' | '));
    confere(/não é despesa nem receita/.test(await ap.first().locator('[data-aplicacao-sugerida]').innerText()), 'explicação ausente');
    confere(await fin.getByRole('button', { name: '+ Conta de investimento' }).count() === 0, 'ainda oferece conta de investimento');
    await foto(fin, 'rende-facil');
  });

  await passo('Rende Fácil: "Selecionar › Aplicações e resgates automáticos" + Conciliar (2); "Aplicado no Rende Fácil" = R$ 3.800,00', async () => {
    await fin.getByRole('button', { name: /^Selecionar lançamentos/ }).click();
    await fin.getByRole('menuitem', { name: /Aplicações e resgates automáticos/ }).click();
    const rot = (await fin.getByRole('button', { name: /^Conciliar \(/ }).innerText()).trim();
    confere(rot === 'Conciliar (2)', rot);
    await fin.getByRole('button', { name: /^Conciliar \(/ }).click();
    await fin.waitForSelector('[data-resultado-lote]', { timeout: 30000 }); await fin.waitForLoadState('networkidle');
    await abrir();
    confere(!(await pendente(fin, 'BB RENDE FACIL')), 'Rende Fácil ainda pendente');
    const ap = await fin.locator('[data-aplicado]').innerText();
    confere(/3\.800,00/.test(ap), ap);
    const contas = await um(admin.from('contas_bancarias').select('id').eq('tipo', 'investimento'));
    confere(contas.length === 0, 'criou conta de investimento');
    await ir(fin, `/contas-bancarias?conta=${conta}&ver=conciliada`);
    confere(await fin.locator('[data-aplicacao-conciliada]').count() === 2, 'Movimentações sem a etiqueta');
    await foto(fin, 'rende-facil-conciliado');
    return ap.replace(/\s+/g, ' ');
  });

  await passo('Nova transferência para outra conta da empresa (aparece em Contas a receber como transferência)', async () => {
    await abrir();
    const l = linha(fin, 'ENVIO TRANSF INTERNET TEV');
    await l.getByRole('tab', { name: 'Nova transferência' }).click();
    await l.locator('select[aria-label="Conta de destino"]').selectOption(outra);
    await l.locator('[data-conciliar-novo]').click();
    await fin.waitForLoadState('networkidle'); await fin.waitForTimeout(800);
    confere(!(await pendente(fin, 'ENVIO TRANSF INTERNET TEV')), 'ainda pendente');
  });

  await passo('tarifa: "Novo lançamento" com a categoria Tarifas bancárias sugerida', async () => {
    await abrir();
    const l = linha(fin, 'TAR PIX');
    const cat = await l.locator('select[aria-label="Categoria do novo lançamento"] option:checked').innerText();
    confere(cat === 'Tarifas bancárias', `categoria: ${cat}`);
  });

  await passo('"+ Nova" categoria na conciliação: cadastra sem sair da linha e já seleciona', async () => {
    await abrir();
    const l = linha(fin, 'TAR PIX');
    await l.getByRole('button', { name: '+ Nova' }).first().click();
    await l.locator('input[aria-label="Nome da nova categoria de despesa"]').fill('Tarifa Pix fictícia');
    await l.locator('[data-nova-categoria="despesa"]').getByRole('button', { name: 'Salvar' }).click();
    await l.locator('[data-nova-categoria="despesa"]').waitFor({ state: 'detached' });
    const cat = await l.locator('select[aria-label="Categoria do novo lançamento"] option:checked').innerText();
    confere(cat === 'Tarifa Pix fictícia', `categoria: ${cat}`);
    const c = await um(admin.from('categorias').select('tipo').eq('nome', 'Tarifa Pix fictícia'));
    confere(c.length === 1 && c[0].tipo === 'despesa', JSON.stringify(c));
  });

  await passo('entrada: "Novo lançamento" de receita; o cliente vem do centro de custo; Conciliar cria o recebimento', async () => {
    await abrir();
    const l = linha(fin, 'TED RECEBIDA');
    confere(await l.locator('[data-novo-recebimento]').count() === 1, 'formulário de recebimento ausente');
    confere(await l.locator('[data-conciliar-novo]').isDisabled(), 'Conciliar deveria esperar os campos');
    await l.locator('select[aria-label="Categoria do recebimento"]').selectOption(catRec);
    await l.locator('select[aria-label="Centro de custo do recebimento"]').selectOption(obraA.id);
    const cliente = await l.locator('input[aria-label="Cliente do recebimento"]').inputValue();
    confere(cliente === (obraA.cliente ?? ''), `cliente: ${cliente}`);
    if (!cliente) await l.locator('input[aria-label="Cliente do recebimento"]').fill('Cliente Fictício');
    await foto(fin, 'novo-recebimento');
    await l.locator('[data-conciliar-novo]').click();
    await fin.waitForLoadState('networkidle'); await fin.waitForTimeout(800);
    const r = await um(admin.from('recebimentos').select('id, status, valor, obra_id, lancado_conciliacao').eq('obra_id', obraA.id).eq('valor', 12000));
    confere(r.length === 1 && r[0].status === 'recebido' && r[0].lancado_conciliacao, JSON.stringify(r));
  });

  await passo('Contas a receber: recebimento "Recebido ✓"; transferência marcada e fora do total; cartões', async () => {
    await ir(fin, '/recebimentos?periodo=todos');
    const rec = fin.locator('tr[data-linha^="rec:"]').filter({ hasText: 'TED RECEBIDA' });
    confere(await rec.count() === 1, 'recebimento não listado');
    confere(/Recebido ✓/.test(await rec.innerText()) && /Lançado pela conciliação/.test(await rec.innerText()), await rec.innerText());
    const tr = fin.locator('tr[data-linha^="transf:"]');
    const nTr = await tr.count();
    confere(nTr >= 1 && (await tr.first().locator('[data-etiqueta-transferencia]').count()) === 1, `transferências: ${nTr}`);
    const total = await fin.locator('[data-cartao="total"]').innerText();
    const recebidos = await fin.locator('[data-cartao="recebidos"]').innerText();
    confere(/12\.000,00/.test(total) && /12\.000,00/.test(recebidos), `${total} | ${recebidos}`);
    await foto(fin, 'contas-a-receber');
    return `${total.replace(/\s+/g, ' ')} · ${nTr} transferência(s)`;
  });

  await passo('Mais filtros › Esconder transferências tira as transferências da lista', async () => {
    await ir(fin, '/recebimentos?periodo=todos');
    await fin.getByRole('button', { name: /Mais filtros/ }).click();
    await fin.getByRole('menuitem', { name: 'Esconder transferências' }).click();
    await fin.waitForURL(/semtransf=1/); await fin.waitForLoadState('networkidle');
    confere(await fin.locator('tr[data-linha^="transf:"]').count() === 0, 'transferência ainda aparece');
    confere(await fin.locator('[data-filtro="semtransf"]').count() === 1, 'sem etiqueta');
  });

  const recId = (await um(admin.from('recebimentos').select('id').eq('obra_id', obraA.id).eq('valor', 12000).single())).id;
  await passo('recebimento: "Enviar nota nova" envia o arquivo aqui mesmo e já anexa (sem ir a Notas de medição)', async () => {
    await ir(fin, `/recebimentos/${recId}`);
    const pdf = path.join(DIR, 'medicao-enviada.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    await fin.locator('[data-enviar-nota] summary').click();
    await fin.setInputFiles('input[aria-label="Arquivo da nota de medição"]', pdf);
    await fin.fill('input[aria-label="Valor total da nota"]', '12.600,00');
    await fin.fill('input[aria-label="Número da nota"]', '90');
    await fin.getByRole('button', { name: 'Enviar e anexar' }).click();
    await fin.locator('[data-nota-anexada]').waitFor({ timeout: 30000 }); // o cartão da nota aparece no lugar do formulário
    await ir(fin, `/recebimentos/${recId}`);
    confere(/Nota nº 90/.test(await fin.locator('[data-nota-anexada]').innerText()), 'nota enviada não aparece');
    const n = await um(admin.from('notas_medicao').select('id, obra_id').eq('numero', '90'));
    confere(n.length === 1 && n[0].obra_id === obraA.id, JSON.stringify(n));
  });

  await passo('recebimento: anexar nota de medição do mesmo centro de custo (opcional)', async () => {
    const fu = (await um(admin.from('profiles').select('id').eq('perfil', 'financeiro').limit(1).single())).id;
    await um(admin.from('notas_medicao').insert({ obra_id: obraA.id, storage_path: `${obraA.id}/medicoes/e2e-${Date.now()}.pdf`, nome_arquivo: 'medicao-ficticia.pdf', numero: '77', sha256: 'b'.repeat(64), valor: 12800, valor_liquido: 12000, criada_por: fu }));
    await um(admin.from('notas_medicao').insert({ obra_id: obraC.id, storage_path: `${obraC.id}/medicoes/e2e-${Date.now()}.pdf`, nome_arquivo: 'outra-obra.pdf', numero: '78', sha256: 'c'.repeat(64), valor: 100, valor_liquido: 100, criada_por: fu }));
    await ir(fin, `/recebimentos/${recId}`);
    const opcoes = await fin.locator('select[aria-label="Nota de medição"] option').allInnerTexts();
    confere(opcoes.some((o) => /Nº 77/.test(o)) && !opcoes.some((o) => /Nº 78/.test(o)), opcoes.join(' | '));
    await fin.locator('select[aria-label="Nota de medição"]').selectOption({ label: opcoes.find((o) => /Nº 77/.test(o)) });
    await fin.getByRole('button', { name: /^(Anexar|Trocar)$/ }).click();
    await fin.getByText('Nota de medição anexada.').waitFor({ timeout: 15000 });
    await ir(fin, `/recebimentos/${recId}`);
    confere(/Nota nº 77/.test(await fin.locator('[data-nota-anexada]').innerText()), 'nota não aparece');
    await foto(fin, 'recebimento-nota');
  });

  await passo('engenheiro da obra vê o recebimento (sem editar); administrador2 (outra obra) não vê', async () => {
    const eng = await entrar(b, 'engenheiro@demo.local');
    await ir(eng, '/recebimentos?periodo=todos');
    confere(await eng.locator('tr[data-linha^="rec:"]').filter({ hasText: 'TED RECEBIDA' }).count() === 1, 'engenheiro não vê');
    confere(await eng.locator('tr[data-linha^="transf:"]').count() === 0, 'engenheiro não vê transferências do banco');
    await ir(eng, `/recebimentos/${recId}`);
    confere(await eng.getByRole('button', { name: 'Salvar' }).count() === 0 && (await eng.locator('select[aria-label="Nota de medição"]').count()) === 0, 'engenheiro com edição');
    confere(/Nota nº 77/.test(await eng.locator('[data-nota-anexada]').innerText()), 'engenheiro não vê a nota');
    const a2 = await entrar(b, 'administrador2@demo.local');
    await ir(a2, '/recebimentos?periodo=todos');
    confere(await a2.locator('tr[data-linha^="rec:"]').filter({ hasText: 'TED RECEBIDA' }).count() === 0, 'administrador2 vê obra que não é dele');
  });

  await passo('categoria de receita não aparece para escolher em despesa', async () => {
    await ir(fin, '/pagamentos/novo');
    const html = await fin.content(); // as categorias vão para o seletor (componente próprio) dentro da página
    confere(html.includes('Tarifas bancárias') && !html.includes('Medição de obra'), 'lista de categorias da despesa errada');
  });

  console.log(`\nConciliação → Contas a receber: ${ok}/${tot} · erros de JavaScript: ${errosJS}`);
  await b.close();
  process.exit(ok === tot && errosJS === 0 ? 0 : 1);
})();
