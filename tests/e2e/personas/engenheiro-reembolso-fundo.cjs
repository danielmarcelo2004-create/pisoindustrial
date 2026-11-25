// Persona Carlos (engenheiro): o fundo fixo estoura o valor e ele precisa ser reembolsado.
// Fundo de R$ 1.000,00; gastos de R$ 600,00 e R$ 670,00 (sem limite: pode passar do valor e seguir lançando);
// solicita o fechamento; o Financeiro fecha e repõe (pagamento de R$ 1.270,00 = reposição 1.000 + reembolso 270) e o novo fundo abre.
// Também cobre o "Encerrar fundo" com gasto acima do valor (só reembolso, sem devolução). Dados fictícios.
const { admin, um, hoje, marca, confere, cliente, rodar, ir } = require('./_util.cjs');

rodar('Persona Carlos — fundo estourado e reembolso', async ({ passo, entrar }) => {
  const M = marca('Reemb');
  const sfx = String(Date.now()).slice(-7);
  const erroApp = (fn) => fn().then(() => null, (e) => e.message);
  const obraC = (await um(admin.from('obras').select('id').eq('fluxo', 'C').limit(1)))[0];
  const finId = (await (await cliente('financeiro')).auth.getUser()).data.user.id;
  const fin = await cliente('financeiro');
  const eng = await cliente('engenheiro');
  const carlos = (await um(admin.from('profiles').select('id, nome').eq('email', 'engenheiro@demo.local').single()));
  const conta = (await um(admin.from('contas_bancarias').insert({ nome: `Conta ${M}`, banco: '777', agencia: '1', conta: `${sfx}2`, created_by: finId }).select('id').single())).id;
  // Fundos antigos e abertos do Carlos na obra: fecha para o teste ser repetível
  for (const f of await um(admin.from('fundos_fixos').select('id').eq('obra_id', obraC.id).eq('pessoa_id', carlos.id).neq('status', 'fechado'))) {
    await um(fin.rpc('fechar_fundo_fixo', { p_fundo_id: f.id, p_vencimento: hoje, p_modo: 'encerrar', p_conta_id: null }));
  }
  const lancar = async (fundo, desc, valor) => {
    const g = await um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundo, p_descricao: `${desc} ${M}`, p_data: hoje, p_valor: valor }));
    // Atalho: comprovante assinado + aprovação do administrador são cobertos por tests/e2e/fundos.cjs
    await um(admin.from('fundo_gastos').update({ status: 'aprovado', decidido_em: new Date().toISOString() }).eq('id', g));
    return g;
  };
  let fundo = null, novoFundo = null;

  const fundoId = await um(fin.rpc('criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: carlos.id, p_valor: 1000, p_conta_id: conta }));
  fundo = fundoId;
  await um(eng.rpc('informar_dados_bancarios_fundo', { p_fundo_id: fundo, p_forma: 'pix', p_banco: 'Banco Fictício', p_favorecido: carlos.nome, p_chave_pix: 'carlos@ficticio.local' }));

  const p = await entrar('engenheiro');
  const pf = await entrar('financeiro');
  pf.on('dialog', (d) => d.accept());

  await passo('R$ 600,00 + R$ 670,00: o último gasto passa do valor do fundo (1.270 de 1.000) e é aceito; o fundo fica esgotado', async () => {
    await lancar(fundo, 'Combustível', 600);
    await lancar(fundo, 'Material', 670);
    await um(admin.from('fundos_fixos').update({ status: 'esgotado' }).eq('id', fundo));
    const s = await um(admin.from('fundo_gastos').select('valor').eq('fundo_id', fundo));
    confere(s.reduce((t, g) => t + Number(g.valor), 0) === 1270, 'gastos não somam 1.270');
  });

  await passo('depois de passar do valor: o engenheiro continua lançando gastos (API e tela) — sem limite — e a tela oferece "Solicitar fechamento do fundo"', async () => {
    const extra = await um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundo, p_descricao: `Mais um ${M}`, p_data: hoje, p_valor: 10 }));
    await um(admin.from('fundo_gastos').delete().eq('id', extra));
    await ir(p, `/fundos-fixos/${fundo}`);
    // O formulário depende da assinatura cadastrada (o Carlos de teste não tem); o que não pode existir é o bloqueio por saldo
    const bloqueado = await p.getByText(/Fundo esgotado|Não dá para lançar novos gastos/).count();
    confere(bloqueado === 0, 'a tela ainda bloqueia gastos por saldo esgotado');
    confere(await p.locator('input[name=valor], [data-sem-assinatura]').count() >= 1, 'nem formulário de gasto nem aviso de assinatura');
    confere(await p.getByRole('button', { name: 'Solicitar fechamento do fundo' }).count() === 1, 'sem o botão de solicitar fechamento');
  });

  await passo('Carlos solicita o fechamento: Financeiro avisado (sino), aviso na lista e contador no menu "Fundos fixos"; não dá para solicitar duas vezes e ele não fecha sozinho', async () => {
    p.on('dialog', (d) => d.accept());
    await p.getByRole('button', { name: 'Solicitar fechamento do fundo' }).click();
    await p.locator('[data-fechamento-solicitado]').waitFor({ timeout: 20000 });
    const av = await um(admin.from('notificacoes').select('titulo, link').eq('user_id', finId).eq('titulo', 'Fechamento de fundo fixo solicitado').order('created_at', { ascending: false }).limit(1));
    confere(av.length === 1 && av[0].link === `/fundos-fixos/${fundo}`, 'Financeiro não foi avisado');
    const dup = await erroApp(() => um(eng.rpc('solicitar_fechamento_fundo', { p_fundo_id: fundo })));
    confere(dup && /já foi solicitado/.test(dup), `pedido duplicado: ${dup}`);
    const sozinho = await erroApp(() => um(eng.rpc('fechar_fundo_fixo', { p_fundo_id: fundo, p_vencimento: hoje, p_modo: 'repor', p_conta_id: null })));
    confere(sozinho && /Financeiro/.test(sozinho), `engenheiro fechou o próprio fundo: ${sozinho}`);
    await ir(pf, '/fundos-fixos');
    await pf.locator('[data-fechamentos-solicitados]').waitFor({ timeout: 15000 });
    const contador = await pf.locator('nav a[href="/fundos-fixos"] span.rounded-full').first().innerText();
    confere(Number(contador) >= 1, `contador do menu: "${contador}"`);
    await ir(pf, `/fundos-fixos/${fundo}`);
    await pf.getByText(/solicitou o fechamento deste fundo em/).first().waitFor({ timeout: 15000 });
  });

  await passo('Financeiro "Fechar e repor": UM pagamento de R$ 1.270,00 (reposição 1.000 + reembolso 270) em PIX com os dados bancários do Carlos e OP FF-xxxx em PDF', async () => {
    await pf.getByRole('button', { name: 'Fechar e repor' }).click();
    await pf.waitForURL(/\/fundos-fixos\?fechado=/, { timeout: 60000 });
    const f = await um(admin.from('fundos_fixos').select('status, reposicao, reembolso, pagamento_id').eq('id', fundo).single());
    confere(f.status === 'fechado' && Number(f.reposicao) === 1000 && Number(f.reembolso) === 270, JSON.stringify(f));
    const pg = await um(admin.from('pagamentos').select('id, valor, descricao, forma_pagamento, favorecido, observacoes, status').eq('id', f.pagamento_id).single());
    confere(Number(pg.valor) === 1270 && pg.forma_pagamento === 'pix' && /reposição de R\$ 1\.000,00 \+ reembolso de R\$ 270,00/.test(pg.descricao), JSON.stringify(pg));
    confere(pg.favorecido === carlos.nome && /carlos@ficticio\.local/.test(pg.observacoes), `dados bancários do Carlos fora do pagamento: ${pg.favorecido} / ${pg.observacoes}`);
    const docs = await um(admin.from('documentos').select('tipo, nome_arquivo').eq('pagamento_id', pg.id).eq('ativo', true));
    confere(docs.some((d) => d.tipo === 'ordem_pagamento' && /^FF-\d{4}\.pdf$/.test(d.nome_arquivo)), `OP não anexada: ${JSON.stringify(docs)}`);
    await um(fin.rpc('registrar_baixa', { p_id: pg.id, p_pago_em: hoje, p_valor_pago: null, p_observacao: 'reembolso do fundo', p_diferenca: 'saldo' }));
    confere((await um(admin.from('pagamentos').select('status').eq('id', pg.id).single())).status === 'pago', 'reembolso não foi pago');
  });

  await passo('o novo fundo de R$ 1.000,00 abre na hora para o Carlos, que volta a lançar gastos; o fundo fechado não aceita gasto nem novo pedido', async () => {
    const novo = await um(admin.from('fundos_fixos').select('id, valor, status').eq('fundo_anterior_id', fundo));
    confere(novo.length === 1 && Number(novo[0].valor) === 1000 && novo[0].status !== 'fechado', JSON.stringify(novo));
    novoFundo = novo[0].id;
    await um(eng.rpc('informar_dados_bancarios_fundo', { p_fundo_id: novoFundo, p_forma: 'pix', p_banco: 'Banco Fictício', p_favorecido: carlos.nome, p_chave_pix: 'carlos@ficticio.local' }));
    await um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: novoFundo, p_descricao: `Volta a lançar ${M}`, p_data: hoje, p_valor: 50 }));
    const antigo = await erroApp(() => um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundo, p_descricao: 'No fechado', p_data: hoje, p_valor: 1 })));
    confere(antigo && /já foi fechado/.test(antigo), `gasto em fundo fechado: ${antigo}`);
    const pedido = await erroApp(() => um(eng.rpc('solicitar_fechamento_fundo', { p_fundo_id: fundo })));
    confere(pedido && /já foi fechado/.test(pedido), `pedido em fundo fechado: ${pedido}`);
    await ir(p, `/fundos-fixos/${novoFundo}`);
    confere(await p.locator('[data-fechamento-solicitado]').count() === 0, 'novo fundo já aparece com fechamento solicitado');
  });

  await passo('"Encerrar fundo" com gasto acima do valor (R$ 300 de R$ 200): paga só o reembolso de R$ 100,00 e não gera devolução de saldo', async () => {
    // O fundo novo do Carlos precisa estar fechado para criar outro
    await um(fin.rpc('fechar_fundo_fixo', { p_fundo_id: novoFundo, p_vencimento: hoje, p_modo: 'encerrar', p_conta_id: null }));
    const id = await um(fin.rpc('criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: carlos.id, p_valor: 200, p_conta_id: conta }));
    await um(eng.rpc('informar_dados_bancarios_fundo', { p_fundo_id: id, p_forma: 'conta', p_banco: 'Banco Fictício', p_favorecido: carlos.nome, p_agencia: '1234', p_conta: '56789-0' }));
    await lancar(id, 'Gasto 1', 150);
    await lancar(id, 'Gasto 2', 150);
    await um(admin.from('fundos_fixos').update({ status: 'esgotado' }).eq('id', id));
    await ir(pf, `/fundos-fixos/${id}`);
    await pf.getByRole('button', { name: 'Encerrar fundo' }).click();
    await pf.waitForURL(/\/fundos-fixos\?fechado=/, { timeout: 60000 });
    const f = await um(admin.from('fundos_fixos').select('status, reposicao, reembolso, pagamento_id, recebimento_devolucao_id, saldo_repassado').eq('id', id).single());
    confere(f.status === 'fechado' && Number(f.reembolso) === 100 && f.recebimento_devolucao_id === null && Number(f.saldo_repassado) === 0, JSON.stringify(f));
    const pg = await um(admin.from('pagamentos').select('valor, forma_pagamento, observacoes').eq('id', f.pagamento_id).single());
    confere(Number(pg.valor) === 100 && pg.forma_pagamento === 'transferencia' && /Agência: 1234/.test(pg.observacoes), JSON.stringify(pg));
    const novo = await um(admin.from('fundos_fixos').select('id').eq('fundo_anterior_id', id));
    confere(novo.length === 0, 'encerrar não deveria abrir novo fundo');
  });
});
