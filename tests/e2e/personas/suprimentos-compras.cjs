// Persona "Paulo, de Suprimentos": conhece as regras. Cadastra pagamento com boleto/NF, solicita OP (rascunho → envio, itens,
// valores, anexos, duplicar), cuida de fornecedores (dados sensíveis), lança NF por XML e por PDF/imagem, consulta a
// Inteligência de Compras (busca, comparação, histórico, evolução, região, alertas, Excel) e as notas para a contabilidade.
// Dados 100% fictícios; arquivos gerados em tempo de execução (pdf-lib / texto) ou de tests/exemplos.
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const ExcelJS = require('exceljs');
const { BASE, DIR, admin, um, hoje, somarDias, marca, confere, cliente, rodar, ir } = require('./_util.cjs');

const EXEMPLOS = path.join(__dirname, '..', '..', 'exemplos');
const NFSE_PJ = path.join(EXEMPLOS, 'nfse-pj-retencao.xml');
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSlAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const L390 = 390;

/** CNPJ fictício com dígitos verificadores corretos e número novo a cada execução (o cadastro recusa documento repetido). */
function cnpjNovo() {
  const d = Array.from({ length: 12 }, (_, i) => (i < 8 ? Math.floor(Math.random() * 10) : [0, 0, 0, 1][i - 8]));
  const dv = (base) => { const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const r = base.reduce((a, x, i) => a + x * pesos[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  d.push(dv(d)); d.push(dv(d));
  return d.join('');
}
const formatarCnpj = (c) => c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');

/** PDF fictício gerado na hora (texto simples, que NÃO é uma DANFE legível). */
async function pdf(...linhas) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const pg = d.addPage([400, 300]);
  linhas.forEach((l, i) => pg.drawText(String(l), { x: 20, y: 260 - i * 18, size: 11, font: f }));
  return Buffer.from(await d.save());
}
const arq = (name, mimeType, buffer) => ({ name, mimeType, buffer });

let seq = 0;
/** XML de NF-e fictício e único (a chave de acesso muda a cada nota, salvo se `chave` for informada). */
function xmlNFe({ chave, numero, emissao, emitente, cnpj = '12345678000190', uf = 'BA', itens, frete = 0 }) {
  const n = String(Date.now() % 1e9 + (++seq)).padStart(9, '0');
  const ch = chave ?? `2926${emissao.slice(2, 4)}${emissao.slice(5, 7)}${cnpj}55001${n}1${String(Date.now() % 1e8 + seq).padStart(8, '0')}0`.slice(0, 44);
  const prods = itens.map((i, k) => `<det nItem="${k + 1}"><prod><cProd>P${k + 1}</cProd><xProd>${i.desc}</xProd><NCM>39229000</NCM><CFOP>5102</CFOP><uCom>${i.un ?? 'UN'}</uCom><qCom>${i.qtd.toFixed(4)}</qCom><vUnCom>${i.vu.toFixed(10)}</vUnCom><vProd>${(i.qtd * i.vu).toFixed(2)}</vProd></prod></det>`).join('');
  const soma = itens.reduce((s, i) => s + i.qtd * i.vu, 0);
  return [Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${ch}" versao="4.00"><ide><cUF>29</cUF><mod>55</mod><serie>1</serie><nNF>${numero}</nNF><dhEmi>${emissao}T09:15:00-03:00</dhEmi></ide><emit><CNPJ>${cnpj}</CNPJ><xNome>${emitente}</xNome><enderEmit><xMun>Salvador</xMun><UF>${uf}</UF></enderEmit></emit>${prods}<total><ICMSTot><vProd>${soma.toFixed(2)}</vProd><vFrete>${frete.toFixed(2)}</vFrete><vDesc>0.00</vDesc><vNF>${(soma + frete).toFixed(2)}</vNF></ICMSTot></total></infNFe></NFe><protNFe versao="4.00"><infProt><chNFe>${ch}</chNFe></infProt></protNFe></nfeProc>`), ch];
}

/** Rolagem lateral: da página e de qualquer área com overflow-x (tabela que "rola" para o lado). */
const rolagem = (p) => p.evaluate(() => ({
  pagina: document.documentElement.scrollWidth - innerWidth,
  areas: [...document.querySelectorAll('main *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)).map((w) => `${w.tagName}.${String(w.className).slice(0, 30)} ${w.scrollWidth}>${w.clientWidth}`),
}));
const textoMain = (p) => p.locator('main').innerText();
const dinheiro = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
/** Com mais de uma conta bancária cadastrada a escolha é obrigatória (com uma só ela já vem marcada). */
async function escolherConta(p) {
  const conta = await p.$('select[name=conta_bancaria_id]');
  if (conta && !(await conta.inputValue())) await p.selectOption('select[name=conta_bancaria_id]', { index: 1 });
}
const norm = (s) => s.replace(/ /g, ' ');

rodar('Persona Paulo (Suprimentos): pagamentos, OP, fornecedores, Compras e notas', async ({ b, passo, entrar }) => {
  const paulo = await entrar('suprimentos');
  paulo.on('dialog', (d) => d.accept());
  const ID = marca('PAULO');
  const NOME_PRODUTO = `Ducha higiênica cromada ${ID.replace('-', '')}`;
  const FORN = `Hidráulica Teste ${ID} Ltda`;
  const CNPJ_FORN = cnpjNovo();
  const CNPJ_OUTRO = cnpjNovo();
  const c = {}; // dados que um passo deixa para o seguinte

  /** Nova despesa com boleto/NF pela tela, como o Paulo faz. Devolve o id do pagamento. */
  async function novaDespesa(p, { obra = /Galp/, descricao, valor = '1.000,00', favorecido = FORN, vencimento = somarDias(hoje, 7), boleto, nota, outros }) {
    await ir(p, '/pagamentos/novo');
    const v = await p.$eval('select[name=obra_id]', (s, re) => { const o = [...s.options].find((x) => x.value && new RegExp(re).test(x.text)); return o?.value ?? ''; }, obra.source);
    confere(v, `obra ${obra} não está na lista do Paulo`);
    await p.selectOption('select[name=obra_id]', v);
    await p.fill('input[name=favorecido]', favorecido);
    await p.fill('input[name=descricao]', descricao);
    await p.fill('input[name=valor]', valor);
    await p.fill('input[name=vencimento]', vencimento);
    if (boleto) await p.setInputFiles('input[name=boleto]', boleto);
    if (nota) await p.setInputFiles('input[name=nota_fiscal]', nota);
    if (outros) await p.setInputFiles('input[name=outros]', outros);
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await escolherConta(p);
    await p.click('button:has-text("Cadastrar e encaminhar")');
    await p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 90000 }).catch(async () => {
      await p.screenshot({ path: path.join(DIR, 'paulo-nao-salvou.png'), fullPage: true }).catch(() => {});
      throw new Error('não salvou: ' + p.url() + ' ' + (await p.locator('[role=alert], [role=status]').allInnerTexts()).join(' | ').slice(0, 250));
    });
    return p.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
  }
  /** Espera (até 20 s) a condição ficar verdadeira: a gravação da tela termina depois do clique. */
  const esperar = async (fn, msg) => { let ult; for (let i = 0; i < 40; i++) { try { ult = await fn(); if (ult) return ult; } catch (e) { ult = e.message; } await new Promise((r) => setTimeout(r, 500)); } throw new Error(msg + (typeof ult === 'string' ? ` (${ult})` : '')); };
  const pagamento = async (id) => um(admin.from('pagamentos').select('*').eq('id', id).single());
  const docs = async (id) => um(admin.from('documentos').select('id, tipo, nome_arquivo, ativo').eq('pagamento_id', id));
  const notaDoPag = async (id) => (await admin.from('nf_notas').select('*, nf_itens(*)').eq('pagamento_id', id).eq('ativa', true).maybeSingle()).data;

  // ───────────── Pagamento com boleto e NF ─────────────
  await passo('Paulo cadastra pagamento com boleto (PDF gerado): fica aguardando engenheiro, valor e documento corretos', async () => {
    c.boleto = await novaDespesa(paulo, { descricao: `Louças sanitárias ${ID}`, valor: '3.500,75', boleto: arq(`boleto-${ID}.pdf`, 'application/pdf', await pdf('BOLETO FICTICIO', ID)) });
    const pg = await pagamento(c.boleto);
    confere(pg.status === 'aguardando_engenheiro', `status ${pg.status}`);
    confere(Number(pg.valor) === 3500.75, `valor ${pg.valor}`);
    confere(pg.created_by === (await admin.from('profiles').select('id').eq('email', 'suprimentos@demo.local').single()).data.id, 'criador não é o Paulo');
    const d = await docs(c.boleto);
    confere(d.filter((x) => x.tipo === 'boleto' && x.ativo).length === 1, 'boleto não anexado');
    await paulo.getByText('Aguardando engenheiro').first().waitFor();
    return `nº ${pg.numero}`;
  });

  await passo('Paulo cadastra só com nota fiscal em PDF (sem boleto): aceito, e a nota fica como documento', async () => {
    const id = await novaDespesa(paulo, { descricao: `Só NF ${ID}`, valor: '800,00', nota: arq(`nf-${ID}.pdf`, 'application/pdf', await pdf('NOTA FISCAL FICTICIA', ID)) });
    const d = await docs(id);
    confere(d.some((x) => x.tipo === 'nota_fiscal'), 'sem nota fiscal');
    c.nfPdf = id; c.nfPdfDoc = d.find((x) => x.tipo === 'nota_fiscal').id;
  });

  await passo('Paulo só vê, no cadastro, as obras em que está liberado; Usuários e conciliação lhe são barrados', async () => {
    await ir(paulo, '/pagamentos/novo');
    const ops = await paulo.$$eval('select[name=obra_id] option', (os) => os.map((o) => o.textContent));
    confere(ops.length >= 2, 'nenhuma obra para cadastrar');
    confere(!ops.some((o) => /Aracaju/.test(o)), 'vê obra sem acesso no cadastro: ' + ops.join('|'));
    for (const rota of ['/usuarios', '/conciliacao', '/contas-bancarias']) {
      await paulo.goto(BASE + rota);
      confere(paulo.url().includes('sem-permissao') || !paulo.url().endsWith(rota), `abriu ${rota}`);
    }
  });

  // ───────────── Solicitação de OP ─────────────
  async function abrirNovaOP(p, obraRe = /Galp/) {
    await ir(p, '/pagamentos/novo');
    await p.getByLabel('Forma de pagamento').selectOption('pix');
    await p.waitForSelector('input[name=chave_pix]');
    const v = await p.$eval('select[name=obra_id]', (s, re) => [...s.options].find((x) => x.value && new RegExp(re).test(x.text))?.value, obraRe.source);
    await p.selectOption('select[name=obra_id]', v);
    await p.fill('input[name=vencimento]', somarDias(hoje, 10));
    await p.fill('input[name=favorecido]', FORN);
    await p.fill('input[name=descricao]', `OP de ${ID}`);
    await p.fill('input[name=banco]', 'Banco Fictício');
    await p.fill('input[name=chave_pix]', 'pix-ficticio@teste.local');
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    const conta = await p.$('select[name=conta_bancaria_id]');
    if (conta && !(await conta.inputValue())) await p.selectOption('select[name=conta_bancaria_id]', { index: 1 });
  }
  const preencherItem = async (p, i, d, un, q, vu) => {
    await p.getByLabel(`Descrição do item ${i}`).fill(d);
    await p.getByLabel(`Unidade do item ${i}`).fill(un);
    await p.getByLabel(`Quantidade do item ${i}`).fill(q);
    await p.getByLabel(`Valor unitário do item ${i}`).fill(vu);
  };
  const opPorId = async (id) => um(admin.from('ordens_pagamento').select('*, ordem_itens(*), ordem_parcelas(*)').eq('id', id).single());

  await passo('OP (Paulo, PIX): salvar rascunho → em elaboração; 2 itens e desconto gravados; total da tela confere', async () => {
    await abrirNovaOP(paulo);
    await preencherItem(paulo, 1, `Registro de gaveta ${ID}`, 'UN', '10', '25,50');
    await paulo.getByRole('button', { name: '+ Adicionar item' }).click();
    await preencherItem(paulo, 2, `Ducha higiênica ${ID}`, 'UN', '3', '89,90');
    await paulo.getByLabel('Desconto').fill('15,00');
    // subtotal 10*25,50 + 3*89,90 = 524,70 ; menos 15,00 = 509,70
    confere(norm(await paulo.locator('tfoot').first().innerText()).includes('R$ 509,70'), 'total da tela não é R$ 509,70');
    await paulo.click('button:has-text("Salvar rascunho"):not(:has-text("anexar"))');
    await paulo.waitForURL(/\/ops\/[0-9a-f-]{36}\/editar/, { timeout: 60000 });
    c.op = paulo.url().match(/ops\/([0-9a-f-]{36})/)[1];
    const op = await opPorId(c.op);
    confere(op.status === 'em_elaboracao', op.status);
    confere(op.ordem_itens.length === 2 && Number(op.desconto) === 15, `itens ${op.ordem_itens.length} desc ${op.desconto}`);
    confere(op.numero === null, 'rascunho já tem número');
    confere(!(await admin.from('pagamentos').select('id').eq('ordem_id', c.op)).data.length, 'rascunho já gerou pagamento');
  });

    await passo('OP rascunho: editar quantidade do item, remover e incluir item altera os valores gravados', async () => {
    await ir(paulo, `/ops/${c.op}/editar`);
    await paulo.getByLabel('Quantidade do item 1').fill('12');
    await paulo.click('button:has-text("Salvar rascunho"):not(:has-text("anexar"))');
    await esperar(async () => { const q = (await opPorId(c.op)).ordem_itens.sort((a, b) => a.posicao - b.posicao).map((i) => Number(i.quantidade)); return q[0] === 12 && q[1] === 3; }, 'quantidade não foi gravada');
    await paulo.waitForURL(/editar\?salva=1/, { timeout: 60000 });
    // 12*25,50 + 3*89,90 = 306,00 + 269,70 = 575,70 ; -15 = 560,70
    confere(norm(await paulo.locator('tfoot').first().innerText()).includes('R$ 560,70'), 'total da tela não é R$ 560,70');
    await paulo.getByRole('button', { name: 'Remover item 2' }).click();
    await paulo.click('button:has-text("Salvar rascunho"):not(:has-text("anexar"))');
    await esperar(async () => (await opPorId(c.op)).ordem_itens.length === 1, 'o item removido continua gravado');
    await paulo.waitForLoadState('networkidle');
    await paulo.getByRole('button', { name: '+ Adicionar item' }).click();
    await preencherItem(paulo, 2, `Ducha higiênica ${ID}`, 'UN', '3', '89,90');
    await paulo.click('button:has-text("Salvar rascunho"):not(:has-text("anexar"))');
    await esperar(async () => (await opPorId(c.op)).ordem_itens.length === 2, 'o item incluído não foi gravado');
    await paulo.waitForLoadState('networkidle');
  });

  await passo('OP rascunho: Paulo anexa comprovante (sem assinatura) e remove; texto/arquivo de tipo errado é recusado com aviso', async () => {
    await ir(paulo, `/ops/${c.op}/editar`);
    const entrada = paulo.locator('label:has-text("Anexar comprovante") input[type=file]');
    await entrada.setInputFiles(arq('comprovante.pdf', 'application/pdf', await pdf('COMPROVANTE FICTICIO', ID)));
    await paulo.getByText('Arquivo anexado.').waitFor({ timeout: 30000 });
    let anexos = await um(admin.from('ordem_anexos').select('*').eq('ordem_id', c.op));
    confere(anexos.length === 1 && anexos[0].assinado === false, JSON.stringify(anexos.map((a) => a.assinado)));
    await entrada.setInputFiles(arq('anotacoes.txt', 'text/plain', Buffer.from('isto não é pdf')));
    await paulo.getByText('Envie um PDF, PNG ou JPG.').waitFor({ timeout: 5000 });
    confere((await um(admin.from('ordem_anexos').select('id').eq('ordem_id', c.op))).length === 1, 'o .txt foi gravado');
    await paulo.getByRole('button', { name: 'Remover', exact: true }).first().click();
    await paulo.getByText('Anexo removido.').waitFor({ timeout: 15000 });
    anexos = await um(admin.from('ordem_anexos').select('id').eq('ordem_id', c.op));
    confere(anexos.length === 0, 'anexo não saiu');
    await entrada.setInputFiles(arq('recibo.png', 'image/png', PIXEL));
    await paulo.getByText('Arquivo anexado.').waitFor({ timeout: 30000 });
  });

  await passo('OP: enviar gera número OP-AAAA-n, pagamento na etapa do engenheiro (fluxo A), valor = itens − desconto, PDF anexado', async () => {
    await ir(paulo, `/ops/${c.op}`);
    await paulo.getByRole('button', { name: 'Enviar OP' }).click();
    await paulo.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 90000 });
    c.opPag = paulo.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const op = await opPorId(c.op);
    confere(op.status === 'enviada' && /^OP-\d{4}-\d+$/.test(op.numero), `${op.status} ${op.numero}`);
    const pg = await pagamento(c.opPag);
    confere(pg.ordem_id === c.op, 'pagamento sem ligação com a OP');
    // 12*25,50 + 3*89,90 - 15,00 = 560,70
    confere(Number(pg.valor) === 560.7, `valor do pagamento ${pg.valor}`);
    confere(pg.status === 'aguardando_engenheiro', `status ${pg.status} (obra Galpão, fluxo A com engenheiro e administrador: OP de Suprimentos passa pelo engenheiro)`);
    const d = await docs(c.opPag);
    confere(d.some((x) => x.tipo === 'ordem_pagamento' && x.ativo), 'PDF da OP não anexado');
    return `${op.numero} → ${pg.status}`;
  });

  await passo('OP enviada: não dá mais para editar (tela e banco) nem enviar de novo; só um pagamento por OP', async () => {
    await paulo.goto(BASE + `/ops/${c.op}`);
    confere((await paulo.getByRole('button', { name: 'Enviar OP' }).count()) === 0, 'ainda mostra "Enviar OP"');
    confere((await paulo.getByRole('link', { name: 'Editar rascunho' }).count()) === 0, 'ainda mostra "Editar rascunho"');
    const sup = await cliente('suprimentos');
    const e1 = await sup.rpc('enviar_op', { p_id: c.op });
    confere(e1.error, 'enviar_op de novo foi aceito');
    const e2 = await sup.rpc('salvar_op', { p_id: c.op, p_obra_id: (await opPorId(c.op)).obra_id, p_favorecido: 'Adulterado', p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 3), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: [{ descricao: 'x', unidade: '', quantidade: 1, valor_unitario: 1 }], p_desconto: 0, p_numero_nf: '' });
    confere(e2.error, 'salvar_op em OP enviada foi aceito');
    confere((await admin.from('pagamentos').select('id').eq('ordem_id', c.op)).data.length === 1, 'há mais de um pagamento para a OP');
    confere((await opPorId(c.op)).favorecido === FORN, 'favorecido foi adulterado');
  });

  await passo('OP em 3 parcelas: vencimentos mensais, soma igual ao total, pagamento nasce com as parcelas', async () => {
    await abrirNovaOP(paulo);
    await preencherItem(paulo, 1, `Cimento CP-II ${ID}`, 'SC', '100', '33,33');
    await paulo.fill('input[name=parcelas]', '3');
    await paulo.waitForSelector('text=Soma das parcelas');
    confere(norm(await paulo.locator('tfoot').last().innerText()).includes('3.333,00'), 'soma das parcelas não confere com o total 3.333,00');
    await paulo.click('button:has-text("Salvar e enviar")');
    await paulo.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 90000 });
    const id = paulo.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const ps = await um(admin.from('pagamento_parcelas').select('numero, valor_base, vencimento').eq('pagamento_id', id).order('numero'));
    confere(ps.length === 3, `${ps.length} parcelas`);
    confere(Math.round(ps.reduce((s, x) => s + Number(x.valor_base), 0) * 100) === 333300, 'soma das parcelas ≠ total');
    const mes = (d) => Number(d.slice(5, 7));
    confere(((mes(ps[1].vencimento) - mes(ps[0].vencimento) + 12) % 12) === 1 && ((mes(ps[2].vencimento) - mes(ps[1].vencimento) + 12) % 12) === 1, 'vencimentos não são mensais: ' + ps.map((x) => x.vencimento));
  });

  await passo('OP sem administrador (obra C, fluxo C): Paulo envia e o pagamento vai direto ao Financeiro', async () => {
    await abrirNovaOP(paulo, /Aracaju/);
    await preencherItem(paulo, 1, `Areia lavada ${ID}`, 'M3', '5', '120,00');
    await paulo.click('button:has-text("Salvar e enviar")');
    await paulo.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 90000 });
    const pg = await pagamento(paulo.url().match(/pagamentos\/([0-9a-f-]{36})/)[1]);
    confere(pg.status === 'aguardando_pagamento', pg.status);
  });

  await passo('OP rejeitada: Paulo vê o motivo e "duplicar" cria rascunho novo com os mesmos itens, preservando a OP antiga', async () => {
    const adm = await cliente('engenheiro');
    const r = await adm.rpc('decidir_aprovacao', { p_itens: [{ id: c.opPag, versao: (await pagamento(c.opPag)).versao }], p_decisao: 'rejeitado', p_comentario: `Valor acima do orçado ${ID}` });
    confere(!r.error, 'não foi possível rejeitar para o teste: ' + r.error?.message);
    await ir(paulo, `/ops/${c.op}`);
    await paulo.getByText(`Valor acima do orçado ${ID}`).first().waitFor();
    await paulo.getByRole('button', { name: 'Criar nova solicitação a partir desta' }).click();
    await paulo.waitForURL(/\/ops\/[0-9a-f-]{36}\/editar/, { timeout: 60000 });
    const novaId = paulo.url().match(/ops\/([0-9a-f-]{36})/)[1];
    confere(novaId !== c.op, 'duplicou sobre a mesma OP');
    const nova = await opPorId(novaId), velha = await opPorId(c.op);
    confere(nova.status === 'em_elaboracao' && nova.numero === null, `${nova.status} ${nova.numero}`);
    confere(nova.ordem_itens.length === velha.ordem_itens.length && Number(nova.desconto) === Number(velha.desconto), 'itens/desconto diferentes');
    confere(velha.status === 'rejeitada' && velha.numero, 'a OP antiga mudou');
    confere(await paulo.getByLabel('Descrição do item 1').inputValue() !== '', 'itens não aparecem no formulário');
  });

  // ───────────── Fornecedores (dados sensíveis) ─────────────
  await passo('Fornecedor: cadastra com CNPJ, banco e PIX; aparece na lista e a busca acha pelo CNPJ formatado e pelo nome', async () => {
    await ir(paulo, '/fornecedores/novo');
    await paulo.fill('input[name=nome]', FORN);
    await paulo.fill('input[name=cpf_cnpj]', formatarCnpj(CNPJ_FORN));
    await paulo.fill('input[name=email]', 'contato@hidraulica-teste.local');
    await paulo.fill('input[name=cidade]', 'Salvador'); await paulo.selectOption('select[name=uf]', 'BA');
    await paulo.fill('input[name=chave_pix]', 'pix-hidraulica@teste.local');
    await paulo.fill('input[name=banco]', 'Banco Fictício'); await paulo.fill('input[name=agencia]', '0001'); await paulo.fill('input[name=conta]', '12345-6');
    await paulo.click('button:has-text("Cadastrar fornecedor")');
    await paulo.waitForURL(/\/fornecedores\/[0-9a-f-]{36}\?criado=1/, { timeout: 30000 });
    c.forn = paulo.url().match(/fornecedores\/([0-9a-f-]{36})/)[1];
    const f = (await admin.from('fornecedores').select('*').eq('id', c.forn).single()).data;
    confere(f.cpf_cnpj === CNPJ_FORN && f.chave_pix === 'pix-hidraulica@teste.local' && f.conta === '12345-6', JSON.stringify(f));
    for (const busca of [formatarCnpj(CNPJ_FORN), CNPJ_FORN.slice(0, 8), ID]) {
      await ir(paulo, '/fornecedores?busca=' + encodeURIComponent(busca));
      confere((await textoMain(paulo)).includes(FORN), `busca "${busca}" não achou`);
    }
    await ir(paulo, '/fornecedores?busca=' + encodeURIComponent(formatarCnpj(CNPJ_FORN)));
    confere((await textoMain(paulo)).includes(formatarCnpj(CNPJ_FORN)), 'CNPJ não aparece formatado');
  });

  await passo('Fornecedor: editar PIX/banco grava; desativar tira da lista de escolha do novo pagamento; reativar volta', async () => {
    await ir(paulo, `/fornecedores/${c.forn}`);
    await paulo.fill('input[name=chave_pix]', 'novo-pix@teste.local');
    await paulo.click('button:has-text("Salvar alterações")');
    await paulo.getByText('Fornecedor atualizado.').waitFor();
    confere((await admin.from('fornecedores').select('chave_pix').eq('id', c.forn).single()).data.chave_pix === 'novo-pix@teste.local', 'PIX não mudou');
    await paulo.uncheck('input[name=ativo]'); await paulo.click('button:has-text("Salvar alterações")'); await paulo.getByText('Fornecedor atualizado.').waitFor();
    await ir(paulo, '/pagamentos/novo');
    confere(!(await paulo.$$eval('select[aria-label=Fornecedor] option', (os) => os.map((o) => o.textContent))).some((t) => t.includes(ID)), 'fornecedor inativo ainda é oferecido');
    await ir(paulo, `/fornecedores/${c.forn}`); await paulo.check('input[name=ativo]'); await paulo.click('button:has-text("Salvar alterações")'); await paulo.getByText('Fornecedor atualizado.').waitFor();
    await ir(paulo, '/pagamentos/novo');
    confere((await paulo.$$eval('select[aria-label=Fornecedor] option', (os) => os.map((o) => o.textContent))).some((t) => t.includes(ID)), 'fornecedor reativado não voltou');
  });

  await passo('Dados sensíveis: engenheiro e administrador não leem CPF/CNPJ, PIX e banco (banco e telas); só nomes', async () => {
    for (const perfil of ['engenheiro', 'administrador']) {
      const cl = await cliente(perfil);
      const v = await cl.from('fornecedores_dados').select('id, cpf_cnpj').eq('id', c.forn);
      confere(v.error || !v.data?.length, `${perfil} leu fornecedores_dados: ${JSON.stringify(v.data)}`);
      const t = await cl.from('fornecedores').select('chave_pix, cpf_cnpj, conta').eq('id', c.forn);
      confere(t.error || !t.data?.length, `${perfil} leu colunas sensíveis da tabela`);
      const nomes = await cl.from('fornecedores').select('id, nome').eq('id', c.forn);
      confere(nomes.data?.[0]?.nome === FORN, `${perfil} não vê nem o nome`);
      const ins = await cl.from('fornecedores').update({ chave_pix: 'golpe' }).eq('id', c.forn).select();
      confere(!ins.data?.length, `${perfil} alterou fornecedor`);
    }
    const eng = await entrar('engenheiro');
    await eng.goto(BASE + `/fornecedores/${c.forn}`);
    confere(eng.url().includes('sem-permissao'), 'engenheiro abriu a ficha do fornecedor');
    const corpo = await eng.locator('body').innerText();
    confere(!corpo.includes(formatarCnpj(CNPJ_FORN).slice(0, 10)) && !corpo.includes('novo-pix'), 'dado sensível apareceu na tela do engenheiro');
    await eng.close();
  });

  // ───────────── Compras: lançar NF por XML ─────────────
  const emissoes = { a: '2026-09-15', b: '2026-10-12', c: '2026-11-10' };
  const preco = { a: 100, b: 110, c: 150 };

  await passo('NF por XML: anexada no pagamento lê os itens sozinha (origem xml), com chave, fornecedor/CNPJ e cidade da obra', async () => {
    const [xml, chave] = xmlNFe({ numero: '1001', emissao: emissoes.a, emitente: FORN, cnpj: CNPJ_FORN, itens: [{ desc: NOME_PRODUTO, un: 'UN', qtd: 4, vu: preco.a }, { desc: `Flexível inox 40cm ${ID}`, un: 'UN', qtd: 8, vu: 12.5 }], frete: 20 });
    c.chaveA = chave; c.xmlA = xml;
    c.pagA = await novaDespesa(paulo, { descricao: `Compra hidráulica A ${ID}`, valor: '520,00', favorecido: FORN, nota: arq(`nfe-${ID}-a.xml`, 'application/xml', xml) });
    const nf = await notaDoPag(c.pagA);
    confere(nf && nf.origem === 'xml' && nf.chave === chave && nf.nf_itens.length === 2, JSON.stringify(nf)?.slice(0, 200));
    confere(nf.emitente_cnpj === CNPJ_FORN && Number(nf.valor_frete) === 20 && Number(nf.valor_total) === 520, 'cabeçalho da NF incorreto');
    await paulo.getByText(/2 item\(ns\) na Inteligência de Compras \(lidos do XML\)/).waitFor();
  });

  await passo('NF por XML: a mesma chave em outro pagamento não duplica os itens e o aviso é claro', async () => {
    const id = await novaDespesa(paulo, { descricao: `Repetida ${ID}`, valor: '520,00', favorecido: FORN, nota: arq(`nfe-${ID}-a2.xml`, 'application/xml', c.xmlA) });
    await paulo.getByText(/já foi registrada|Itens da NF não registrados/).first().waitFor({ timeout: 10000 });
    confere(!(await notaDoPag(id)), 'a mesma chave entrou duas vezes');
    confere((await um(admin.from('nf_notas').select('id').eq('chave', c.chaveA).eq('ativa', true))).length === 1, 'chave duplicada ativa');
  });

  await passo('NF por XML (comparação): mais duas compras do mesmo produto, em meses e obras diferentes', async () => {
    const [xb] = xmlNFe({ numero: '1002', emissao: emissoes.b, emitente: `Outra Hidráulica ${ID} ME`, cnpj: CNPJ_OUTRO, itens: [{ desc: NOME_PRODUTO, un: 'UN', qtd: 6, vu: preco.b }] });
    c.pagB = await novaDespesa(paulo, { descricao: `Compra hidráulica B ${ID}`, valor: '660,00', favorecido: `Outra Hidráulica ${ID} ME`, nota: arq(`nfe-${ID}-b.xml`, 'application/xml', xb) });
    const [xc] = xmlNFe({ numero: '1003', emissao: emissoes.c, emitente: FORN, cnpj: CNPJ_FORN, itens: [{ desc: NOME_PRODUTO, un: 'UN', qtd: 2, vu: preco.c }] });
    c.pagC = await novaDespesa(paulo, { obra: /Piso Industrial/, descricao: `Compra hidráulica C ${ID}`, valor: '300,00', favorecido: FORN, nota: arq(`nfe-${ID}-c.xml`, 'application/xml', xc) });
    confere((await notaDoPag(c.pagB)) && (await notaDoPag(c.pagC)), 'notas B/C não foram lidas');
  });

  const buscaCompras = (q = {}) => '/compras?' + new URLSearchParams(q).toString();

  await passo('Busca "ducha higiênica": acha com e sem acento e em maiúsculas; busca sem resultado mostra o vazio sem quebrar', async () => {
    const SEM = ID.replace('-', '');
    for (const termo of [`ducha higiênica cromada ${SEM}`, `ducha higienica cromada ${SEM}`, `DUCHA HIGIÊNICA CROMADA ${SEM}`, 'ducha higienica']) {
      await ir(paulo, buscaCompras({ material: termo }));
      const t = await textoMain(paulo);
      confere(t.toLowerCase().includes('ducha higiênica cromada'), `"${termo}" não achou o produto`);
      confere(t.includes(SEM) || termo === 'ducha higienica', 'produto de outro lugar');
    }
    await ir(paulo, buscaCompras({ material: 'ducha higiênica' }));
    confere(/ducha/i.test(await textoMain(paulo)), 'busca ampla "ducha higiênica" sem resultado');
    await ir(paulo, buscaCompras({ material: `zzz-inexistente-${ID}` }));
    confere(/Nenhum item de nota fiscal encontrado/.test(await textoMain(paulo)), 'sem a mensagem de vazio');
  });

  await passo('Comparação de preços: o produto aparece agrupado (3 compras, menor R$ 100, maior R$ 150, variação +50%) e gera alerta', async () => {
    await ir(paulo, buscaCompras({ material: NOME_PRODUTO }));
    const linha = paulo.locator('table.tabela tbody tr', { hasText: 'Ducha higiênica cromada' }).first();
    const t = norm(await linha.innerText());
    confere(/\b3\b/.test(t) && t.includes('R$ 100,00') && t.includes('R$ 150,00') && t.includes('+50%'), 'linha do grupo: ' + t.replace(/\s+/g, ' '));
    // mediana 110, preço 150 → +36% acima da mediana: só alerta com 3 ou mais compras
    const alerta = norm(await paulo.locator('main').innerText());
    confere(/Alertas de diferença de preço \(1\)/.test(alerta) && alerta.includes('+36%'), 'sem alerta de +36%');
  });

  await passo('Histórico, evolução mensal e comparação regional do material (3 emissões, 3 meses, Camaçari e Feira de Santana)', async () => {
    await ir(paulo, buscaCompras({ material: NOME_PRODUTO }));
    await paulo.locator('table.tabela tbody tr a', { hasText: 'Ducha higiênica cromada' }).first().click();
    await paulo.getByText('← Todos os materiais').waitFor();
    const t = norm(await textoMain(paulo));
    const hist = paulo.locator('div:has(> h2, > div) >> text=Histórico de compras').first();
    await hist.waitFor();
    const linhas = await paulo.locator('table.tabela').last().locator('tbody tr').count();
    confere(linhas === 3, `histórico com ${linhas} linhas`);
    confere(['15/09/2026', '12/10/2026', '10/11/2026'].every((d) => t.includes(d)), 'datas de emissão ausentes');
    confere(t.includes('Camaçari/BA') && t.includes('Feira de Santana/BA'), 'comparação regional sem as duas cidades');
    confere(/Preço médio por mês/.test(t), 'sem o gráfico de evolução mensal');
    const barras = await paulo.locator('main svg title, main [role=img] title, main [data-barra], main svg rect').count();
    confere(barras >= 3, `gráfico com ${barras} elementos (esperava 3 meses)`);
    confere((await paulo.locator('a[href^="/pagamentos/"]').count()) >= 3, 'histórico sem link para os pagamentos');
    confere(/menor preço/i.test(t) && /último preço/i.test(t) && /maior preço/i.test(t) && t.includes('R$ 150,00'), 'indicadores do material incompletos: ' + t.slice(0, 200).replace(/\s+/g, ' '));
  });

  await passo('Filtros de Compras: obra, UF, cidade, período de emissão e fornecedor (nome e CNPJ) recortam o resultado', async () => {
    const itensDe = async (q) => { await ir(paulo, buscaCompras({ material: NOME_PRODUTO, ...q })); return paulo.locator('table.tabela tbody tr', { hasText: 'Ducha higiênica cromada' }).count(); };
    const obras = await um(admin.from('obras').select('id, nome'));
    const feira = obras.find((o) => /Feira/.test(o.nome)).id;
    await ir(paulo, buscaCompras({ material: NOME_PRODUTO, obra: feira }));
    confere(norm(await textoMain(paulo)).includes('R$ 150,00') && !norm(await textoMain(paulo)).includes('+50%'), 'obra Feira: só 1 compra de R$ 150');
    confere(await itensDe({ cidade: 'Camaçari' }) === 1, 'cidade');
    await ir(paulo, buscaCompras({ material: NOME_PRODUTO, uf: 'SE' }));
    confere(/Nenhum item de nota fiscal encontrado/.test(await textoMain(paulo)), 'UF SE deveria estar vazio');
    await ir(paulo, buscaCompras({ material: NOME_PRODUTO, de: '2026-10-01', ate: '2026-10-31' }));
    const tOut = norm(await textoMain(paulo));
    confere(tOut.includes('R$ 110,00') && !tOut.includes('R$ 150,00'), 'período de outubro');
    await ir(paulo, buscaCompras({ material: NOME_PRODUTO, fornecedor: CNPJ_FORN }));
    confere(norm(await textoMain(paulo)).includes('R$ 150,00') && !norm(await textoMain(paulo)).includes('R$ 110,00'), 'filtro por CNPJ do fornecedor');
    await ir(paulo, buscaCompras({ material: NOME_PRODUTO, fornecedor: `Outra Hidráulica ${ID}` }));
    confere(norm(await textoMain(paulo)).includes('R$ 110,00'), 'filtro por nome do fornecedor');
    await paulo.getByRole('link', { name: 'Limpar' }).click();
    await paulo.waitForURL((u) => u.pathname === '/compras' && !u.search);
  });

  await passo('Excel de Compras: baixa .xlsx válido com o filtro aplicado, com CNPJ para o Paulo', async () => {
    const r = await paulo.request.get(BASE + '/compras/exportar?' + new URLSearchParams({ material: NOME_PRODUTO }));
    confere(r.status() === 200, `status ${r.status()}`);
    confere(/spreadsheetml/.test(r.headers()['content-type'] ?? ''), 'tipo ' + r.headers()['content-type']);
    const buf = await r.body();
    confere(buf.subarray(0, 2).toString() === 'PK', 'não é xlsx');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    const linhas = []; ws.eachRow((row) => linhas.push(row.values.map((v) => (v && v.result !== undefined ? v.result : v)).join('|')));
    const meus = linhas.filter((l) => l.includes(NOME_PRODUTO));
    confere(meus.length === 3, `${meus.length} linhas do produto no Excel`);
    confere(meus.some((l) => l.includes(CNPJ_FORN)), 'CNPJ ausente do Excel do Paulo');
    confere(!linhas.some((l) => /Concreto usinado|Vergalh/i.test(l)), 'o filtro não foi aplicado no Excel');
  });

  // ───────────── Lançar NF por PDF/imagem (manual) ─────────────
  await passo('NF em PDF/imagem: link "Lançar itens", dois itens + frete, grava origem manual, total = produtos + frete, entra na análise', async () => {
    await ir(paulo, `/pagamentos/${c.nfPdf}`);
    await paulo.getByRole('link', { name: /Lançar itens desta nota/ }).click();
    await paulo.waitForURL(/\/compras\/lancar\//);
    await paulo.fill('input[name=emitente_nome]', FORN);
    await paulo.fill('input[name=emitente_cnpj]', CNPJ_FORN);
    await paulo.selectOption('select[name=emitente_uf]', 'BA');
    await paulo.fill('input[name=numero]', '777');
    await paulo.fill('input[name=data_emissao]', '2026-11-20');
    await paulo.fill('input[name=valor_frete]', '30,00');
    await paulo.getByLabel('Descrição 1').fill(`Sifão sanfonado ${ID}`); await paulo.getByLabel('Unidade 1').fill('un'); await paulo.getByLabel('Quantidade 1').fill('5'); await paulo.getByLabel('Preço 1').fill('19,90');
    await paulo.getByRole('button', { name: '+ Adicionar item' }).click();
    await paulo.getByLabel('Descrição 2').fill(`Engate flexível ${ID}`); await paulo.getByLabel('Quantidade 2').fill('10'); await paulo.getByLabel('Preço 2').fill('7,5');
    confere(norm(await paulo.locator('tfoot').innerText()).includes('R$ 174,50'), 'soma da tela ≠ 174,50');
    await paulo.click('button:has-text("Registrar itens")');
    await paulo.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?nf=lancada/, { timeout: 30000 });
    const nf = await notaDoPag(c.nfPdf);
    confere(nf.origem === 'manual' && nf.nf_itens.length === 2 && Number(nf.valor_produtos) === 174.5 && Number(nf.valor_total) === 204.5, JSON.stringify({ o: nf.origem, p: nf.valor_produtos, t: nf.valor_total }));
    confere(nf.nf_itens.some((i) => i.unidade === 'UN'), 'unidade não foi padronizada em maiúsculas');
    await ir(paulo, buscaCompras({ material: `Sifão sanfonado ${ID}` }));
    confere(norm(await textoMain(paulo)).includes('R$ 19,90'), 'não entrou na análise');
    await paulo.getByRole('link', { name: /Sifão sanfonado/ }).first().click();
    await paulo.getByText('Histórico de compras').waitFor();
    confere((await textoMain(paulo)).includes('Manual'), 'origem "Manual" não aparece no histórico');
  });

  await passo('NF manual: "Remover para relançar" tira os itens da análise e libera novo lançamento; nota já lançada redireciona', async () => {
    await ir(paulo, `/pagamentos/${c.nfPdf}`);
    await paulo.getByRole('button', { name: 'Remover para relançar' }).click();
    await paulo.getByRole('link', { name: /Lançar itens desta nota/ }).waitFor({ timeout: 30000 });
    confere(!(await notaDoPag(c.nfPdf)), 'nota ainda ativa');
    await ir(paulo, buscaCompras({ material: `Sifão sanfonado ${ID}` }));
    confere(/Nenhum item de nota fiscal encontrado/.test(await textoMain(paulo)), 'itens removidos ainda na análise');
    await paulo.goto(BASE + `/compras/lancar/${c.nfPdfDoc}`);
    confere(paulo.url().includes('/compras/lancar/'), 'não deixou lançar de novo');
  });

  await passo('Quem não pode lançar NF (engenheiro/administrador) é barrado na tela e no banco', async () => {
    const eng = await entrar('engenheiro');
    await eng.goto(BASE + `/compras/lancar/${c.nfPdfDoc}`);
    confere(eng.url().includes('sem-permissao'), 'engenheiro abriu o lançamento de NF');
    await eng.close();
    const e = await cliente('administrador');
    const r = await e.rpc('registrar_nf', { p_documento_id: c.nfPdfDoc, p_origem: 'manual', p_nota: { data_emissao: '2026-11-01', emitente_nome: 'x' }, p_itens: [{ numero_item: 1, descricao: 'x', descricao_normalizada: 'x', quantidade: 1, valor_unitario: 1, valor_total: 1 }] });
    confere(r.error, 'administrador registrou NF');
  });

  // ───────────── Ler notas pendentes ─────────────
  await passo('Notas pendentes: a nota em imagem aparece em "Ler notas" e no aviso; "Ler automaticamente" responde sem quebrar', async () => {
    const id = await novaDespesa(paulo, { descricao: `Nota foto ${ID}`, valor: '90,00', nota: arq(`foto-nota-${ID}.png`, 'image/png', PIXEL) });
    const doc = (await docs(id)).find((x) => x.tipo === 'nota_fiscal');
    await ir(paulo, '/compras/ler-notas');
    confere((await textoMain(paulo)).includes(`foto-nota-${ID}.png`), 'a nota pendente não está na lista');
    confere(await paulo.getByRole('button', { name: 'Ler todas' }).isEnabled(), 'botão "Ler todas" desabilitado');
    await ir(paulo, '/compras');
    confere(await paulo.locator('[data-notas-nao-lidas]').count() === 1, 'sem o aviso de notas não lidas');
    await paulo.getByRole('button', { name: 'Ler automaticamente' }).click();
    await paulo.getByText(/nota\(s\) lida\(s\)/).waitFor({ timeout: 60000 });
    confere(/não puderam ser lidas/.test(await paulo.locator('main').innerText()), 'a foto (sem texto) deveria ficar sem leitura');
    confere(!(await notaDoPag(id)), 'a foto virou nota sem ser legível');
    c.fotoDoc = doc.id;
  });

  // ───────────── Notas para a contabilidade ─────────────
  await passo('Notas para contabilidade: NFS-e de PJ com retenção anexada aparece em "A enviar"; Paulo vê mas não marca como enviada', async () => {
    const xml = fs.readFileSync(NFSE_PJ);
    const id = await novaDespesa(paulo, { descricao: `Serviço PJ com retenção ${ID}`, valor: '1.000,00', nota: arq(`nfse-${ID}.xml`, 'application/xml', xml) });
    const nota = await um(admin.from('notas_contabeis').select('id, categoria, enviada').eq('pagamento_id', id)).catch(() => null);
    await ir(paulo, '/notas-contabeis');
    const t = await textoMain(paulo);
    confere(await paulo.locator('main a[href="/pagamentos/' + id + '"]').count() >= 1 || (nota && nota.length), 'a nota não entrou na lista para a contabilidade');
    confere((await paulo.getByRole('button', { name: /Marcar como enviada/i }).count()) === 0, 'Paulo vê o botão de marcar enviada');
    confere(/Notas \(\d+\)/.test(t), 'lista sem contador');
    if (nota?.length) {
      const r = await (await cliente('suprimentos')).rpc('marcar_nota_contabil_enviada', { p_id: nota[0].id, p_enviada: true });
      confere(r.error, 'Paulo marcou nota como enviada pelo banco');
      confere(!(await admin.from('notas_contabeis').select('enviada').eq('id', nota[0].id).single()).data.enviada, 'nota foi marcada como enviada');
    }
    const ex = await paulo.request.get(BASE + '/notas-contabeis/exportar?situacao=todas');
    confere(ex.status() === 200, `exportar notas ${ex.status()}`);
  });

  // ───────────── Celular ─────────────
  const telas = [['Painel', '/'], ['Contas a pagar', '/pagamentos'], ['Nova despesa', '/pagamentos/novo'], ['Fornecedores', '/fornecedores'], ['Novo fornecedor', '/fornecedores/novo'], ['Ficha do fornecedor', () => `/fornecedores/${c.forn}`],
    ['Inteligência de Compras', '/compras'], ['Detalhe do material (histórico, regional, evolução)', () => buscaCompras({ material: NOME_PRODUTO }), true], ['Ler notas', '/compras/ler-notas'], ['Notas para contabilidade', '/notas-contabeis'],
    ['Pagamento da OP', () => `/pagamentos/${c.opPag}`], ['Solicitação de OP', () => `/ops/${c.op}`], ['Lançar itens da NF', () => `/compras/lancar/${c.nfPdfDoc}`]];
  let cel;
  for (const [nome, url, abrirGrupo] of telas) {
    await passo(`Celular 390px: ${nome} sem rolagem lateral (página e tabelas)`, async () => {
      cel ??= await entrar('suprimentos', L390);
      cel.on('dialog', (d) => d.accept());
      await ir(cel, typeof url === 'function' ? url() : url);
      if (abrirGrupo) { await cel.locator('table.tabela tbody tr a', { hasText: 'Ducha higiênica cromada' }).first().click(); await cel.getByText('← Todos os materiais').waitFor(); await cel.waitForLoadState('networkidle'); }
      const r = await rolagem(cel);
      confere(r.pagina <= 1, `a página passa ${r.pagina}px da tela`);
      confere(!r.areas.length, `rolagem lateral em: ${r.areas.join(' | ')}`);
    });
  }
});
