// Persona: Marina, analista do Financeiro. Este arquivo: extratos OFX e conciliação bancária.
// Importar OFX (linhas repetidas, reimportação, arquivos inválidos), "Encontramos"/"Quase lá", pago por conciliação x baixa
// manual, diferença de centavos (juros, desconto, saldo), fatura com encargos, duas linhas iguais, desfazer (só desligar ou
// estornar), arquivar/restaurar, filtros da tela, seleção em lote, permissões e layout (1280px / 390px, janelas).
// Dados fictícios; cada cenário usa a sua própria conta bancária para não colidir com outros testes. Não altera código da aplicação.
const fs = require('fs');
const path = require('path');
const { DIR, BASE, admin, um, hoje, somarDias, marca, confere, cliente, rodar, ir } = require('./_util.cjs');

const semRolagem = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && ![...document.querySelectorAll('table')].some((t) => t.parentElement.scrollWidth > t.parentElement.clientWidth + 2));
const cabe = (dlg) => dlg.evaluate((el) => { const c = el.firstElementChild || el; const r = c.getBoundingClientRect(); return c.scrollWidth <= c.clientWidth + 1 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; });

rodar('Persona Marina — Extratos e conciliação', async ({ b, passo, entrar }) => {
  const M = marca('Cnc');
  const sfx = String(Date.now()).slice(-7);
  let seq = 0;
  // Valores únicos (centavos) para outros agentes/testes não roubarem a sugestão
  const base = 7000 + (Date.now() % 1500);
  const val = (k) => Math.round((base + k * 13.37) * 100) / 100;
  const obraC = (await um(admin.from('obras').select('id, nome').eq('fluxo', 'C').limit(1)))[0];
  const cats = await um(admin.from('categorias').select('id, nome').eq('tipo', 'despesa').eq('ativo', true).order('nome'));
  const fin = await cliente('financeiro');
  const finId = (await fin.auth.getUser()).data.user.id;
  const erroApp = (fn) => fn().then(() => null, (e) => e.message);

  /** OFX no formato da Caixa (tudo numa linha, Windows-1252). */
  function ofx(nome, conta, linhas, saldo = '1000.00') {
    const t = linhas.map(([d, v, memo, id]) => `<STMTTRN><TRNTYPE>${v < 0 ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${d.replace(/-/g, '')}030000<TRNAMT>${v}<FITID>${id}<MEMO>${memo}</STMTTRN>`).join('');
    const txt = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:1252\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0104<BRANCHID>0042<ACCTID>${conta}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>${hoje.replace(/-/g, '')}<DTEND>${hoje.replace(/-/g, '')}${t}</BANKTRANLIST><LEDGERBAL><BALAMT>${saldo}<DTASOF>${hoje.replace(/-/g, '')}</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const p = path.join(DIR, nome);
    fs.writeFileSync(p, Buffer.from(txt, 'latin1'));
    return p;
  }
  /** Cria conta + importação "à mão" (atalho para cenários que não são sobre a importação em si). */
  async function contaComLinhas(nome, linhas) {
    const conta = (await um(admin.from('contas_bancarias').insert({ nome: `${nome} ${M}`, banco: '777', agencia: '1', conta: `${sfx}${++seq}`, created_by: finId }).select('id').single())).id;
    const imp = (await um(admin.from('extrato_importacoes').insert({ conta_id: conta, arquivo: `${nome}.ofx`, created_by: finId }).select('id').single())).id;
    const ls = await um(admin.from('extrato_linhas').insert(linhas.map(([data, valor, descricao, fitid]) => ({ conta_id: conta, importacao_id: imp, data, valor, tipo: valor < 0 ? 'DEBIT' : 'CREDIT', descricao: `${descricao} ${M}`, fitid: fitid ?? `${M}-${Math.random()}` }))).select('id, descricao, valor'));
    return { conta, linhas: ls };
  }
  const nova = async ({ fav, valor, venc = hoje, contaId, parcelas = null }) =>
    um(fin.rpc('criar_pagamento_completo', {
      p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: `${fav} ${M}`, p_descricao: `Desp ${M}`, p_valor: valor, p_vencimento: venc,
      p_forma_pagamento: 'boleto', p_categoria_id: cats[0].id, p_conta_id: contaId, p_numero_documento: '', p_observacoes: '', p_competencia: null,
      p_parcelas: parcelas, p_repetir_intervalo: null, p_repetir_vezes: null, p_provisao_id: null,
    }));
  const pag = async (id) => (await um(admin.from('pagamentos').select('*').eq('id', id).single()));
  const linhaDb = async (id) => (await um(admin.from('extrato_linhas').select('*').eq('id', id).single()));
  const conc = (linhaId, itens, dif = null) => um(fin.rpc('conciliar_linha', { p_linha_id: linhaId, p_itens: itens, p_diferenca: dif }));
  const desf = (linhaId, voltar, motivo = 'Conferência da Marina') => um(fin.rpc('desfazer_conciliacao', { p_linha_id: linhaId, p_voltar_aberto: voltar, p_motivo: motivo }));
  const baixar = (id, valor, data = hoje) => um(fin.rpc('registrar_baixa', { p_id: id, p_pago_em: data, p_valor_pago: valor ?? null, p_observacao: 'persona', p_diferenca: 'saldo' }));
  const linhaUI = (p, texto) => p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: texto }) }).first();
  const abrirConta = (p, conta, extra = '') => ir(p, `/contas-bancarias?conta=${conta}${extra}`);
  const esperaSumir = (p, texto) => p.waitForFunction((t) => !Array.from(document.querySelectorAll('[data-linha-banco]')).some((e) => e.textContent.includes(t)), texto, { timeout: 20000 });
  async function importar(p, arquivo) {
    await ir(p, '/contas-bancarias');
    const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', { name: 'Importar extrato OFX' }).first().click()]);
    await fc.setFiles(arquivo);
    await Promise.race([p.waitForURL(/importado=/, { timeout: 60000 }), p.getByText(/Nada foi importado|não é um extrato|não informa/).first().waitFor({ timeout: 60000 })]);
    await p.waitForLoadState('networkidle');
  }

  const p = await entrar('financeiro');
  p.on('dialog', (d) => d.accept());
  const cel = await entrar('financeiro', 390);

  // ───────────── Importação ─────────────
  const acct = `8${sfx}0`;
  const [d1, d2] = [somarDias(hoje, -2), somarDias(hoje, -1)];
  const arq4 = ofx(`marina-${sfx}-a.ofx`, acct, [
    [d1, -val(1), `PAGTO BOLETO REPETIDO ${M}`, `R${sfx}`],
    [d1, -val(1), `PAGTO BOLETO REPETIDO ${M}`, `R${sfx}`], // linha idêntica legítima (a Caixa repete)
    [d2, -val(2), `PIX ENVIADO UNICO ${M}`, `U${sfx}`],
    [d2, 150.5, `TED RECEBIDA ${M}`, `E${sfx}`],
  ], '4321.09');
  let contaA;
  await passo('importar OFX com 2 linhas idênticas: entram as 4 (repetida legítima não é descartada), conta criada pelo arquivo e saldo gravado', async () => {
    await importar(p, arq4);
    const msg = await p.getByText(/Extrato importado/).first().innerText();
    confere(/4 lançamento\(s\) novo\(s\)/.test(msg), msg);
    contaA = new URL(p.url()).searchParams.get('conta');
    const ls = await um(admin.from('extrato_linhas').select('descricao, valor').eq('conta_id', contaA));
    const c = await um(admin.from('contas_bancarias').select('banco, agencia, conta, saldo').eq('id', contaA).single());
    confere(ls.length === 4 && ls.filter((x) => x.descricao.includes('REPETIDO')).length === 2, `${ls.length} linhas`);
    confere(c.banco === '104' && c.agencia === '42' && Number(c.saldo) === 4321.09, JSON.stringify(c));
    confere(await p.locator('[data-linha-banco]').count() === 4, 'a tela deveria mostrar 4 pendentes');
  });

  await passo('reimportar o mesmo arquivo não duplica (0 novas, 4 já importadas); arquivo com 3 repetidas só traz a que faltava', async () => {
    await importar(p, arq4);
    const msg = await p.getByText(/Extrato importado/).first().innerText();
    confere(/0 lançamento\(s\) novo\(s\), 4 já importado\(s\)/.test(msg), msg);
    const arq5 = ofx(`marina-${sfx}-b.ofx`, acct, [
      [d1, -val(1), `PAGTO BOLETO REPETIDO ${M}`, `R${sfx}`], [d1, -val(1), `PAGTO BOLETO REPETIDO ${M}`, `R${sfx}`], [d1, -val(1), `PAGTO BOLETO REPETIDO ${M}`, `R${sfx}`],
    ]);
    await importar(p, arq5);
    const msg2 = await p.getByText(/Extrato importado/).first().innerText();
    confere(/1 lançamento\(s\) novo\(s\), 2 já importado\(s\)/.test(msg2), msg2);
    confere((await um(admin.from('extrato_linhas').select('id').eq('conta_id', contaA))).length === 5, 'total de linhas');
  });

  await passo('arquivos inválidos são recusados sem importar nada: extensão errada, sem <OFX>, sem conta, cartão de crédito, OFX sem lançamentos', async () => {
    const ruim = async (nome, conteudo) => { const f = path.join(DIR, nome); fs.writeFileSync(f, conteudo); return f; };
    const casos = [
      [await ruim(`marina-${sfx}.txt`, 'texto qualquer'), /formato OFX/],
      [await ruim(`marina-${sfx}-x.ofx`, 'isto não é um extrato'), /não é um extrato OFX/],
      [await ruim(`marina-${sfx}-y.ofx`, '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>104</BANKACCTFROM><BANKTRANLIST></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>'), /não informa a conta/],
      [await ruim(`marina-${sfx}-z.ofx`, '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CCACCTFROM><ACCTID>123</ACCTID></CCACCTFROM></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>'), /não informa a conta|cartão de crédito/],
    ];
    for (const [f, re] of casos) {
      await importar(p, f);
      const txt = await p.locator('main').innerText();
      confere(/Nada foi importado/.test(txt) && re.test(txt), `${path.basename(f)}: ${txt.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    const vazio = ofx(`marina-${sfx}-v.ofx`, `8${sfx}9`, []);
    await importar(p, vazio);
    confere(/nenhum lançamento no período/.test(await p.locator('main').innerText()) || /importado/.test(p.url()), 'OFX vazio sem mensagem');
    confere((await um(admin.from('contas_bancarias').select('id').eq('conta', `8${sfx}9`))).length <= 1, 'conta duplicada');
  });

  // ───────────── Sugestões e conciliação ─────────────
  let pRep1, pRep2, pUnico;
  await passo('"Encontramos" (valor igual, vencimento a ≤ 5 dias, mesma conta): Conciliar baixa com a data e o valor do banco e mostra "Pago ✓"', async () => {
    pRep1 = await nova({ fav: 'Repetido1', valor: val(1), venc: d1, contaId: contaA });
    pRep2 = await nova({ fav: 'Repetido2', valor: val(1), venc: d1, contaId: contaA });
    pUnico = await nova({ fav: 'Unico', valor: val(2), venc: d2, contaId: contaA });
    await abrirConta(p, contaA);
    const l = linhaUI(p, 'PIX ENVIADO UNICO');
    confere(await l.locator('[data-sugestao="encontramos"]').count() === 1, 'sem "Encontramos" para o PIX único');
    await l.getByRole('button', { name: 'Conciliar' }).click();
    await esperaSumir(p, 'PIX ENVIADO UNICO');
    const r = await pag(pUnico);
    confere(r.status === 'pago' && r.pago_em === d2 && Number(r.valor_pago) === val(2), JSON.stringify([r.status, r.pago_em, r.valor_pago]));
    await ir(p, `/pagamentos?periodo=todos&busca=${encodeURIComponent('Unico ' + M)}`);
    const sit = await p.locator(`tr[data-linha="pag:${pUnico}"] [data-pago-via]`).innerText();
    confere(/Pago ✓/.test(sit), sit);
  });

  await passo('duas linhas idênticas e duas contas idênticas: cada linha liga a uma conta diferente; reusar a mesma conta é recusado', async () => {
    const ls = await um(admin.from('extrato_linhas').select('id').eq('conta_id', contaA).like('descricao', 'PAGTO BOLETO REPETIDO%').eq('situacao', 'pendente').order('id'));
    confere(ls.length >= 2, `${ls.length} linhas repetidas pendentes`);
    await conc(ls[0].id, [{ tipo: 'pagamento', id: pRep1 }]);
    const e = await erroApp(() => conc(ls[1].id, [{ tipo: 'pagamento', id: pRep1 }]));
    confere(e && /já está conciliado/.test(e), `mesma conta em duas linhas: ${e}`);
    await conc(ls[1].id, [{ tipo: 'pagamento', id: pRep2 }]);
    const e2 = await erroApp(() => conc(ls[1].id, [{ tipo: 'pagamento', id: pRep2 }]));
    confere(e2 && /já foi conciliado/.test(e2), `conciliar linha já conciliada: ${e2}`);
    await abrirConta(p, contaA, '&ver=conciliada');
    confere(await p.locator('[data-conciliada]').count() === 3, 'a aba Movimentações deveria ter 3');
  });

  await passo('entrada (crédito) não é conta a pagar: conciliar como pagamento é recusado; arquivar como "Entrada recebida" funciona e restaurar devolve às pendentes', async () => {
    const entrada = (await um(admin.from('extrato_linhas').select('id').eq('conta_id', contaA).eq('valor', 150.5).single())).id;
    const e = await erroApp(() => conc(entrada, [{ tipo: 'pagamento', id: pRep1 }]));
    confere(e && /Entradas no banco/.test(e), `entrada como pagamento: ${e}`);
    const ruim = await erroApp(() => um(fin.rpc('arquivar_linhas', { p_ids: [entrada], p_classificacao: 'inventada', p_observacao: null })));
    confere(ruim && /classificação/i.test(ruim), `classificação inválida: ${ruim}`);
    await abrirConta(p, contaA);
    const l = linhaUI(p, 'TED RECEBIDA');
    await l.getByRole('button', { name: /Arquivar/ }).click();
    await p.getByRole('menuitem', { name: /Entrada/ }).first().click();
    await esperaSumir(p, 'TED RECEBIDA');
    confere((await linhaDb(entrada)).situacao === 'arquivada' && (await linhaDb(entrada)).classificacao === 'entrada', 'não arquivou');
    await abrirConta(p, contaA, '&ver=arquivada');
    await p.locator(`[data-arquivada="${entrada}"]`).getByRole('button', { name: 'Restaurar' }).click();
    await p.locator(`[data-arquivada="${entrada}"]`).waitFor({ state: 'detached', timeout: 15000 });
    confere((await linhaDb(entrada)).situacao === 'pendente', 'não restaurou');
    const e2 = await erroApp(() => um(fin.rpc('restaurar_linha', { p_id: entrada })));
    confere(e2 && /não está arquivado/.test(e2), `restaurar duas vezes: ${e2}`);
  });

  // Cenário de diferenças de centavos
  const dif = await contaComLinhas('Diferencas', [
    [hoje, -val(10) - 0.01, 'JUROS UM CENTAVO'], [hoje, -val(11) + 0.01, 'DESCONTO UM CENTAVO'], [hoje, -val(12) + 40, 'PARCIAL SALDO'],
    [hoje, -val(13), 'VALOR DIFERENTE BAIXA'], [hoje, -val(14) - 3, 'SEM INFORMAR DIFERENCA'],
  ]);
  const L = (t) => dif.linhas.find((x) => x.descricao.includes(t)).id;
  await passo('"Quase lá" com R$ 0,01 a mais: "Usar valor do extrato" paga o valor do banco (juros); R$ 0,01 a menos vira desconto e quita', async () => {
    const pj = await nova({ fav: 'Juros1c', valor: val(10), contaId: dif.conta });
    const pd = await nova({ fav: 'Desc1c', valor: val(11), contaId: dif.conta });
    await abrirConta(p, dif.conta);
    let l = linhaUI(p, 'JUROS UM CENTAVO');
    await l.getByRole('button', { name: /Ajustar valores/ }).click();
    await l.getByRole('menuitem', { name: /Usar valor do extrato/ }).click();
    await esperaSumir(p, 'JUROS UM CENTAVO');
    const a = await pag(pj);
    confere(a.status === 'pago' && Number(a.valor_pago) === Math.round((val(10) + 0.01) * 100) / 100, JSON.stringify([a.status, a.valor_pago]));
    l = linhaUI(p, 'DESCONTO UM CENTAVO');
    await l.getByRole('button', { name: /Ajustar valores/ }).click();
    await l.getByRole('menuitem', { name: /Usar valor do extrato/ }).click();
    await esperaSumir(p, 'DESCONTO UM CENTAVO');
    const c = await pag(pd);
    confere(c.status === 'pago' && Number(c.valor_pago) === Math.round((val(11) - 0.01) * 100) / 100, JSON.stringify([c.status, c.valor_pago]));
    void L;
  });

  await passo('diferença sem confirmar é recusada pelo banco (banco a mais exige "juros"; a menos exige "desconto" ou "saldo"); pagamento parcial por saldo deixa o resto em aberto', async () => {
    const ps = await nova({ fav: 'ParcialSaldo', valor: val(12), contaId: dif.conta });
    const e1 = await erroApp(() => conc(L('SEM INFORMAR'), [{ tipo: 'pagamento', id: ps }]));
    confere(e1, 'conciliar valor diferente sem informar a diferença foi aceito');
    const pm = await nova({ fav: 'SemInformar', valor: val(14), contaId: dif.conta });
    const e2 = await erroApp(() => conc(L('SEM INFORMAR'), [{ tipo: 'pagamento', id: pm }]));
    confere(e2 && /a mais.*juros|juros/.test(e2), `banco a mais sem juros: ${e2}`);
    await conc(L('PARCIAL SALDO'), [{ tipo: 'pagamento', id: ps }], 'saldo').catch((e) => { throw new Error('parcial: ' + e.message); });
    const r = await pag(ps);
    const parcs = await um(admin.from('pagamento_parcelas').select('numero, status, valor_base, valor_pago').eq('pagamento_id', ps).order('numero'));
    confere(r.status === 'aguardando_pagamento' && parcs.length === 2 && parcs[0].status === 'pago' && Number(parcs[0].valor_pago) === Math.round((val(12) - 40) * 100) / 100 && Number(parcs[1].valor_base) === 40 && parcs[1].status === 'a_pagar', JSON.stringify(parcs));
  });

  await passo('conta JÁ BAIXADA com valor diferente do banco só liga se o valor for igual; senão o erro cita os dois valores', async () => {
    const pb = await nova({ fav: 'JaBaixada', valor: val(13) + 5, contaId: dif.conta });
    await baixar(pb, null);
    const e = await erroApp(() => conc(L('VALOR DIFERENTE'), [{ tipo: 'pagamento', id: pb }]));
    confere(e && /foi baixado com R\$/.test(e) && /diferente do banco/.test(e), `baixada x banco: ${e}`);
    const pi = await nova({ fav: 'JaBaixadaIgual', valor: val(13), contaId: dif.conta });
    await baixar(pi, null);
    await conc(L('VALOR DIFERENTE'), [{ tipo: 'pagamento', id: pi }]);
    const it = await um(admin.from('conciliacao_itens').select('baixou').eq('pagamento_id', pi).single());
    confere(it.baixou === false, 'a conciliação não deveria marcar que baixou (baixa foi manual)');
    // "Pago ✓" aparece porque agora está conciliada
    await ir(p, `/pagamentos?periodo=todos&busca=${encodeURIComponent('JaBaixadaIgual ' + M)}`);
    confere(/Pago ✓/.test(await p.locator(`tr[data-linha="pag:${pi}"] [data-pago-via]`).innerText()), 'sem ✓ depois de conciliar');
    // Desfazer "apenas desligar": continua paga, volta a "baixa manual" e a linha volta às pendentes
    await desf(L('VALOR DIFERENTE'), false);
    await ir(p, `/pagamentos?periodo=todos&busca=${encodeURIComponent('JaBaixadaIgual ' + M)}`);
    const sit = await p.locator(`tr[data-linha="pag:${pi}"] [data-pago-via]`).innerText();
    confere(/baixa manual/.test(sit) && (await pag(pi)).status === 'pago' && (await linhaDb(L('VALOR DIFERENTE'))).situacao === 'pendente', sit);
  });

  // Desfazer pela tela e estorno por outro caminho
  const des = await contaComLinhas('Desfazer', [[hoje, -val(20), 'PAGTO PARA DESFAZER'], [hoje, -val(21), 'PAGTO ESTORNO MANUAL'], [hoje, -val(22), 'PAGTO DESFAZER APENAS']]);
  const D = (t) => des.linhas.find((x) => x.descricao.includes(t)).id;
  await passo('desfazer conciliação pela tela (estornar a baixa): motivo obrigatório, conta volta a "a pagar", linha volta às pendentes; a janela cabe em 1440px e 390px', async () => {
    const pd = await nova({ fav: 'Desfazer1', valor: val(20), contaId: des.conta });
    await conc(D('PARA DESFAZER'), [{ tipo: 'pagamento', id: pd }]);
    for (const [pg, nome] of [[p, '1440'], [cel, '390']]) {
      await abrirConta(pg, des.conta, '&ver=conciliada');
      await pg.locator(`[data-conciliada="${D('PARA DESFAZER')}"]`).getByRole('button', { name: 'Desfazer' }).click();
      const d = pg.getByRole('dialog', { name: 'Desfazer conciliação' });
      confere(await cabe(d), `${nome}px: janela Desfazer cortando`);
      if (nome === '390') { await pg.keyboard.press('Escape'); await d.getByRole('button', { name: 'Voltar' }).click(); }
    }
    await abrirConta(p, des.conta, '&ver=conciliada');
    await p.locator(`[data-conciliada="${D('PARA DESFAZER')}"]`).getByRole('button', { name: 'Desfazer' }).click();
    const d = p.getByRole('dialog', { name: 'Desfazer conciliação' });
    confere(await d.getByRole('button', { name: 'Desfazer' }).isDisabled(), 'sem motivo e já habilitado');
    await d.getByText(/estornar a baixa feita pela conciliação/).click();
    await d.getByLabel('Motivo').fill('Valor lançado na conta errada');
    await d.getByRole('button', { name: 'Desfazer' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    const r = await pag(pd);
    confere(r.status === 'aguardando_pagamento' && r.pago_em === null && (await linhaDb(D('PARA DESFAZER'))).situacao === 'pendente', JSON.stringify([r.status, r.pago_em]));
  });

  await passo('estornar a baixa por Contas a pagar (Voltar para em aberto) de uma conta conciliada devolve a linha às pendentes sozinha', async () => {
    const pe = await nova({ fav: 'EstornoManual', valor: val(21), contaId: des.conta });
    await conc(D('ESTORNO MANUAL'), [{ tipo: 'pagamento', id: pe }]);
    confere((await linhaDb(D('ESTORNO MANUAL'))).situacao === 'conciliada', 'não conciliou');
    await um(fin.rpc('estornar_baixa', { p_id: pe, p_motivo: 'Estorno direto' }));
    confere((await linhaDb(D('ESTORNO MANUAL'))).situacao === 'pendente', 'linha do banco continuou conciliada depois do estorno');
    confere((await um(admin.from('conciliacao_itens').select('id').eq('pagamento_id', pe))).length === 0, 'vínculo sobrou');
    // Excluir lançamento conciliado e pago também desfaz o vínculo
    const px = await nova({ fav: 'ExcluirConciliada', valor: val(22), contaId: des.conta });
    await conc(D('DESFAZER APENAS'), [{ tipo: 'pagamento', id: px }]);
    await um(fin.rpc('excluir_lancamentos', { p_pagamento_id: px, p_parcela_id: null, p_escopo: 'atual', p_motivo: 'Excluída pela Marina' }));
    confere((await pag(px)).status === 'cancelado' && (await linhaDb(D('DESFAZER APENAS'))).situacao === 'pendente', 'excluir conta conciliada não devolveu a linha');
  });

  // Fatura de cartão: uma saída, várias contas
  const fat = await contaComLinhas('Fatura', [[hoje, -val(30), 'PAGTO CARTAO FATURA'], [hoje, -val(31), 'PAGTO CARTAO MENOR']]);
  await passo('fatura: 1 saída para 2 contas — soma maior que o banco é recusada; menor exige "encargos"; com encargos registra a diferença nas Movimentações', async () => {
    const a = await nova({ fav: 'CompraA', valor: 200, contaId: fat.conta });
    const c = await nova({ fav: 'CompraB', valor: val(30) - 200 - 45.5, contaId: fat.conta }); // soma = banco - 45,50 de encargos
    const idL = fat.linhas.find((x) => x.descricao.includes('FATURA')).id;
    const itens = [{ tipo: 'pagamento', id: a }, { tipo: 'pagamento', id: c }];
    const e1 = await erroApp(() => conc(idL, itens)); confere(e1 && /confirme que são encargos/.test(e1), `sem encargos: ${e1}`);
    await conc(idL, itens, 'encargos');
    const ll = await linhaDb(idL);
    confere(ll.situacao === 'conciliada' && Number(ll.encargos) === 45.5, JSON.stringify([ll.situacao, ll.encargos]));
    await abrirConta(p, fat.conta, '&ver=conciliada');
    confere(/45,50 de encargos/.test(await p.locator('[data-encargos]').innerText()), 'encargos não aparecem');
    const m = await nova({ fav: 'CompraMaior', valor: val(31) + 10, contaId: fat.conta });
    const m2 = await nova({ fav: 'CompraMaior2', valor: 5, contaId: fat.conta });
    const e2 = await erroApp(() => conc(fat.linhas.find((x) => x.descricao.includes('MENOR')).id, [{ tipo: 'pagamento', id: m }, { tipo: 'pagamento', id: m2 }]));
    confere(e2 && /maior que o valor do banco/.test(e2), `soma maior: ${e2}`);
    // Limpeza: contas em aberto que sobrariam como "candidatas" nas sugestões de outros cenários
    for (const id of [m, m2]) await um(fin.rpc('excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: null, p_escopo: 'atual', p_motivo: 'Limpeza do cenário' }));
  });

  // Parcelas e conciliação
  const par = await contaComLinhas('Parcelas', [[hoje, -33.33, 'PARCELA UM'], [hoje, -33.34, 'PARCELA TRES']]);
  await passo('parcelas na conciliação: o pagamento parcelado exige escolher a parcela; cada parcela concilia com sua linha; parcela não vira pagamento parcial', async () => {
    const id = await nova({ fav: 'Parcelado', valor: 100, venc: hoje, contaId: par.conta, parcelas: [33.33, 33.33, 33.34].map((v, i) => ({ valor: v, vencimento: somarDias(hoje, i * 30), multa: 0, juros: 0, desconto: 0, motivo: null })) });
    const ps = await um(admin.from('pagamento_parcelas').select('id, numero').eq('pagamento_id', id).order('numero'));
    const l1 = par.linhas.find((x) => x.descricao.includes('UM')).id;
    const e1 = await erroApp(() => conc(l1, [{ tipo: 'pagamento', id }]));
    confere(e1 && /parcelado/.test(e1), `pagamento parcelado inteiro: ${e1}`);
    await conc(l1, [{ tipo: 'parcela', id: ps[0].id }]);
    const st = (await um(admin.from('pagamento_parcelas').select('status, pago_em, valor_pago').eq('id', ps[0].id).single()));
    confere(st.status === 'pago' && Number(st.valor_pago) === 33.33 && (await pag(id)).status === 'aguardando_pagamento', JSON.stringify(st));
    const l3 = par.linhas.find((x) => x.descricao.includes('TRES')).id;
    const e3 = await erroApp(() => conc(l3, [{ tipo: 'parcela', id: ps[2].id }], 'saldo'));
    confere(e3 === null, `parcela 33,34 x banco 33,34 deveria conciliar: ${e3}`);
    const e4 = await erroApp(() => conc(l1, [{ tipo: 'parcela', id: ps[1].id }]));
    confere(e4 && /já foi conciliado/.test(e4), `linha já conciliada: ${e4}`);
  });

  // Filtros e seleção da tela
  const flt = await contaComLinhas('Filtros', [
    [somarDias(hoje, -40), -val(40), 'ANTIGO PARA FILTRO'], [hoje, -val(41), 'MEIO FILTRO MAIOR'], [hoje, -20.01, 'MEIO FILTRO MENOR'], [hoje, 321.45, 'CREDITO FILTRO'], [hoje, -val(42), 'ENCONTRAMOS LOTE'], [hoje, -val(43), 'SEM PAR LOTE'],
  ]);
  const F = (t) => flt.linhas.find((x) => x.descricao.includes(t)).id;
  await passo('filtros da conciliação: pesquisa por texto e por valor, abas Recebimentos/Pagamentos, mês anterior/seguinte e ordenação por maior valor', async () => {
    await abrirConta(p, flt.conta);
    const n = () => p.locator('[data-linha-banco]').count();
    confere(await n() === 6, `pendentes: ${await n()}`);
    await ir(p, `/contas-bancarias?conta=${flt.conta}&busca=${encodeURIComponent('MEIO FILTRO')}`);
    confere(await n() === 2, 'busca por texto');
    await ir(p, `/contas-bancarias?conta=${flt.conta}&busca=${encodeURIComponent('321,45')}`);
    confere(await n() === 1, 'busca por valor 321,45');
    await abrirConta(p, flt.conta, '&tipo=entradas'); confere(await n() === 1, 'aba Recebimentos');
    await abrirConta(p, flt.conta, '&tipo=saidas'); confere(await n() === 5, 'aba Pagamentos');
    await abrirConta(p, flt.conta, `&mes=${hoje.slice(0, 7)}`); confere(await n() === 5, 'mês atual: 5 (o de 40 dias atrás fica de fora)');
    const anterior = (() => { const [a, m] = hoje.slice(0, 7).split('-').map(Number); const x = new Date(Date.UTC(a, m - 2, 1)); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; })();
    await p.getByRole('link', { name: 'Mês anterior' }).click(); await p.waitForURL((u) => u.searchParams.get('mes') === anterior); await p.waitForLoadState('networkidle');
    confere(await n() <= 1, 'mês anterior');
    await abrirConta(p, flt.conta, '&tipo=saidas&ordem=maior');
    const primeira = await p.locator('[data-descricao-banco]').first().innerText();
    const maior = flt.linhas.filter((x) => Number(x.valor) < 0).sort((x, y) => Number(x.valor) - Number(y.valor))[0].descricao;
    confere(primeira.trim() === maior, `ordem por maior valor: ${primeira} x ${maior}`);
    const valorPend = (await p.locator('[data-valor-pendente]').innerText()).replace(/\s+/g, ' ');
    confere(/6\)|\(6/.test(valorPend), `valor pendente: ${valorPend}`);
  });

  await passo('seleção em lote: "Com sugestão Encontramos" marca só as que têm par; Conciliar (n) concilia essas e deixa as outras; Arquivar em lote classifica as demais', async () => {
    const pl = await nova({ fav: 'EncLote', valor: val(42), contaId: flt.conta });
    await abrirConta(p, flt.conta);
    await p.getByRole('button', { name: /Selecionar lançamentos/ }).click();
    await p.getByRole('menuitem', { name: /Com sugestão “Encontramos”/ }).click();
    const marcadas = await p.locator('input.sel-linha:checked').count();
    confere(marcadas === 1, `${marcadas} marcadas`);
    await p.getByRole('button', { name: /^Conciliar \(1\)/ }).click();
    await esperaSumir(p, 'ENCONTRAMOS LOTE');
    confere((await pag(pl)).status === 'pago', 'não baixou pela conciliação em lote');
    confere(await p.locator('[data-linha-banco]').count() === 5, 'as outras deveriam continuar pendentes');
    // arquivar as duas "MEIO FILTRO" como tarifa
    await p.locator('input.sel-linha[aria-label*="MEIO FILTRO"]').check({ multiple: true }).catch(async () => { for (const c of await p.locator('input.sel-linha[aria-label*="MEIO FILTRO"]').all()) await c.check(); });
    await p.locator('[data-ignorar-marcadas]').click();
    await p.getByRole('menuitem', { name: /Tarifa/ }).first().click();
    await p.waitForFunction(() => document.querySelectorAll('[data-linha-banco]').length === 3, null, { timeout: 20000 });
    const arq = await um(admin.from('extrato_linhas').select('classificacao').eq('conta_id', flt.conta).eq('situacao', 'arquivada'));
    confere(arq.length === 2 && arq.every((x) => x.classificacao === 'tarifa'), JSON.stringify(arq));
    void F;
  });

  await passo('nova transferência entre contas: a saída fica conciliada e a entrada na outra conta aparece "Encontramos"; desfazer solta a transferência', async () => {
    const vt = Math.round((987654.32 + (Date.now() % 100) / 100) * 100) / 100; // valor distante de qualquer conta em aberto
    const o = await contaComLinhas('TransfOrigem', [[hoje, -vt, 'TED ENVIADA ENTRE CONTAS']]);
    const dst = await contaComLinhas('TransfDestino', [[hoje, vt, 'TED RECEBIDA ENTRE CONTAS']]);
    await abrirConta(p, o.conta);
    const l = linhaUI(p, 'TED ENVIADA');
    await l.getByRole('tab', { name: 'Nova transferência' }).click();
    await l.locator('select[aria-label="Conta de destino"]').selectOption(dst.conta);
    await l.locator('[data-conciliar-novo]').click();
    await esperaSumir(p, 'TED ENVIADA');
    await abrirConta(p, dst.conta);
    const e = linhaUI(p, 'TED RECEBIDA');
    confere(await e.locator('[data-sugestao="transferencia"]').count() === 1, 'sem sugestão de transferência na outra ponta');
    await e.locator('[data-conciliar-novo]').click();
    await esperaSumir(p, 'TED RECEBIDA');
    const t = (await um(admin.from('transferencias').select('linha_origem, linha_destino, valor').eq('conta_origem', o.conta)))[0];
    confere(t && t.linha_destino && Number(t.valor) === vt, JSON.stringify(t));
    await desf(o.linhas[0].id, false, 'Transferência errada');
    confere((await linhaDb(o.linhas[0].id)).situacao === 'pendente', 'desfazer não devolveu a saída');
  });

  // Permissões
  await passo('permissões: Suprimentos e Engenheiro não abrem Contas bancárias nem importam extrato/conciliam pelo banco; Administrador master só olha', async () => {
    for (const perfil of ['suprimentos', 'engenheiro']) {
      const c = await cliente(perfil);
      const e = await erroApp(() => um(c.rpc('importar_extrato', { p_banco: '104', p_agencia: '1', p_conta: '1', p_arquivo: 'x.ofx', p_inicio: hoje, p_fim: hoje, p_saldo: 1, p_saldo_em: hoje, p_linhas: [] })));
      confere(e && /Somente o Financeiro/.test(e), `${perfil} importou: ${e}`);
      const e2 = await erroApp(() => um(c.rpc('conciliar_linha', { p_linha_id: dif.linhas[0].id, p_itens: [{ tipo: 'pagamento', id: pUnico }], p_diferenca: null })));
      confere(e2 && /Somente o Financeiro/.test(e2), `${perfil} conciliou: ${e2}`);
      const visivel = await um(c.from('extrato_linhas').select('id').limit(1));
      confere(visivel.length === 0, `${perfil} lê o extrato`);
      const pg = await entrar(perfil);
      await pg.goto(BASE + '/contas-bancarias'); await pg.waitForLoadState('networkidle');
      confere(!new URL(pg.url()).pathname.startsWith('/contas-bancarias'), `${perfil} abriu /contas-bancarias`);
    }
    const m = await entrar('administrador_master').catch(() => null);
    if (m) {
      await m.goto(BASE + `/contas-bancarias?conta=${flt.conta}`); await m.waitForLoadState('networkidle');
      confere(await m.getByRole('button', { name: 'Importar extrato OFX' }).count() === 0, 'master vê "Importar extrato"');
      confere(await m.locator('[data-conciliar-novo]').count() === 0, 'master vê o botão Conciliar');
    }
  });

  // Layout
  await passo('conciliação sem rolagem lateral (1280px e 390px) em Pendentes, Movimentações e Arquivados; janelas da conta cabem', async () => {
    const p1280 = await entrar('financeiro', 1280);
    const problemas = [];
    for (const [pg, w] of [[p1280, 1280], [cel, 390]]) {
      for (const extra of ['', '&ver=conciliada', '&ver=arquivada']) {
        for (const conta of [flt.conta, dif.conta, fat.conta]) {
          await abrirConta(pg, conta, extra);
          if (!(await semRolagem(pg))) {
            const onde = await pg.evaluate(() => [...document.querySelectorAll('main *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)).map((x) => `${x.scrollWidth}>${x.clientWidth}`).join(' '));
            problemas.push(`${extra || 'pendentes'} (${w}px: ${onde || 'página'})`);
          }
        }
      }
    }
    await cel.screenshot({ path: path.join(DIR, 'marina-conciliacao-390.png') });
    confere(problemas.length === 0, `rolagem lateral em: ${[...new Set(problemas)].join(' | ')}`);
    // Janelas "Ajustar valores"/Buscar conta a pagar no celular
    await abrirConta(cel, dif.conta);
    const lb = cel.locator('[data-linha-banco]').first();
    const busca = lb.getByRole('button', { name: /Buscar lançamento/ });
    if (await busca.count()) {
      await busca.click();
      const d = cel.getByRole('dialog').first();
      confere(await cabe(d), 'janela "Buscar conta a pagar" cortando no celular');
    }
  });

  // Limpeza final (não conta como caso): tira de circulação o que sobrou em aberto, para não virar sugestão em outros testes
  try {
    const abertos = await um(admin.from('pagamentos').select('id').like('descricao', `%${M}%`).in('status', ['aguardando_pagamento']));
    for (const x of abertos) await fin.rpc('excluir_lancamentos', { p_pagamento_id: x.id, p_parcela_id: null, p_escopo: 'todos', p_motivo: 'Limpeza da persona' });
  } catch { /* melhor esforço */ }
});
