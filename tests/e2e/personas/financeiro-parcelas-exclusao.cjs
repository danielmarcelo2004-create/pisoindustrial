// Persona: Marina, analista do Financeiro (financeiro@demo.local). Sabe as regras e usa Contas a pagar o dia todo.
// Este arquivo: parcelas (que fecham e que não fecham, baixa por parcela, estorno de parcela, editar parcelas),
// repetições/provisões e "Excluir lançamento" nos 4 escopos (parcelada, repetição, paga, pela tela).
// Cartões, busca, filtros, baixas, lote, ações em lote e layout: financeiro-completo.cjs.
// Conciliação/extratos: financeiro-conciliacao.cjs. Receber, medição, fundos, relatórios, notas, usuários: financeiro-receber-fundos.cjs.
// Dados fictícios (marca() isola cada execução). Não altera código da aplicação.
const fs = require('fs');
const path = require('path');
const { DIR, BASE, admin, um, hoje, somarDias, marca, confere, cliente, rodar, ir } = require('./_util.cjs');

const pdf = path.join(DIR, 'marina.pdf');
fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

const brl = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mais = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const semRolagem = (p) => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && ![...document.querySelectorAll('table')].some((t) => t.parentElement.scrollWidth > t.parentElement.clientWidth + 2));
const cabe = (dlg) => dlg.evaluate((el) => { const c = el.firstElementChild || el; const r = c.getBoundingClientRect(); return c.scrollWidth <= c.clientWidth + 1 && r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1 && r.bottom <= innerHeight + 1; });

