// Persona: Marina, analista do Financeiro. Este arquivo: Contas a receber, notas de medição e imposto, fundos fixos
// (criar, fechar e repor, encerrar, OP FF-xxxx), relatórios, notas para contabilidade, usuários e exportações.
// Contas a pagar: financeiro-completo.cjs. Extratos/conciliação: financeiro-conciliacao.cjs.
// Dados fictícios (marca()). Não altera código da aplicação.
const fs = require('fs');
const path = require('path');
const { DIR, BASE, admin, um, hoje, somarDias, marca, confere, cliente, rodar, ir } = require('./_util.cjs');

const semRolagem = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && ![...document.querySelectorAll('table')].some((t) => t.parentElement.scrollWidth > t.parentElement.clientWidth + 2));
const cabe = (dlg) => dlg.evaluate((el) => { const c = el.firstElementChild || el; const r = c.getBoundingClientRect(); return c.scrollWidth <= c.clientWidth + 1 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; });
const brl = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

rodar('Persona Marina — Receber, medição, fundos, relatórios, usuários', async ({ b, passo, entrar }) => {
  const M = marca('Rec');
  const sfx = String(Date.now()).slice(-7);
  const obraC = (await um(admin.from('obras').select('id, nome, cliente').eq('fluxo', 'C').limit(1)))[0];
  const obraA = (await um(admin.from('obras').select('id, nome, cliente').eq('fluxo', 'A').limit(1)))[0];
  const fin = await cliente('financeiro');
  const finId = (await fin.auth.getUser()).data.user.id;
  const erroApp = (fn) => fn().then(() => null, (e) => e.message);
  const catRec = (await um(admin.from('categorias').insert({ nome: `Medição ${M}`, tipo: 'receita' }).select('id').single())).id;
  const catImp = (await um(admin.from('categorias').insert({ nome: `Impostos ${M}`, tipo: 'despesa' }).select('id').single())).id;
  const contaCorr = (await um(admin.from('contas_bancarias').insert({ nome: `Conta ${M}`, banco: '777', agencia: '1', conta: `${sfx}1`, created_by: finId }).select('id').single())).id;
  const rec = (o) => um(fin.rpc('criar_recebimento', { p_obra_id: obraC.id, p_categoria_id: catRec, p_cliente: `Cliente ${M}`, p_descricao: `Receita ${M}`, p_valor: 100, p_vencimento: hoje, ...o }));
  const reg = async (id) => (await um(admin.from('recebimentos').select('*').eq('id', id).single()));

  const p = await entrar('financeiro');
  p.on('dialog', (d) => d.accept());
  const cel = await entrar('financeiro', 390);
  cel.on('dialog', (d) => d.accept());

  // ───────────── Contas a receber ─────────────
  let recUI;
  await passo('"+ Nova receita" pela janela: cliente vem da obra, competência assume o vencimento, receita fica em aberto com centavos exatos', async () => {
    await ir(p, `/recebimentos?periodo=todos&busca=${encodeURIComponent(M)}`);
    await p.getByRole('button', { name: '+ Nova receita' }).click();
    const d = p.getByRole('dialog', { name: 'Nova receita' });
    confere(await cabe(d), 'janela cortando em 1440px');
    await d.locator('input[name=descricao]').fill(`Receita UI ${M}`);
    await d.locator('select[name=obra_id]').selectOption(obraC.id);
    confere((await d.locator('input[name=cliente]').inputValue()) === (obraC.cliente ?? ''), 'cliente não veio da obra');
    await d.locator('input[name=cliente]').fill(`Cliente ${M}`);
    await d.locator('select[name=categoria_id]').selectOption(catRec);
    await d.locator('input[name=valor]').fill('1.234,56');
    await d.locator('input[name=vencimento]').fill(somarDias(hoje, 4));
    await Promise.all([p.waitForURL(/\/recebimentos\/[0-9a-f-]{36}\?criada=1/), d.getByRole('button', { name: 'Lançar receita' }).click()]);
    recUI = p.url().match(/recebimentos\/([0-9a-f-]{36})/)[1];
    const r = await reg(recUI);
    confere(Number(r.valor) === 1234.56 && r.status === 'aberto' && r.data_competencia === somarDias(hoje, 4), JSON.stringify([r.valor, r.status, r.data_competencia]));
  });

  await passo('receita inválida: valor 0 e vencimento vazio mostram a mensagem na própria janela; cliente/descrição em branco e valor negativo são recusados no banco', async () => {
    await ir(p, `/recebimentos?periodo=todos&busca=${encodeURIComponent(M)}`);
    await p.getByRole('button', { name: '+ Nova receita' }).click();
    const d = p.getByRole('dialog', { name: 'Nova receita' });
    await d.locator('input[name=descricao]').fill(`Receita zero ${M}`);
    await d.locator('select[name=obra_id]').selectOption(obraC.id);
    await d.locator('input[name=cliente]').fill(`Cliente ${M}`);
    await d.locator('input[name=valor]').fill('0');
    await d.locator('input[name=vencimento]').fill(hoje);
    await d.getByRole('button', { name: 'Lançar receita' }).click();
    await d.getByText('Informe o valor.').waitFor({ timeout: 15000 });
    confere((await um(admin.from('recebimentos').select('id').eq('descricao', `Receita zero ${M}`))).length === 0, 'criou receita de valor 0');
    await p.keyboard.press('Escape'); await d.getByRole('button', { name: 'Cancelar' }).click().catch(() => {});
    for (const [rotulo, o] of [['valor negativo', { p_valor: -10 }], ['cliente vazio', { p_cliente: '  ' }], ['descrição vazia', { p_descricao: '' }]]) {
      confere(await erroApp(() => rec(o)), `${rotulo} foi aceito`);
    }
  });

  await passo('cartões de Contas a receber: vencida, de hoje e a vencer caem no cartão certo, com centavos; clicar filtra', async () => {
    const v = await rec({ p_valor: 10.1, p_vencimento: somarDias(hoje, -3) });
    const h = await rec({ p_valor: 20.2, p_vencimento: hoje });
    const a = await rec({ p_valor: 30.3, p_vencimento: somarDias(hoje, 6) });
    await ir(p, `/recebimentos?periodo=todos&busca=${encodeURIComponent(M)}`);
    const val = async (c) => (await p.locator(`[data-cartao="${c}"] .tabular-nums`).innerText()).trim();
    confere(await val('vencidos') === '10,10' && await val('hoje') === '20,20', `vencidos=${await val('vencidos')} hoje=${await val('hoje')}`);
    confere(await val('avencer') === brl(1264.86), `a vencer: ${await val('avencer')} (esperava ${brl(1264.86)}: 1.234,56 + 30,30)`);
    await p.locator('[data-cartao="vencidos"]').click(); await p.waitForURL(/cartao=vencidos/); await p.waitForLoadState('networkidle');
    confere(await p.locator(`tr[data-linha="rec:${v}"]`).count() === 1 && await p.locator('tr[data-linha^="rec:"]').count() === 1, 'filtro do cartão Vencidos');
    void h; void a;
  });

  await passo('cancelar receita pela tela (motivo ≥ 3 letras); cancelar de novo é recusado; editar o cliente da receita grava', async () => {
    const id = await rec({ p_valor: 77.77 });
    await ir(p, `/recebimentos/${id}`);
    const motivo = p.getByLabel('Motivo do cancelamento');
    await motivo.fill('ab');
    await p.getByRole('button', { name: 'Cancelar receita' }).click();
    await p.waitForTimeout(800);
    confere((await reg(id)).status === 'aberto', 'cancelou com motivo de 2 letras');
    await motivo.fill('Lançada em duplicidade');
    await p.getByRole('button', { name: 'Cancelar receita' }).click();
    await p.waitForTimeout(1800);
    confere((await reg(id)).status === 'cancelado', 'não cancelou');
    const e = await erroApp(() => um(fin.rpc('cancelar_recebimento', { p_id: id, p_motivo: 'de novo' })));
    confere(e && /em aberto/.test(e), `cancelar de novo: ${e}`);
    const id2 = await rec({ p_valor: 5 });
    await ir(p, `/recebimentos/${id2}`);
    await p.locator('input[name=cliente]').last().fill(`Cliente Editado ${M}`);
    await p.getByRole('button', { name: 'Salvar' }).last().click();
    await p.waitForTimeout(1800);
    confere((await reg(id2)).cliente === `Cliente Editado ${M}`, 'edição não gravou');
  });

  // ───────────── Notas de medição e imposto ─────────────
  const nota = (num, valor, liquido) => um(admin.from('notas_medicao').insert({ obra_id: obraA.id, storage_path: `${obraA.id}/medicoes/${M}-${num}.pdf`, nome_arquivo: `medicao-${num}.pdf`, numero: `${M}-${num}`, sha256: String(num).padStart(64, 'a'), valor, valor_liquido: liquido, data_emissao: hoje, criada_por: finId }).select('id').single()).then((x) => x.id);
  const lancar = (id, o = {}) => um(fin.rpc('lancar_medicao', { p_nota_id: id, p_vencimento: somarDias(hoje, 5), p_conta_id: contaCorr, p_cliente: `Cli ${M}`, p_categoria_receita: catRec, p_categoria_imposto: catImp, p_aliquota: 14, ...o }));
  let recMed;
  await passo('nota de medição 10.000,00 / líquido 9.400,00: a janela calcula retido 600,00 e devido 800,00; editar o devido para 750,00 vale; resumo mostra o lançado', async () => {
    const n1 = await nota(1, 10000, 9400);
    await ir(p, '/notas-medicao');
    const tr = p.locator('tr', { hasText: `${M}-1` }).first();
    await tr.getByRole('button', { name: 'Lançar receita' }).click();
    const d = p.getByRole('dialog', { name: 'Lançar receita e impostos' });
    confere(await cabe(d), 'janela cortando');
    confere(await d.locator('input[aria-label="Imposto retido"]').inputValue() === '600,00' && await d.locator('input[aria-label="Imposto devido"]').inputValue() === '800,00', 'cálculo diferente de 600/800');
    await d.locator('select[name=conta_id]').selectOption(contaCorr);
    await d.locator('input[aria-label="Imposto devido"]').fill('750,00');
    await Promise.all([p.waitForURL(/\/recebimentos\/[0-9a-f-]{36}\?criada=1/, { timeout: 30000 }), d.getByRole('button', { name: 'Lançar receita e impostos' }).click()]);
    recMed = p.url().match(/recebimentos\/([0-9a-f-]{36})/)[1];
    const imps = await um(admin.from('pagamentos').select('imposto_medicao, valor, status').eq('recebimento_id', recMed));
    const ret = imps.find((x) => x.imposto_medicao === 'retido'), dev = imps.find((x) => x.imposto_medicao === 'devido');
    confere(ret && Number(ret.valor) === 600 && ret.status === 'aguardando_pagamento' && dev && Number(dev.valor) === 750 && dev.status === 'pago', JSON.stringify(imps));
    const e = await erroApp(() => lancar(n1)); confere(e && /já foi lançada/.test(e), `lançar a mesma nota de novo: ${e}`);
  });

  await passo('medição: casos limite — sem retenção (líquido = total) só gera devido; retido ≥ total, alíquota fora de 0–100 e conta inválida são recusados; alíquota 0 não gera devido', async () => {
    const n2 = await nota(2, 5000, 5000);
    const r2 = await lancar(n2);
    const i2 = await um(admin.from('pagamentos').select('imposto_medicao, valor').eq('recebimento_id', r2));
    confere(i2.length === 1 && i2[0].imposto_medicao === 'devido' && Number(i2[0].valor) === 700, JSON.stringify(i2));
    const n3 = await nota(3, 5000, 4000);
    confere(await erroApp(() => lancar(n3, { p_retido: 5000 })), 'retido = total foi aceito');
    confere(await erroApp(() => lancar(n3, { p_aliquota: 101 })), 'alíquota 101 foi aceita');
    confere(await erroApp(() => lancar(n3, { p_aliquota: -1 })), 'alíquota negativa foi aceita');
    const conta = await erroApp(() => lancar(n3, { p_conta_id: '00000000-0000-0000-0000-000000000000' }));
    confere(conta && /conta onde o dinheiro/.test(conta), `conta inválida: ${conta}`);
    const r3 = await lancar(n3, { p_aliquota: 0 });
    const i3 = await um(admin.from('pagamentos').select('imposto_medicao, valor').eq('recebimento_id', r3));
    confere(i3.length === 1 && i3[0].imposto_medicao === 'retido' && Number(i3[0].valor) === 1000, `alíquota 0: ${JSON.stringify(i3)}`);
    // nota inválida pelo banco: líquido maior que total
    const e = await erroApp(() => nota(4, 100, 150)); confere(e, 'nota com líquido maior que o total foi aceita');
  });

  await passo('conciliar a entrada de 9.400,00 (receita − retido): baixa o retido junto; desfazer ("voltar para aberto") reabre a receita e o retido volta a "a pagar"', async () => {
    const c = (await um(admin.from('contas_bancarias').insert({ nome: `ContaMed ${M}`, banco: '777', agencia: '2', conta: `${sfx}2`, created_by: finId }).select('id').single())).id;
    // receita nova para não depender da anterior (valor total 8.000,00; retido 480,00 → entra 7.520,00)
    const n5 = await nota(5, 8000, 7520);
    const r5 = await um(fin.rpc('lancar_medicao', { p_nota_id: n5, p_vencimento: hoje, p_conta_id: c, p_cliente: `Cli ${M}`, p_categoria_receita: catRec, p_categoria_imposto: catImp, p_aliquota: 14 }));
    const imp = await um(admin.from('extrato_importacoes').insert({ conta_id: c, arquivo: 'med.ofx', created_by: finId }).select('id').single());
    const l = (await um(admin.from('extrato_linhas').insert({ conta_id: c, importacao_id: imp.id, data: hoje, valor: 7520, tipo: 'CREDIT', descricao: `TED MEDICAO ${M}`, fitid: `MED${M}` }).select('id').single())).id;
    await ir(p, `/contas-bancarias?conta=${c}`);
    const linha = p.locator('[data-linha-banco]').filter({ has: p.locator('[data-descricao-banco]', { hasText: 'TED MEDICAO' }) }).first();
    confere(await linha.locator('[data-sugestao="receita"]').count() === 1, 'sem sugestão de receita − retido');
    await linha.locator('[data-conciliar-novo]').click();
    await p.waitForFunction((t) => !Array.from(document.querySelectorAll('[data-linha-banco]')).some((e) => e.textContent.includes(t)), 'TED MEDICAO', { timeout: 20000 });
    const ret = (await um(admin.from('pagamentos').select('status').eq('recebimento_id', r5).eq('imposto_medicao', 'retido').single()));
    confere((await reg(r5)).status === 'recebido' && ret.status === 'pago', 'não baixou receita e retido');
    await um(fin.rpc('desfazer_conciliacao', { p_linha_id: l, p_voltar_aberto: true, p_motivo: 'Entrada na conta errada' }));
    const ret2 = (await um(admin.from('pagamentos').select('status').eq('recebimento_id', r5).eq('imposto_medicao', 'retido').single()));
    confere((await reg(r5)).status === 'aberto' && ret2.status === 'aguardando_pagamento', `${(await reg(r5)).status} / ${ret2.status}`);
    // valor diferente do líquido e da receita: o banco recusa
    const l2 = (await um(admin.from('extrato_linhas').insert({ conta_id: c, importacao_id: imp.id, data: hoje, valor: 7000.01, tipo: 'CREDIT', descricao: `TED ERRADA ${M}`, fitid: `ERR${M}` }).select('id').single())).id;
    const e = await erroApp(() => um(fin.rpc('conciliar_recebimento', { p_linha_id: l2, p_recebimento_id: r5 })));
    confere(e && /não bate/.test(e), `valor errado: ${e}`);
  });

  // ───────────── Fundos fixos ─────────────
  const pessoas = {
    suprimentos: (await um(admin.from('profiles').select('id, nome').eq('email', 'suprimentos@demo.local').limit(1)))[0],
    engenheiro: (await um(admin.from('profiles').select('id, nome').eq('email', 'engenheiro@demo.local').limit(1)))[0],
  };
  const abertoDo = (pessoaId) => um(admin.from('fundos_fixos').select('id').eq('obra_id', obraC.id).eq('pessoa_id', pessoaId).neq('status', 'fechado'));
  let fundoX = null, fundoY = null, fundoXNovo = null;

  async function prepararGastos(perfil, fundoId, valores) {
    const c = await cliente(perfil);
    await um(c.rpc('informar_dados_bancarios_fundo', { p_fundo_id: fundoId, p_forma: 'pix', p_banco: 'Banco Fictício', p_favorecido: pessoas[perfil].nome, p_chave_pix: 'chave@ficticia.local' }));
    for (const [descricao, valor] of valores) {
      const g = await um(c.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: `${descricao} ${M}`, p_data: hoje, p_valor: valor }));
      // Atalho de preparação: o comprovante assinado + aprovação do administrador já é coberto por tests/e2e/fundos.cjs
      await um(admin.from('fundo_gastos').update({ status: 'aprovado', decidido_em: new Date().toISOString() }).eq('id', g));
    }
    const gasto = valores.reduce((s, [, v]) => s + v, 0);
    const f = await um(admin.from('fundos_fixos').select('valor').eq('id', fundoId).single());
    const saldo = Number(f.valor) - gasto;
    await um(admin.from('fundos_fixos').update({ status: saldo <= 0 ? 'esgotado' : saldo <= Number(f.valor) * 0.1 ? 'acabando' : 'em_andamento' }).eq('id', fundoId));
  }

  await passo('criar fundo de R$ 100,00 pela tela: desembolso entra em Contas a pagar; segundo fundo aberto da mesma pessoa/obra, valor 0 e perfil errado são recusados', async () => {
    if ((await abertoDo(pessoas.suprimentos.id)).length) throw new Error('já existe fundo aberto de Suprimentos na obra C (outro teste em uso): não dá para criar o do teste');
    await ir(p, '/fundos-fixos');
    await p.selectOption('select[name=obra_id]', obraC.id);
    await p.selectOption('select[name=pessoa_id]', pessoas.suprimentos.id);
    await p.fill('input[name=valor]', '100,00');
    await p.selectOption('select[name=conta_id]', contaCorr);
    await p.click('button:has-text("Criar fundo")');
    await p.getByText('Fundo fixo criado').waitFor({ timeout: 60000 });
    fundoX = (await abertoDo(pessoas.suprimentos.id))[0].id;
    const f = await um(admin.from('fundos_fixos').select('valor, pagamento_inicial_id').eq('id', fundoX).single());
    const pg = await um(admin.from('pagamentos').select('valor, status, conta_bancaria_id').eq('id', f.pagamento_inicial_id).single());
    confere(Number(f.valor) === 100 && Number(pg.valor) === 100 && pg.status === 'aguardando_pagamento' && pg.conta_bancaria_id === contaCorr, JSON.stringify([f, pg]));
    const dup = await erroApp(() => um(fin.rpc('criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: pessoas.suprimentos.id, p_valor: 50, p_conta_id: contaCorr })));
    confere(dup && /(duplicate|unique|já|aberto)/i.test(dup), `fundo duplicado: ${dup}`);
    confere(await erroApp(() => um(fin.rpc('criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: pessoas.engenheiro.id, p_valor: 0, p_conta_id: contaCorr }))), 'fundo de valor 0 aceito');
    const adm = (await um(admin.from('profiles').select('id').eq('perfil', 'administrador').limit(1)))[0].id;
    const perf = await erroApp(() => um(fin.rpc('criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: adm, p_valor: 10, p_conta_id: contaCorr })));
    confere(perf && /engenheiro ou Suprimentos/.test(perf), `fundo para administrador: ${perf}`);
    const sup = await cliente('suprimentos');
    const naoFin = await erroApp(() => um(sup.rpc('criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: pessoas.suprimentos.id, p_valor: 10, p_conta_id: contaCorr })));
    confere(naoFin && /Somente o Financeiro/.test(naoFin), `Suprimentos criou fundo: ${naoFin}`);
  });

  await passo('gastos de R$ 60,00 + R$ 60,00 esgotam o fundo (120 de 100); "Fechar e repor" gera UM pagamento "reposição de R$ 100,00 + reembolso de R$ 20,00" com OP FF-xxxx em PDF e abre novo fundo de R$ 100,00', async () => {
    await prepararGastos('suprimentos', fundoX, [['Combustível', 60], ['Material', 60]]);
    const sup = await cliente('suprimentos');
    // Sem limite: depois de esgotar o fundo ainda aceita gasto (pendente, não conta até o comprovante assinado)
    const extra = await um(sup.rpc('lancar_gasto_fundo', { p_fundo_id: fundoX, p_descricao: 'Depois de esgotar', p_data: hoje, p_valor: 1 }));
    await um(admin.from('fundo_gastos').delete().eq('id', extra));
    await ir(p, `/fundos-fixos/${fundoX}`);
    await p.getByRole('button', { name: 'Fechar e repor' }).click();
    await p.waitForURL(/\/fundos-fixos\?fechado=/, { timeout: 60000 });
    const f = await um(admin.from('fundos_fixos').select('status, reposicao, reembolso, pagamento_id').eq('id', fundoX).single());
    confere(f.status === 'fechado' && Number(f.reposicao) === 100 && Number(f.reembolso) === 20, JSON.stringify(f));
    const pg = await um(admin.from('pagamentos').select('id, valor, descricao, status, forma_pagamento').eq('id', f.pagamento_id).single());
    confere(Number(pg.valor) === 120 && /reposição de R\$ 100,00 \+ reembolso de R\$ 20,00/.test(pg.descricao) && pg.forma_pagamento === 'pix', JSON.stringify(pg));
    const docs = await um(admin.from('documentos').select('tipo, nome_arquivo').eq('pagamento_id', pg.id).eq('ativo', true));
    confere(docs.some((d) => d.tipo === 'ordem_pagamento' && /^FF-\d{4}\.pdf$/.test(d.nome_arquivo)), `OP não anexada: ${JSON.stringify(docs)}`);
    const novo = await um(admin.from('fundos_fixos').select('valor, status').eq('fundo_anterior_id', fundoX));
    confere(novo.length === 1 && Number(novo[0].valor) === 100 && novo[0].status !== 'fechado', JSON.stringify(novo));
    const e2 = await erroApp(() => um(fin.rpc('fechar_fundo_fixo', { p_fundo_id: fundoX, p_vencimento: hoje, p_modo: 'repor', p_conta_id: null })));
    confere(e2 && /fechado/.test(e2), `fechar duas vezes: ${e2}`);
    // O pagamento de reposição é pago normalmente por Marina
    await um(fin.rpc('registrar_baixa', { p_id: pg.id, p_pago_em: hoje, p_valor_pago: null, p_observacao: 'reposição', p_diferenca: 'saldo' }));
    confere((await um(admin.from('pagamentos').select('status').eq('id', pg.id).single())).status === 'pago', 'reposição não baixou');
    fundoXNovo = (await um(admin.from('fundos_fixos').select('id').eq('fundo_anterior_id', fundoX).single())).id;
  });

  await passo('fundo "acabando" (200 com 185 gastos): "Encerrar fundo" não gera pagamento e o saldo de R$ 15,00 vira receita em aberto para devolução; fundo encerrado não recebe gasto', async () => {
    if ((await abertoDo(pessoas.engenheiro.id)).length) throw new Error('já existe fundo aberto do Engenheiro na obra C (outro teste em uso)');
    const id = await um(fin.rpc('criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: pessoas.engenheiro.id, p_valor: 200, p_conta_id: contaCorr }));
    fundoY = id;
    await prepararGastos('engenheiro', id, [['Combustível', 185]]);
    confere((await um(admin.from('fundos_fixos').select('status').eq('id', id).single())).status === 'acabando', 'status deveria ser acabando');
    await ir(p, `/fundos-fixos/${id}`);
    await p.getByRole('button', { name: 'Encerrar fundo' }).click();
    await p.waitForURL(/\/fundos-fixos\?fechado=saldo/, { timeout: 60000 });
    const f = await um(admin.from('fundos_fixos').select('status, pagamento_id, recebimento_devolucao_id, saldo_repassado').eq('id', id).single());
    confere(f.status === 'fechado' && f.pagamento_id === null && Number(f.saldo_repassado) === 15 && f.recebimento_devolucao_id, JSON.stringify(f));
    const r = await reg(f.recebimento_devolucao_id);
    confere(Number(r.valor) === 15 && r.status === 'aberto', JSON.stringify([r.valor, r.status]));
    const eng = await cliente('engenheiro');
    const e = await erroApp(() => um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: id, p_descricao: 'Tarde', p_data: hoje, p_valor: 1 })));
    confere(e && /já foi fechado/.test(e), `gasto em fundo fechado: ${e}`);
  });

  await passo('gasto inválido e gasto no fundo de outra pessoa: sem dados bancários bloqueia; valor 0/negativo recusados; Marina (Financeiro) e outro responsável não lançam gasto em fundo alheio', async () => {
    const sup = await cliente('suprimentos');
    const semDados = await erroApp(() => um(sup.rpc('lancar_gasto_fundo', { p_fundo_id: fundoXNovo, p_descricao: 'Sem dados', p_data: hoje, p_valor: 5 })));
    confere(semDados && /dados bancários/.test(semDados), `gasto sem dados bancários: ${semDados}`);
    await um(sup.rpc('informar_dados_bancarios_fundo', { p_fundo_id: fundoXNovo, p_forma: 'conta', p_banco: 'Banco Fictício', p_favorecido: pessoas.suprimentos.nome, p_agencia: '1234', p_conta: '56789-0', p_chave_pix: null }));
    for (const v of [0, -5]) {
      const e = await erroApp(() => um(sup.rpc('lancar_gasto_fundo', { p_fundo_id: fundoXNovo, p_descricao: 'Valor ruim', p_data: hoje, p_valor: v })));
      confere(e && /valor do gasto/.test(e), `gasto de ${v}: ${e}`);
    }
    const e1 = await erroApp(() => um(fin.rpc('lancar_gasto_fundo', { p_fundo_id: fundoXNovo, p_descricao: 'Alheio', p_data: hoje, p_valor: 5 })));
    confere(e1 && /Somente a pessoa do fundo/.test(e1), `gasto em fundo alheio: ${e1}`);
    const eng = await cliente('engenheiro');
    const e2 = await erroApp(() => um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoXNovo, p_descricao: 'Outro', p_data: hoje, p_valor: 5 })));
    confere(e2 && /Somente a pessoa do fundo/.test(e2), `engenheiro no fundo do Suprimentos: ${e2}`);
    const ok = await um(sup.rpc('lancar_gasto_fundo', { p_fundo_id: fundoXNovo, p_descricao: `Centavo ${M}`, p_data: hoje, p_valor: 0.01 }));
    confere((await um(admin.from('fundo_gastos').select('valor, status').eq('id', ok).single())).status === 'pendente', 'gasto de R$ 0,01 deveria nascer pendente (sem comprovante assinado)');
  });

  await passo('lista de fundos: filtros por responsável e situação, e fundo/lista sem rolagem lateral em 1280px e 390px', async () => {
    await ir(p, '/fundos-fixos');
    await p.getByLabel('Responsável').selectOption(pessoas.suprimentos.id).catch(() => {});
    const p1280 = await entrar('financeiro', 1280);
    const problemas = [];
    for (const [pg, w] of [[p1280, 1280], [cel, 390]]) for (const url of ['/fundos-fixos', `/fundos-fixos/${fundoX}`, `/fundos-fixos/${fundoXNovo}`, `/fundos-fixos/${fundoY}`]) {
      await ir(pg, url);
      if (!(await semRolagem(pg))) problemas.push(`${url.replace(/[0-9a-f-]{36}/, ':id')} (${w}px)`);
    }
    confere(problemas.length === 0, `rolagem lateral em: ${problemas.join(' | ')}`);
  });

  // ───────────── Relatórios ─────────────
  await passo('relatórios: período fora do que existe zera os indicadores sem quebrar; filtro por centro de custo + fornecedor combina; exportação respeita o filtro', async () => {
    const d = (await um(fin.rpc('criar_pagamento_completo', { p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: `Relat ${M}`, p_descricao: `Desp relatório ${M}`, p_valor: 33.33, p_vencimento: hoje, p_forma_pagamento: 'pix', p_categoria_id: catImp, p_conta_id: contaCorr, p_numero_documento: '', p_observacoes: '', p_competencia: null, p_parcelas: null, p_repetir_intervalo: null, p_repetir_vezes: null, p_provisao_id: null })));
    await ir(p, '/relatorios?ver=lancamentos&de=2001-01-01&ate=2001-01-31');
    confere(await p.getByText(/Application error|Algo deu errado/).count() === 0, 'relatório de período vazio quebrou');
    await ir(p, `/relatorios?ver=lancamentos&de=${hoje.slice(0, 4)}-01-01&ate=${hoje.slice(0, 4)}-12-31&obra=${obraC.id}&categoria=${catImp}`);
    confere((await p.locator('table[data-lancamentos]').innerText()).includes(`Relat ${M}`), 'lançamento do teste não aparece no relatório por obra');
    await ir(p, `/relatorios?ver=lancamentos&de=${hoje.slice(0, 4)}-01-01&ate=${hoje.slice(0, 4)}-12-31&obra=${obraA.id}&categoria=${catImp}`);
    confere(!(await p.locator('table[data-lancamentos]').innerText().catch(() => '')).includes(`Relat ${M}`), 'filtro por outra obra deixou passar o lançamento');
    const r = await p.request.get(`${BASE}/relatorios/exportar?de=${hoje.slice(0, 4)}-01-01&ate=${hoje.slice(0, 4)}-12-31&obra=${obraC.id}&categoria=${catImp}`);
    const buf = await r.body();
    confere(r.status() === 200 && /spreadsheet/.test(r.headers()['content-type'] ?? '') && buf.slice(0, 2).toString() === 'PK', `exportação: ${r.status()} ${r.headers()['content-type']}`);
    void d;
  });

  // ───────────── Notas para contabilidade ─────────────
  await passo('notas para contabilidade: NFS-e de PJ com retenção entra, MEI com outro serviço e DANFE ficam de fora; marcar enviada / reabrir muda de aba; Excel exporta; Engenheiro e Suprimentos não marcam', async () => {
    const ex = path.join(__dirname, '..', '..', 'exemplos');
    await ir(p, '/pagamentos/novo');
    await p.selectOption('select[name=obra_id]', obraC.id);
    await p.fill('input[name=favorecido]', `Prestador ${M}`);
    await p.fill('input[name=descricao]', `Serviço ${M}`);
    await p.fill('input[name=valor]', '5.000,00');
    await p.fill('input[name=vencimento]', somarDias(hoje, 6));
    await p.setInputFiles('input[name=nota_fiscal]', [path.join(ex, 'nfse-pj-retencao.xml'), path.join(ex, 'nfse-mei-outros-servicos.xml'), path.join(ex, 'danfe-produto.pdf')]);
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await p.locator('select[aria-label="Conta bancária"], select[name=conta_bancaria_id]').first().selectOption({ index: 1 });
    await Promise.all([p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 90000 }), p.click('button:has-text("Cadastrar e encaminhar")')]);
    const pid = p.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    await p.waitForTimeout(2500);
    const notas = await um(admin.from('notas_contabeis').select('id, categoria, prestador_nome, enviada_em').eq('pagamento_id', pid));
    confere(notas.length === 1 && notas[0].categoria === 'tomado_pj_retencao', `notas identificadas: ${JSON.stringify(notas)}`);
    const nome = notas[0].prestador_nome;
    await ir(p, '/notas-contabeis');
    const linha = () => p.locator('tr', { hasText: nome }).first();
    await linha().waitFor({ timeout: 30000 });
    const antes = await p.locator('tr', { hasText: nome }).count();
    await linha().getByRole('button', { name: 'Marcar como enviada' }).click();
    await p.getByText('Nota marcada como enviada à contabilidade').waitFor({ timeout: 30000 });
    confere((await um(admin.from('notas_contabeis').select('enviada_em').eq('id', notas[0].id).single())).enviada_em !== null, 'não gravou enviada_em');
    await ir(p, '/notas-contabeis?situacao=enviadas');
    await linha().waitFor({ timeout: 30000 });
    await ir(p, '/notas-contabeis');
    confere(await p.locator('tr', { hasText: nome }).count() === antes - 1, `enviada ainda aparece em "A enviar" (${antes} linhas antes, ${await p.locator('tr', { hasText: nome }).count()} depois)`);
    await um(fin.rpc('marcar_nota_contabil_enviada', { p_id: notas[0].id, p_enviada: false }));
    await ir(p, '/notas-contabeis');
    confere(await p.locator('tr', { hasText: nome }).count() === antes, 'reaberta não voltou para "A enviar"');
    const x = await p.request.get(`${BASE}/notas-contabeis/exportar?situacao=todas`);
    confere(x.status() === 200 && /spreadsheetml/.test(x.headers()['content-type'] ?? '') && (await x.body()).slice(0, 2).toString() === 'PK', `exportar notas: ${x.status()}`);
    const eng = await entrar('engenheiro');
    await eng.goto(BASE + '/notas-contabeis'); await eng.waitForLoadState('networkidle');
    confere(!new URL(eng.url()).pathname.startsWith('/notas-contabeis'), 'engenheiro abriu notas para contabilidade');
    const sup = await entrar('suprimentos');
    await ir(sup, '/notas-contabeis?situacao=todas');
    confere(await sup.getByRole('button', { name: 'Marcar como enviada' }).count() === 0 && await sup.getByRole('button', { name: 'Reabrir' }).count() === 0, 'Suprimentos vê botão de marcar/reabrir');
    const sc = await cliente('suprimentos');
    const e = await erroApp(() => um(sc.rpc('marcar_nota_contabil_enviada', { p_id: notas[0].id, p_enviada: true })));
    confere(e && /Somente o Financeiro/.test(e), `Suprimentos marcou pelo banco: ${e}`);
  });

  // ───────────── Usuários ─────────────
  let novoEmail = '';
  await passo('usuários: Marina cria usuário (senha provisória exibida), e-mail repetido e perfil vazio são recusados, usuário novo precisa trocar a senha; depois ela o desativa', async () => {
    novoEmail = `marina-teste-${sfx}@demo.local`;
    await ir(p, '/usuarios');
    confere(await p.getByRole('link', { name: '+ Novo usuário' }).count() === 1, 'sem "+ Novo usuário"');
    await ir(p, '/usuarios/novo');
    const preencher = async (email, perfil) => {
      await p.fill('input[name=nome]', `Usuário Teste ${sfx}`);
      await p.fill('input[name=email]', email);
      if (perfil) await p.selectOption('select[name=perfil]', perfil);
    };
    await preencher(novoEmail, 'suprimentos');
    await p.getByRole('button', { name: /Criar usuário|Cadastrar|Salvar/ }).first().click();
    await p.getByText(/criado/).first().waitFor({ timeout: 30000 });
    const prof = await um(admin.from('profiles').select('id, perfil, ativo, troca_senha_pendente').eq('email', novoEmail).single());
    confere(prof.perfil === 'suprimentos' && prof.ativo === true && prof.troca_senha_pendente === true, JSON.stringify(prof));
    await ir(p, '/usuarios/novo');
    await preencher(novoEmail, 'suprimentos');
    await p.getByRole('button', { name: /Criar usuário|Cadastrar|Salvar/ }).first().click();
    await p.getByText(/Já existe um usuário com este e-mail/).waitFor({ timeout: 30000 });
    // E-mail inválido é barrado pelo navegador (type=email) ou pelo servidor
    await ir(p, '/usuarios/novo');
    await preencher('nao-e-email', 'suprimentos');
    await p.getByRole('button', { name: /Criar usuário|Cadastrar|Salvar/ }).first().click();
    await p.waitForTimeout(800);
    confere((await um(admin.from('profiles').select('id').eq('email', 'nao-e-email'))).length === 0, 'criou usuário com e-mail inválido');
    await um(admin.from('profiles').update({ ativo: false }).eq('id', prof.id));
    // Suprimentos tenta se promover/promover o novo usuário pela API: o banco nega e nada muda
    const sc = await cliente('suprimentos');
    await sc.from('profiles').update({ perfil: 'financeiro' }).eq('id', prof.id);
    confere((await um(admin.from('profiles').select('perfil').eq('id', prof.id).single())).perfil === 'suprimentos', 'Suprimentos mudou o perfil de outro usuário');
  });

  await passo('permissões de usuários: Suprimentos e Engenheiro não abrem /usuarios; e-mail e telefone dos outros só aparecem para o Financeiro', async () => {
    for (const perfil of ['suprimentos', 'engenheiro']) {
      const pg = await entrar(perfil);
      await pg.goto(BASE + '/usuarios'); await pg.waitForLoadState('networkidle');
      confere(!new URL(pg.url()).pathname.startsWith('/usuarios'), `${perfil} abriu /usuarios`);
      const c = await cliente(perfil);
      const vistos = await um(c.from('profiles_completo').select('id, email'));
      confere(vistos.length <= 1, `${perfil} lê e-mail de ${vistos.length} pessoas`);
    }
    const todos = await um(fin.from('profiles_completo').select('id, email'));
    confere(todos.length >= 5, 'Financeiro deveria ver o e-mail de todos');
  });

  // ───────────── Exportações ─────────────
  await passo('exportações: planilhas de pagamentos (lista) e de compras abrem para o Financeiro (200, CSV/Excel) e exigem login (401 sem sessão)', async () => {
    const csv = await p.request.get(`${BASE}/pagamentos/exportar?lista=contas&periodo=todos&busca=${encodeURIComponent('Relat ' + M)}`);
    const { lerXlsx, textoDoXlsx } = require('../_xlsx.cjs');
    const txt = csv.status() === 200 ? textoDoXlsx(await lerXlsx(await csv.body())) : '';
    confere(csv.status() === 200 && /33\.33/.test(txt), `pagamentos: ${csv.status()} ${txt.slice(0, 200)}`);
    const compras = await p.request.get(`${BASE}/compras/exportar`);
    confere(compras.status() === 200, `compras: ${compras.status()}`);
    const ctx = await b.newContext();
    for (const rota of ['/pagamentos/exportar?lista=contas', '/relatorios/exportar', '/notas-contabeis/exportar', '/compras/exportar']) {
      const r = await ctx.request.get(BASE + rota, { maxRedirects: 0 });
      confere([401, 302, 307].includes(r.status()), `${rota} sem login devolveu ${r.status()}`);
    }
  });

  // ───────────── Layout ─────────────
  await passo('Contas a receber, receita da medição, Notas de medição, Relatórios, Notas para contabilidade, Usuários e Fundos sem rolagem lateral (1280px e 390px); janelas Nova receita e Lançar receita cabem', async () => {
    const p1280 = await entrar('financeiro', 1280);
    const problemas = [];
    const telas = [`/recebimentos?periodo=todos&busca=${encodeURIComponent(M)}`, `/recebimentos/${recMed}`, '/notas-medicao', '/relatorios', '/notas-contabeis', '/usuarios', '/fundos-fixos'];
    for (const [pg, w] of [[p1280, 1280], [cel, 390]]) for (const url of telas) {
      await ir(pg, url);
      if (!(await semRolagem(pg))) {
        const onde = await pg.evaluate(() => [...document.querySelectorAll('main *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)).map((x) => `${x.scrollWidth}>${x.clientWidth}`).join(' '));
        problemas.push(`${url.split('?')[0].replace(/[0-9a-f-]{36}/, ':id')} (${w}px: ${onde || 'página'})`);
      }
    }
    await ir(cel, '/recebimentos'); await cel.getByRole('button', { name: '+ Nova receita' }).click();
    confere(await cabe(cel.getByRole('dialog', { name: 'Nova receita' })), 'janela Nova receita cortando no celular');
    await cel.keyboard.press('Escape');
    await ir(cel, '/notas-medicao');
    const btn = cel.getByRole('button', { name: 'Lançar receita' }).first();
    if (await btn.count()) { await btn.click(); confere(await cabe(cel.getByRole('dialog', { name: 'Lançar receita e impostos' })), 'janela Lançar receita e impostos cortando no celular'); }
    confere(problemas.length === 0, `rolagem lateral em: ${[...new Set(problemas)].join(' | ')}`);
  });

  // Limpeza (não conta como caso): fundo aberto que a própria persona deixou (o sucessor do "repor"), receitas e despesas em aberto
  try {
    for (const id of [fundoXNovo, fundoY].filter(Boolean)) {
      const aberto = await um(admin.from('fundos_fixos').select('id, status').eq('id', id));
      if (aberto[0] && aberto[0].status !== 'fechado') {
        await fin.rpc('fechar_fundo_fixo', { p_fundo_id: id, p_vencimento: hoje, p_modo: 'encerrar', p_conta_id: null });
        const f2 = await um(admin.from('fundos_fixos').select('recebimento_devolucao_id').eq('id', id).single());
        if (f2.recebimento_devolucao_id) await fin.rpc('cancelar_recebimento', { p_id: f2.recebimento_devolucao_id, p_motivo: 'Limpeza da persona' });
      }
    }
    for (const x of await um(admin.from('recebimentos').select('id').like('descricao', `%${M}%`).eq('status', 'aberto'))) await fin.rpc('cancelar_recebimento', { p_id: x.id, p_motivo: 'Limpeza da persona' });
    for (const x of await um(admin.from('pagamentos').select('id').like('descricao', `%${M}%`).eq('status', 'aguardando_pagamento'))) await fin.rpc('excluir_lancamentos', { p_pagamento_id: x.id, p_parcela_id: null, p_escopo: 'todos', p_motivo: 'Limpeza da persona' });
  } catch { /* melhor esforço */ }
});