rodar('Persona Marina — Parcelas, repetições e exclusão', async ({ b, passo, entrar }) => {
  const M = marca('Mpe');
  const obraC = (await um(admin.from('obras').select('id, nome, fluxo').eq('fluxo', 'C').limit(1)))[0];
  const obraA = (await um(admin.from('obras').select('id, nome, fluxo').eq('fluxo', 'A').limit(1)))[0];
  const cats = await um(admin.from('categorias').select('id, nome').eq('tipo', 'despesa').eq('ativo', true).order('nome'));
  const contas = await um(admin.from('contas_bancarias').select('id, nome').eq('ativa', true).order('nome'));
  const conta = contas[0];
  const fin = await cliente('financeiro');
  const finId = (await fin.auth.getUser()).data.user.id;

  /** Cria uma despesa "como Marina" (RPC do banco). Fluxo C = já liberada para pagar. */
  const nova = async ({ fav, valor, venc = hoje, parcelas = null, rep = null, obra = obraC, forma = 'boleto', cat = cats[0], contaId = conta.id }) =>
    um(fin.rpc('criar_pagamento_completo', {
      p_obra_id: obra.id, p_fornecedor_id: null, p_favorecido: `${fav} ${M}`, p_descricao: `Desp ${M}`, p_valor: valor, p_vencimento: venc,
      p_forma_pagamento: forma, p_categoria_id: cat.id, p_conta_id: contaId, p_numero_documento: '', p_observacoes: '', p_competencia: null,
      p_parcelas: parcelas, p_repetir_intervalo: rep ? rep[0] : null, p_repetir_vezes: rep ? rep[1] : null, p_provisao_id: null,
    }));
  const baixar = (id, valor, data = hoje, dif = 'saldo') => um(fin.rpc('registrar_baixa', { p_id: id, p_pago_em: data, p_valor_pago: valor ?? null, p_observacao: 'persona', p_diferenca: dif }));
  const pag = async (id) => (await um(admin.from('pagamentos').select('*').eq('id', id).single()));
  const parcs = async (id) => (await um(admin.from('pagamento_parcelas').select('*').eq('pagamento_id', id).order('numero')));
  const lista = (extra = '') => `/pagamentos?periodo=todos&busca=${encodeURIComponent(M)}${extra}`;
  const linhaDe = (p, chave) => p.locator(`tr[data-linha="${chave}"]`);
  const erroApp = (fn) => fn().then(() => null, (e) => e.message);

  const p = await entrar('financeiro');
  p.on('dialog', (d) => d.accept());
  const cel = await entrar('financeiro', 390);
  cel.on('dialog', (d) => d.accept());

  // ───────────── Parcelas ─────────────
  await passo('parcelas: 100,00 em 3x (33,33 + 33,33 + 33,34) fecham; soma que não fecha é recusada pelo banco', async () => {
    const id = await nova({ fav: 'Parc3', valor: 100, venc: mais(hoje, 0), parcelas: [33.33, 33.33, 33.34].map((x, i) => ({ valor: x, vencimento: mais(hoje, i), multa: 0, juros: 0, desconto: 0, motivo: null })) });
    const ps = await parcs(id);
    confere(ps.length === 3 && Math.round(ps.reduce((s, x) => s + Number(x.valor_base), 0) * 100) === 10000, JSON.stringify(ps.map((x) => x.valor_base)));
    const e = await erroApp(() => nova({ fav: 'ParcErrada', valor: 100, parcelas: [33.33, 33.33, 33.33].map((x, i) => ({ valor: x, vencimento: mais(hoje, i), multa: 0, juros: 0, desconto: 0, motivo: null })) }));
    confere(e && /soma/i.test(e), `soma 99,99 para 100,00: ${e}`);
    const e2 = await erroApp(() => nova({ fav: 'ParcUma', valor: 100, parcelas: [{ valor: 100, vencimento: hoje }] }));
    // 1 parcela só = pagamento único (a RPC ignora); não pode dar erro nem criar parcelas
    confere(e2 === null, `uma parcela só: ${e2}`);
  });

  await passo('nova despesa pela tela: parcelar em 3 e editar uma parcela para a soma não fechar mostra o aviso e nada é cadastrado', async () => {
    await ir(p, '/pagamentos/novo');
    await p.selectOption('select[name=obra_id]', obraC.id);
    await p.fill('input[name=favorecido]', `ParcTela ${M}`);
    await p.fill('input[name=descricao]', `Desp ${M}`);
    await p.fill('input[name=valor]', '100,00');
    await p.fill('input[name=vencimento]', hoje);
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await p.locator('select[aria-label="Conta bancária"], select[name=conta_bancaria_id]').first().selectOption({ index: 1 }).catch(() => {});
    await p.setInputFiles('input[name=boleto]', pdf);
    await p.fill('input[aria-label="Quantidade de parcelas"]', '3');
    await p.getByLabel('Valor da parcela 3').fill('30,00');
    await p.getByText('A soma das parcelas precisa ser igual ao valor do pagamento.').first().waitFor({ timeout: 10000 });
    await p.click('button:has-text("Cadastrar e encaminhar")');
    await p.waitForTimeout(2500);
    const erroTxt = await p.locator('main').innerText();
    confere(/soma das parcelas/i.test(erroTxt), 'sem mensagem de soma');
    confere(!/\/pagamentos\/[0-9a-f-]{36}/.test(p.url()), 'cadastrou com a soma errada');
    await p.getByLabel('Valor da parcela 3').fill('33,34');
    await p.getByLabel('Valor da parcela 1').fill('33,33');
    await p.getByLabel('Valor da parcela 2').fill('33,33');
    await Promise.all([p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}\?/, { timeout: 60000 }), p.click('button:has-text("Cadastrar e encaminhar")')]);
    const id = p.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const ps = await parcs(id);
    confere(ps.length === 3 && Number(ps[2].valor_base) === 33.34, JSON.stringify(ps.map((x) => x.valor_base)));
  });

  const pa = await nova({ fav: 'Parc3Baixa', valor: 90, venc: hoje, parcelas: [30, 30, 30].map((x, i) => ({ valor: x, vencimento: mais(hoje, i), multa: 0, juros: 0, desconto: 0, motivo: null })) });
  await passo('pagamento parcelado: baixa do pagamento inteiro é recusada, baixa por parcela pela tela; só fica "Pago" com a última parcela', async () => {
    const e = await erroApp(() => baixar(pa, null)); confere(e && /parcelado/.test(e), `baixa inteira: ${e}`);
    const ps = await parcs(pa);
    await ir(p, `/pagamentos/baixar?itens=parc:${ps[0].id}`);
    await Promise.all([p.waitForURL(/baixados=1/, { timeout: 60000 }), p.getByRole('button', { name: 'Registrar baixa' }).click()]);
    confere((await pag(pa)).status === 'aguardando_pagamento', 'virou pago com 1 de 3 parcelas');
    await um(fin.rpc('registrar_baixa_parcela', { p_parcela_id: ps[1].id, p_pago_em: hoje, p_valor_pago: 30, p_observacao: 'x' }));
    confere((await pag(pa)).status === 'aguardando_pagamento', 'virou pago com 2 de 3');
    await um(fin.rpc('registrar_baixa_parcela', { p_parcela_id: ps[2].id, p_pago_em: hoje, p_valor_pago: 30, p_observacao: 'x' }));
    const r = await pag(pa);
    confere(r.status === 'pago' && Number(r.valor_pago) === 90, JSON.stringify([r.status, r.valor_pago]));
    const dupe = await erroApp(() => um(fin.rpc('registrar_baixa_parcela', { p_parcela_id: ps[2].id, p_pago_em: hoje, p_valor_pago: 30, p_observacao: 'x' })));
    confere(dupe, 'baixar parcela já paga deveria ser recusado');
  });

  await passo('estornar UMA parcela paga: parcela volta a "a pagar", pagamento volta a aguardando e some a conciliação', async () => {
    const ps = await parcs(pa);
    await ir(p, lista());
    await linhaDe(p, `parc:${ps[2].id}`).getByRole('button', { name: /Ações/ }).click();
    await p.getByRole('menuitem', { name: 'Voltar para em aberto' }).click();
    const d = p.getByRole('dialog', { name: 'Voltar para em aberto' });
    await d.getByLabel('Motivo da volta para em aberto').fill('Parcela devolvida');
    await d.getByRole('button', { name: 'Confirmar' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    const ps2 = await parcs(pa); const r = await pag(pa);
    confere(ps2[2].status === 'a_pagar' && ps2[0].status === 'pago' && r.status === 'aguardando_pagamento', JSON.stringify([ps2.map((x) => x.status), r.status]));
  });

  await passo('editar parcelas: mudar valor/vencimento de uma parcela recalcula o total (exige motivo); parcela já paga não pode ser alterada', async () => {
    const id = await nova({ fav: 'EditaParc', valor: 90, venc: hoje, parcelas: [30, 30, 30].map((x, i) => ({ valor: x, vencimento: mais(hoje, i), multa: 0, juros: 0, desconto: 0, motivo: null })) });
    const ps = await parcs(id);
    const lista3 = (v2, venc2) => [{ id: ps[0].id, vencimento: ps[0].vencimento, valor: 30 }, { id: ps[1].id, vencimento: venc2, valor: v2 }, { id: ps[2].id, vencimento: ps[2].vencimento, valor: 30 }];
    const semMotivo = await erroApp(() => um(fin.rpc('editar_parcelas', { p_pagamento_id: id, p_parcelas: lista3(35, ps[1].vencimento), p_motivo: null })));
    confere(semMotivo && /motivo/i.test(semMotivo), `total muda sem motivo: ${semMotivo}`);
    await um(fin.rpc('editar_parcelas', { p_pagamento_id: id, p_parcelas: lista3(35, somarDias(ps[1].vencimento, 2)), p_motivo: 'renegociado' }));
    confere(Number((await pag(id)).valor) === 95, `total ${(await pag(id)).valor}`);
    await ir(p, `/pagamentos/${id}/editar`);
    confere(/parcela/i.test(await p.locator('main').innerText()), 'tela de editar sem parcelas');
    await um(fin.rpc('registrar_baixa_parcela', { p_parcela_id: ps[0].id, p_pago_em: hoje, p_valor_pago: 30, p_observacao: 'x' }));
    const paga = await erroApp(() => um(fin.rpc('editar_parcelas', { p_pagamento_id: id, p_parcelas: lista3(35, somarDias(ps[1].vencimento, 2)), p_motivo: 'x' })));
    confere(paga && /já está paga/.test(paga), `editar com parcela paga: ${paga}`);
  });

  // ───────────── Repetições e provisões ─────────────
  let rep;
  await passo('repetição mensal 1x3: despesa + 2 provisões em "Contas a pagar" (sem caixa de marcar), fora dos totais; Todo o período esconde provisões', async () => {
    rep = await nova({ fav: 'Repete', valor: 250.5, venc: hoje, rep: [1, 3] });
    const provs = await um(admin.from('provisoes').select('id, vencimento, valor_estimado, descricao, status').eq('pagamento_origem_id', rep).order('vencimento'));
    confere(provs.length === 2 && provs[0].vencimento === mais(hoje, 1) && provs[1].vencimento === mais(hoje, 2) && Number(provs[0].valor_estimado) === 250.5, JSON.stringify(provs));
    await ir(p, `/pagamentos?periodo=personalizado&de=${hoje}&ate=${mais(hoje, 3)}&busca=${encodeURIComponent('Repete ' + M)}`);
    const trs = await p.locator('tr[data-linha]').count();
    confere(trs === 3, `${trs} linha(s) (esperava 1 despesa + 2 provisões)`);
    confere(await p.locator('tr[data-linha^="prov:"] input.caixa-baixar').count() === 0, 'provisão com caixa de marcar');
    confere(await p.locator('tr[data-linha^="prov:"]').first().getByText('Provisão').count() >= 1, 'sem selo Provisão');
    const total = (await p.locator('[data-cartao="total"] .tabular-nums').innerText()).trim();
    confere(total === '250,50', `provisões entraram no total: ${total}`);
    await ir(p, lista());
    confere(await p.locator('tr[data-linha^="prov:"]').count() === 0, '"Todo o período" não deveria listar provisões');
  });

  await passo('repetição inválida é recusada (1 vez só, 0 meses, 61 vezes, 13 meses)', async () => {
    for (const r of [[1, 1], [0, 3], [1, 61], [13, 3]]) {
      const e = await erroApp(() => nova({ fav: 'RepRuim', valor: 5, rep: r }));
      confere(e, `repetição ${r} foi aceita`);
    }
  });

  await passo('provisão da série: "Lançar despesa" transforma em despesa e a provisão some da lista; cancelar a série cancela as restantes', async () => {
    const provs = await um(admin.from('provisoes').select('id').eq('pagamento_origem_id', rep).eq('status', 'provisionada').order('vencimento'));
    await ir(p, `/pagamentos?periodo=personalizado&de=${hoje}&ate=${mais(hoje, 3)}&busca=${encodeURIComponent('Repete ' + M)}`);
    await p.locator(`tr[data-linha="prov:${provs[0].id}"]`).getByRole('button', { name: 'Lançar despesa' }).click();
    const d = p.getByRole('dialog').first();
    confere(await cabe(d), 'janela da provisão cortando');
    await p.keyboard.press('Escape');
    const n = await um(fin.rpc('cancelar_serie', { p_pagamento_id: rep, p_a_partir: provs[1] ? mais(hoje, 2) : null }));
    confere(Number(n) === 1, `cancelar_serie a partir do mês 2 cancelou ${n}`);
    const st = await um(admin.from('provisoes').select('status').eq('pagamento_origem_id', rep).order('vencimento'));
    confere(st[0].status === 'provisionada' && st[1].status === 'cancelada', JSON.stringify(st));
    const re = await um(fin.rpc('reajustar_serie', { p_pagamento_id: rep, p_valor: 260.75 }));
    confere(Number(re) === 1, `reajuste atingiu ${re}`);
    const e = await erroApp(() => um(fin.rpc('reajustar_serie', { p_pagamento_id: rep, p_valor: 0 })));
    confere(e && /inválido/i.test(e), `valor 0 no reajuste: ${e}`);
  });

  // ───────────── Excluir lançamento: 4 escopos ─────────────
  const parcDatas = [mais(hoje, -1), hoje, mais(hoje, 1), mais(hoje, 2)].map((vv, i) => ({ valor: 25, vencimento: vv, multa: 0, juros: 0, desconto: 0, motivo: null }));
  const excluir = (id, parcelaId, escopo, motivo = 'Teste da Marina') => um(fin.rpc('excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: parcelaId, p_escopo: escopo, p_motivo: motivo }));
  const novaParc4 = async (fav) => {
    const id = await nova({ fav, valor: 100, venc: mais(hoje, -1), parcelas: parcDatas });
    return { id, ps: await parcs(id) };
  };

  await passo('excluir parcela, escopo "atual": só a parcela 2 sai, as outras são renumeradas e o total cai para 75,00', async () => {
    const { id, ps } = await novaParc4('ExclAtual');
    const r = await excluir(id, ps[1].id, 'atual');
    const resto = await parcs(id);
    confere(r.parcelas === 1 && resto.length === 3 && resto.map((x) => x.numero).join() === '1,2,3' && Number((await pag(id)).valor) === 75, JSON.stringify([r, resto.map((x) => x.numero)]));
  });

  await passo('excluir parcela, escopo "não vencidos": a partir da parcela 2 (vence hoje) tira 2, 3 e 4; a 1ª (vencida) fica', async () => {
    const { id, ps } = await novaParc4('ExclNaoVenc');
    const r = await excluir(id, ps[1].id, 'nao_vencidos');
    confere(r.parcelas === 3 && (await parcs(id)).length === 1 && Number((await pag(id)).valor) === 25, JSON.stringify(r));
  });

  await passo('excluir parcela, escopo "em aberto" preserva as pagas; "todos" estorna a baixa e leva tudo (despesa cancelada)', async () => {
    const { id, ps } = await novaParc4('ExclAberto');
    await um(fin.rpc('registrar_baixa_parcela', { p_parcela_id: ps[0].id, p_pago_em: hoje, p_valor_pago: 25, p_observacao: 'x' }));
    const r = await excluir(id, ps[2].id, 'em_aberto');
    const resto = await parcs(id);
    confere(r.parcelas === 3 && resto.length === 1 && resto[0].status === 'pago' && (await pag(id)).status === 'pago', JSON.stringify([r, resto.map((x) => x.status), (await pag(id)).status]));
    const r2 = await excluir(id, resto[0].id, 'todos');
    confere((await pag(id)).status === 'cancelado' && (await parcs(id)).length === 0, `todos: ${JSON.stringify(r2)} ${(await pag(id)).status}`);
  });

  await passo('excluir despesa de repetição: "atual" só ela; "em aberto" cancela despesa + provisões; "não vencidos" respeita datas', async () => {
    const r1 = await nova({ fav: 'ExclRep1', valor: 40, venc: hoje, rep: [1, 3] });
    const a1 = await excluir(r1, null, 'atual');
    const pr1 = await um(admin.from('provisoes').select('status').eq('pagamento_origem_id', r1));
    confere((await pag(r1)).status === 'cancelado' && pr1.every((x) => x.status === 'provisionada') && a1.pagamentos === 1, `atual: ${JSON.stringify(a1)} ${pr1.map((x) => x.status)}`);
    const r2 = await nova({ fav: 'ExclRep2', valor: 40, venc: hoje, rep: [1, 3] });
    const a2 = await excluir(r2, null, 'em_aberto');
    const pr2 = await um(admin.from('provisoes').select('status').eq('pagamento_origem_id', r2));
    confere((await pag(r2)).status === 'cancelado' && pr2.every((x) => x.status === 'cancelada') && a2.provisoes === 2, `em_aberto: ${JSON.stringify(a2)}`);
    const r3 = await nova({ fav: 'ExclRep3', valor: 40, venc: somarDias(hoje, -3), rep: [1, 3] });
    const a3 = await excluir(r3, null, 'nao_vencidos');
    // a despesa em que se clicou sempre sai; as provisões futuras também (ainda não venceram)
    confere((await pag(r3)).status === 'cancelado' && a3.provisoes === 2, `nao_vencidos: ${JSON.stringify(a3)} ${(await pag(r3)).status}`);
  });

  await passo('excluir PAGO (escopo "todos"): estorna a baixa e cancela; sem motivo ou com escopo inválido é recusado; "atual" em pago também estorna', async () => {
    const id = await nova({ fav: 'ExclPago', valor: 12 });
    await baixar(id, null);
    const sem = await erroApp(() => excluir(id, null, 'atual', 'x')); confere(sem && /motivo/i.test(sem), `motivo curto: ${sem}`);
    const ruim = await erroApp(() => excluir(id, null, 'qualquer', 'motivo ok')); confere(ruim && /Escolha/.test(ruim), `escopo inválido: ${ruim}`);
    await excluir(id, null, 'atual', 'Lançado em duplicidade');
    const r = await pag(id);
    confere(r.status === 'cancelado' && r.pago_em === null, JSON.stringify([r.status, r.pago_em]));
    const dnv = await erroApp(() => excluir(id, null, 'atual', 'de novo'));
    confere(dnv === null || /cancelad/i.test(dnv), `excluir de novo: ${dnv}`);
  });

  await passo('excluir pela tela (Ações › Excluir lançamento): janela com as opções certas, motivo obrigatório; cancelado só aparece com "Mostrar cancelados"', async () => {
    const id = await nova({ fav: 'ExclTela', valor: 15.15 });
    await ir(p, lista());
    await linhaDe(p, `pag:${id}`).getByRole('button', { name: /Ações/ }).click();
    await p.getByRole('menuitem', { name: 'Excluir lançamento' }).click();
    const d = p.getByRole('dialog', { name: 'Excluir lançamento' });
    confere(await d.locator('input[type=radio]').count() === 1, 'avulsa deveria ter só 1 opção');
    confere(await d.getByRole('button', { name: 'Excluir lançamento' }).isDisabled(), 'habilitado sem motivo');
    await d.getByLabel('Motivo da exclusão').fill('Cadastro repetido');
    await d.getByRole('button', { name: 'Excluir lançamento' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    await linhaDe(p, `pag:${id}`).waitFor({ state: 'detached', timeout: 15000 }).catch(() => { throw new Error('cancelada ainda na lista depois de excluir'); });
    await ir(p, lista('&cancelados=1'));
    const l = linhaDe(p, `pag:${id}`);
    confere(await l.count() === 1 && /Cancelad/i.test(await l.innerText()), 'não aparece com "Mostrar cancelados"');
    await l.getByRole('button', { name: /Ações/ }).click();
    confere(await p.getByRole('menuitem', { name: 'Excluir lançamento' }).count() === 0, 'despesa cancelada ainda oferece excluir');
    await p.keyboard.press('Escape'); await p.mouse.click(1, 1);
    const totalCard = (await p.locator('[data-cartao="total"] .tabular-nums').innerText()).trim();
    const semCanc = (await (async () => { await ir(p, lista()); return p.locator('[data-cartao="total"] .tabular-nums').innerText(); })()).trim();
    confere(totalCard === semCanc, `cancelados entraram no total (${totalCard} x ${semCanc})`);
  });


  // Limpeza (não conta como caso): o que sobrou em aberto sai de circulação (não vira sugestão em outros testes)
  try {
    for (const x of await um(admin.from('pagamentos').select('id').like('descricao', `%${M}%`).eq('status', 'aguardando_pagamento'))) await fin.rpc('excluir_lancamentos', { p_pagamento_id: x.id, p_parcela_id: null, p_escopo: 'todos', p_motivo: 'Limpeza da persona' });
    for (const x of await um(admin.from('provisoes').select('id').like('descricao', `%${M}%`).eq('status', 'provisionada'))) await admin.from('provisoes').update({ status: 'cancelada' }).eq('id', x.id);
  } catch { /* melhor esforço */ }
});
