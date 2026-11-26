// Persona: Marina, analista do Financeiro (financeiro@demo.local). Sabe as regras e usa Contas a pagar o dia todo.
// Este arquivo: Contas a pagar — cartões de totais, busca, filtros, período, valores limite, baixa individual (parcial, desconto, juros,
// duplicada), estorno, baixa em lote, ações em lote, alterar conta bancária, exportação, janelas e celular (1280px / 390px).
// Parcelas, repetições e excluir lançamento: financeiro-parcelas-exclusao.cjs. Extratos/conciliação: financeiro-conciliacao.cjs.
// Receber, medição, fundos, relatórios, notas, usuários: financeiro-receber-fundos.cjs.
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

rodar('Persona Marina — Contas a pagar completo', async ({ b, passo, entrar }) => {
  const M = marca('Mar');
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

  // ───────────── Cartões de totais, busca e filtros ─────────────
  const v = await nova({ fav: 'Vencido', valor: 100.1, venc: somarDias(hoje, -5) });
  const h = await nova({ fav: 'Hoje', valor: 200.2, venc: hoje });
  const a = await nova({ fav: 'AVencer', valor: 300.3, venc: somarDias(hoje, 5) });
  const pg = await nova({ fav: 'JaPago', valor: 50.05, venc: hoje });
  await baixar(pg, null);
  const ap = await nova({ fav: 'EmAprovacao', valor: 400.4, venc: somarDias(hoje, 3), obra: obraA });

  await passo('cartões de totais somam centavos exatos e cada um filtra só o seu grupo (clicar de novo desmarca)', async () => {
    await ir(p, lista());
    const val = async (c) => (await p.locator(`[data-cartao="${c}"] .tabular-nums`).innerText()).trim();
    const esperado = { vencidos: '100,10', hoje: '200,20', avencer: '300,30', aprovacao: '400,40', pagos: '50,05', total: brl(100.1 + 200.2 + 300.3 + 50.05 + 400.4) };
    for (const [c, e] of Object.entries(esperado)) confere(await val(c) === e, `cartão ${c}: ${await val(c)} (esperava ${e})`);
    for (const [c, id] of [['vencidos', v], ['hoje', h], ['avencer', a], ['aprovacao', ap], ['pagos', pg]]) {
      await p.locator(`[data-cartao="${c}"]`).click();
      await p.waitForURL((u) => u.search.includes(`cartao=${c}`)); await p.waitForLoadState('networkidle');
      const n = await p.locator('tr[data-linha]').count();
      confere(n === 1 && await linhaDe(p, `pag:${id}`).count() === 1, `cartão ${c}: ${n} linha(s)`);
      confere(await p.locator(`[data-cartao="${c}"]`).getAttribute('aria-current') === 'true', `cartão ${c} sem aria-current`);
    }
    await p.locator('[data-cartao="pagos"]').click(); // de novo = desmarca
    await p.waitForURL((u) => !u.search.includes('cartao=')); await p.waitForLoadState('networkidle');
    confere(await p.locator('tr[data-linha]').count() === 5, 'ao desmarcar o cartão deveriam voltar as 5 linhas');
    return 'vencidos 100,10 · hoje 200,20 · a vencer 300,30 · aprovação 400,40 · pagos 50,05';
  });

  await passo('"Soma da lista" e "Mostrando n de n" batem com as linhas (sem provisões)', async () => {
    await ir(p, lista());
    const rodape = (await p.locator('text=/Soma da lista/').first().innerText()).replace(/\s+/g, ' ');
    confere(/Mostrando 5 de 5/.test(rodape) && rodape.includes(brl(1051.05)), rodape);
  });

  await passo('busca: por favorecido (sem diferenciar maiúscula), por descrição, por nº exato; sem resultado mostra mensagem', async () => {
    const ver = async (q) => { await ir(p, `/pagamentos?periodo=todos&busca=${encodeURIComponent(q)}`); return p.locator('tr[data-linha]').count(); };
    confere(await ver(`vencido ${M}`.toUpperCase()) === 1, 'favorecido em maiúsculas');
    confere(await ver(`Desp ${M}`) === 5, 'descrição');
    const num = (await pag(v)).numero;
    confere(await ver(String(num)) >= 1 && await p.locator(`tr[data-linha="pag:${v}"]`).count() === 1, 'nº exato');
    confere(await ver(`zzz-inexistente-${M}`) === 0 && await p.getByText('Nenhuma conta neste período com esses filtros.').count() === 1, 'mensagem vazia');
    // Caracteres que quebrariam o filtro do PostgREST não podem dar erro 500
    for (const q of ['a,b', '(x)', '100%', 'a\\b', '*']) await ver(q);
    confere(await p.getByText(/Application error|Algo deu errado/).count() === 0, 'busca com caracteres especiais quebrou a tela');
  });

  await passo('filtros combinados (centro de custo + forma + categoria) pela janela "Mais filtros", etiqueta ✕ e "Limpar filtros"', async () => {
    const pix = await nova({ fav: 'PixOutraCat', valor: 11.11, forma: 'pix', cat: cats[1] });
    await ir(p, lista());
    await p.getByRole('button', { name: /Mais filtros/ }).click();
    await p.getByRole('menuitem', { name: 'Forma de pagamento' }).click().catch(() => {});
    // O botão "Mais filtros" abre uma lista; a janela do filtro é role=dialog "Filtrar por Forma de pagamento"
    let d = p.getByRole('dialog', { name: 'Filtrar por Forma de pagamento' });
    if (!(await d.count())) { await p.getByText('Forma de pagamento', { exact: true }).first().click(); d = p.getByRole('dialog', { name: 'Filtrar por Forma de pagamento' }); }
    await d.getByLabel('Pix', { exact: false }).first().check();
    await d.getByRole('button', { name: 'Aplicar' }).click();
    await p.waitForURL(/forma=pix/); await p.waitForLoadState('networkidle');
    confere(await p.locator('tr[data-linha]').count() === 1 && await linhaDe(p, `pag:${pix}`).count() === 1, 'filtro forma=pix');
    // categoria + obra por URL (combinados): pix da categoria 1 e obra C
    await ir(p, lista(`&forma=pix&categoria=${cats[1].id}&obra=${obraC.id}`));
    confere(await p.locator('tr[data-linha]').count() === 1, 'combinação forma+categoria+obra');
    await ir(p, lista(`&forma=pix&categoria=${cats[0].id}`));
    confere(await p.locator('tr[data-linha]').count() === 0, 'categoria errada deveria zerar');
    await ir(p, lista(`&obra=${obraA.id}`));
    confere(await p.locator('tr[data-linha]').count() === 1 && await linhaDe(p, `pag:${ap}`).count() === 1, 'filtro por obra A');
    await p.getByRole('button', { name: 'Remover filtro Centro de custo' }).click();
    await p.waitForURL((u) => !u.search.includes('obra=')); await p.waitForLoadState('networkidle');
    confere(await p.locator('tr[data-linha]').count() === 6, 'após ✕ deveriam voltar as 6 linhas');
    await ir(p, lista(`&forma=pix&obra=${obraC.id}`));
    await p.getByRole('button', { name: 'Limpar filtros' }).click();
    await p.waitForURL((u) => !u.search.includes('forma=') && !u.search.includes('busca=')); await p.waitForLoadState('networkidle');
    confere(!p.url().includes('busca='), 'Limpar filtros mantém a busca');
    await um(admin.from('pagamentos').update({ status: 'cancelado', cancelamento_motivo: 'limpeza persona' }).eq('id', pix)).catch(() => {});
  });

  await passo('período: personalizado com datas invertidas é corrigido, ‹ › andam o mesmo tamanho e "Todo o período" não anda', async () => {
    await ir(p, `/pagamentos?periodo=personalizado&de=${somarDias(hoje, 10)}&ate=${somarDias(hoje, -10)}&busca=${encodeURIComponent(M)}`);
    confere(await p.locator('[data-periodo-rotulo]').innerText() !== '', 'sem rótulo');
    confere(await p.locator('tr[data-linha]').count() === 5, 'datas invertidas deveriam virar o intervalo certo (5 linhas)');
    await p.getByRole('button', { name: 'Próximo período' }).click();
    await p.waitForURL((u) => u.search.includes(`de=${somarDias(hoje, 11)}`)); await p.waitForLoadState('networkidle');
    confere(await p.locator('tr[data-linha]').count() === 0, 'um intervalo depois não deveria ter linhas');
    await ir(p, lista());
    confere(await p.getByRole('button', { name: 'Período anterior' }).isDisabled() && await p.getByRole('button', { name: 'Próximo período' }).isDisabled(), '"Todo o período" não deveria andar');
  });

  await passo('valores limite no banco: R$ 0,01 aceito; zero, negativo e fração de centavo recusados; valor enorme não estoura', async () => {
    const cent = await nova({ fav: 'Centavo', valor: 0.01 });
    confere(Number((await pag(cent)).valor) === 0.01, 'não gravou 0,01');
    for (const bad of [0, -5]) confere(await erroApp(() => nova({ fav: 'Ruim', valor: bad })), `valor ${bad} foi aceito`);
    const frac = await erroApp(async () => { const id = await nova({ fav: 'Fracao', valor: 10.005 }); const vlr = Number((await pag(id)).valor); if (vlr !== 10.01 && vlr !== 10) throw new Error(`gravou ${vlr}`); });
    confere(frac === null, `fração de centavo: ${frac}`);
    const grande = await erroApp(() => nova({ fav: 'Grande', valor: 99999999999.99 }));
    confere(grande === null, `valor grande recusado: ${grande}`);
    await ir(p, lista());
    confere(await p.getByText(/0,01/).count() > 0, 'a tela não mostra R$ 0,01');
  });

  // ───────────── Baixa individual, parcial, desconto, juros, duplicada, estorno ─────────────
  await passo('baixa individual pela tela (Ações › Baixar › Registrar baixa): vira "Pago" com "baixa manual" e Pago em hoje', async () => {
    const id = await nova({ fav: 'BaixaTela', valor: 123.45 });
    await ir(p, lista());
    await linhaDe(p, `pag:${id}`).getByRole('button', { name: /Ações/ }).click();
    await Promise.all([p.waitForURL(/\/pagamentos\/baixar\?itens=pag:/), p.getByRole('menuitem', { name: 'Baixar', exact: true }).click()]);
    await p.waitForLoadState('networkidle');
    confere(await p.getByRole('button', { name: 'Registrar baixa' }).isVisible(), 'sem botão Registrar baixa');
    await Promise.all([p.waitForURL(/baixados=1/, { timeout: 60000 }), p.getByRole('button', { name: 'Registrar baixa' }).click()]);
    const r = await pag(id);
    confere(r.status === 'pago' && r.pago_em === hoje && Number(r.valor_pago) === 123.45, JSON.stringify(r));
    await ir(p, lista());
    const sit = await linhaDe(p, `pag:${id}`).locator('[data-pago-via]').innerText();
    confere(/Pago/.test(sit) && /baixa manual/.test(sit) && !sit.includes('✓'), sit);
  });

  await passo('pagamento parcial R$ 0,01 (centavo) pela tela do pagamento: vira parcela paga + saldo, e continua a pagar', async () => {
    const id = await nova({ fav: 'ParcialCent', valor: 100 });
    await ir(p, `/pagamentos/${id}#baixa`);
    await p.locator('#baixa input[name=valor_pago]').fill('0,01');
    await p.getByRole('button', { name: 'Confirmar pagamento' }).click();
    await p.waitForTimeout(1500); await p.waitForLoadState('networkidle');
    const r = await pag(id); const ps = await parcs(id);
    confere(r.status === 'aguardando_pagamento' && ps.length === 2 && ps[0].status === 'pago' && Number(ps[0].valor_pago) === 0.01 && Number(ps[1].valor_base) === 99.99 && ps[1].status === 'a_pagar', JSON.stringify({ s: r.status, ps: ps.map((x) => [x.numero, x.status, x.valor_base]) }));
  });

  await passo('baixa com desconto (valor menor + "desconto"): quita o pagamento e não deixa saldo', async () => {
    const id = await nova({ fav: 'Desconto', valor: 500 });
    await ir(p, `/pagamentos/${id}#baixa`);
    await p.locator('#baixa input[name=valor_pago]').fill('450,00');
    await p.locator('#baixa input[name=diferenca][value=desconto]').check();
    await p.getByRole('button', { name: 'Confirmar pagamento' }).click();
    await p.waitForTimeout(1500);
    const r = await pag(id);
    confere(r.status === 'pago' && Number(r.valor_pago) === 450 && (await parcs(id)).length === 0, JSON.stringify([r.status, r.valor_pago]));
  });

  await passo('baixa com valor MAIOR (juros) é aceita e registra o valor pago; valor zero/negativo é recusado', async () => {
    const id = await nova({ fav: 'Juros', valor: 200 });
    const e0 = await erroApp(() => baixar(id, 0)); confere(e0 && /maior que zero/.test(e0), `valor 0: ${e0}`);
    const e1 = await erroApp(() => baixar(id, -10)); confere(e1 && /maior que zero/.test(e1), `valor negativo: ${e1}`);
    await baixar(id, 212.34);
    const r = await pag(id);
    confere(r.status === 'pago' && Number(r.valor_pago) === 212.34, JSON.stringify([r.status, r.valor_pago]));
  });

  await passo('baixa duplicada: segunda baixa é recusada e clique duplo no botão gera uma única baixa', async () => {
    const id = await nova({ fav: 'Duplicada', valor: 77.7 });
    await baixar(id, null);
    const e = await erroApp(() => baixar(id, null));
    confere(e && /não está liberado/.test(e), `segunda baixa: ${e}`);
    const id2 = await nova({ fav: 'CliqueDuplo', valor: 31.3 });
    await ir(p, `/pagamentos/baixar?itens=pag:${id2}`);
    const btn = p.getByRole('button', { name: 'Registrar baixa' });
    await btn.dblclick().catch(() => {});
    await p.waitForTimeout(3000);
    const r = await pag(id2);
    confere(r.status === 'pago', r.status);
    const aud = await um(admin.from('auditoria').select('id').eq('pagamento_id', id2).eq('acao', 'baixa'));
    confere(aud.length === 1, `${aud.length} baixas auditadas`);
  });

  await passo('estornar baixa (Ações › Voltar para em aberto): exige motivo (3+ letras), volta a "A pagar" e some o "Pago em"', async () => {
    const id = await nova({ fav: 'Estorno', valor: 66.6 });
    await baixar(id, null);
    await ir(p, lista());
    await linhaDe(p, `pag:${id}`).getByRole('button', { name: /Ações/ }).click();
    await p.getByRole('menuitem', { name: 'Voltar para em aberto' }).click();
    const d = p.getByRole('dialog', { name: 'Voltar para em aberto' });
    confere(await cabe(d), 'janela cortando');
    confere(await d.getByRole('button', { name: 'Confirmar' }).isDisabled(), 'sem motivo e já habilitado');
    await d.getByLabel('Motivo da volta para em aberto').fill('ab');
    confere(await d.getByRole('button', { name: 'Confirmar' }).isDisabled(), 'motivo de 2 letras habilitou');
    await d.getByLabel('Motivo da volta para em aberto').fill('Pagamento devolvido pelo banco');
    await d.getByRole('button', { name: 'Confirmar' }).click();
    await d.waitFor({ state: 'detached', timeout: 20000 });
    const r = await pag(id);
    confere(r.status === 'aguardando_pagamento' && r.pago_em === null && r.valor_pago === null, JSON.stringify(r));
  });

  // ───────────── Lote ─────────────
  const lote = [];
  for (const [fav, valor] of [['Lote1', 10.01], ['Lote2', 20.02], ['Lote3', 30.03]]) lote.push(await nova({ fav, valor }));

  await passo('baixa em lote: marcar 3 contas mostra "3 selecionada(s) · R$ 60,06", Baixar abre a tela única e registra as 3', async () => {
    await ir(p, `/pagamentos?periodo=todos&busca=${encodeURIComponent('Lote')}`);
    for (const id of lote) await p.check(`tr[data-linha="pag:${id}"] input.caixa-baixar`);
    const barra = (await p.getByRole('status').filter({ hasText: /selecionada/ }).first().innerText()).replace(/\s+/g, ' ');
    confere(/\b3 selecionada\(s\)/.test(barra) || /selecionada/.test(barra), barra);
    const so = await p.evaluate((ids) => ids.map((i) => document.querySelector(`tr[data-linha="pag:${i}"] input.caixa-baixar`).checked), lote);
    confere(so.every(Boolean), 'caixas não marcadas');
    await Promise.all([p.waitForURL(/\/pagamentos\/baixar\?/), p.click('#form-baixar button:has-text("Baixar")')]);
    await p.waitForLoadState('networkidle');
    const linhas = await p.locator('tr[data-item]').count();
    confere(linhas >= 3, `${linhas} itens na tela de baixa`);
    // Tira o que não é do teste (outros agentes podem ter "Lote" no nome) — fica só quem for desta marca
    for (const tr of await p.locator('tr[data-item]').all()) {
      const t = await tr.innerText(); if (!t.includes(M)) await tr.getByRole('button', { name: 'Tirar' }).click();
    }
    confere(await p.locator('tr[data-item]').count() === 3, 'não ficaram exatamente 3 itens');
    const total = (await p.locator('text=/Total R\\$/').first().innerText()).replace(/\s+/g, ' ');
    confere(total.includes('60,06'), total);
    await Promise.all([p.waitForURL(/baixados=3/, { timeout: 60000 }), p.getByRole('button', { name: 'Registrar 3 baixas' }).click()]);
    for (const id of lote) confere((await pag(id)).status === 'pago', 'lote não baixou tudo');
  });

  await passo('lote com valor pago menor num dos itens: a diferença vira saldo em aberto (parcela) e os outros quitam', async () => {
    const ids = [await nova({ fav: 'LoteParcial1', valor: 100 }), await nova({ fav: 'LoteParcial2', valor: 50 })];
    await ir(p, `/pagamentos/baixar?itens=pag:${ids[0]},pag:${ids[1]}`);
    const n0 = (await pag(ids[0])).numero;
    await p.getByLabel(`Valor pago nº ${n0}`).fill('60,00');
    confere(await p.getByText('Menor que o valor: a diferença fica como saldo em aberto.').count() === 1, 'sem aviso de saldo');
    await Promise.all([p.waitForURL(/baixados=2/, { timeout: 60000 }), p.getByRole('button', { name: 'Registrar 2 baixas' }).click()]);
    const algum = await Promise.all(ids.map(async (id) => [(await pag(id)).status, (await parcs(id)).length]));
    const parcial = algum.find((x) => x[1] === 2); const inteiro = algum.find((x) => x[1] === 0);
    confere(parcial && parcial[0] === 'aguardando_pagamento' && inteiro && inteiro[0] === 'pago', JSON.stringify(algum));
  });

  await passo('lote com item já baixado (seleção velha): erro parcial lista o problema e as outras contas são baixadas', async () => {
    const ids = [await nova({ fav: 'LoteVelha1', valor: 10 }), await nova({ fav: 'LoteVelha2', valor: 20 })];
    await ir(p, `/pagamentos/baixar?itens=pag:${ids[0]},pag:${ids[1]}`);
    await baixar(ids[0], null); // outra pessoa baixa enquanto a tela está aberta
    await p.getByRole('button', { name: 'Registrar 2 baixas' }).click();
    await p.getByText(/Problemas:/).waitFor({ timeout: 30000 });
    const txt = await p.locator('main').innerText();
    confere(/1 pagamento\(s\) registrados como pagos/.test(txt) && /não está liberado/.test(txt), txt.slice(0, 300));
    confere((await pag(ids[1])).status === 'pago', 'a outra conta não foi baixada');
  });

  await passo('barra de seleção: conta paga ou em aprovação marcada deixa "Baixar" desabilitado; só liberadas contam em "Baixar (n)"', async () => {
    const livre = await nova({ fav: 'BarraLivre', valor: 5 });
    await ir(p, `/pagamentos?periodo=todos&busca=${encodeURIComponent(M)}`);
    await p.check(`tr[data-linha="pag:${ap}"] input.caixa-baixar`);
    confere(await p.locator('#form-baixar button:has-text("Baixar")').isDisabled(), 'Baixar habilitado só com conta em aprovação');
    await p.check(`tr[data-linha="pag:${livre}"] input.caixa-baixar`);
    const t = await p.locator('#form-baixar button:has-text("Baixar")').innerText();
    confere(/Baixar \(1\)/.test(t), `rótulo: ${t}`);
    await p.getByRole('button', { name: 'Desmarcar todas' }).click();
    confere(await p.locator('input.caixa-baixar:checked').count() === 0, 'Desmarcar todas não desmarcou');
    await p.getByLabel('Marcar todas as contas a pagar').check();
    confere(await p.locator('input.caixa-baixar:checked').count() >= 5, 'marcar todas');
    await p.getByRole('button', { name: 'Desmarcar todas' }).click();
  });

  await passo('Ações em lote: alterar categoria e data de competência de 2 contas; motivo curto bloqueia "Cancelar lançamentos"', async () => {
    const x = [await nova({ fav: 'AcLote1', valor: 1.5 }), await nova({ fav: 'AcLote2', valor: 2.5 })];
    await ir(p, `/pagamentos?periodo=todos&busca=AcLote`);
    for (const id of x) await p.check(`tr[data-linha="pag:${id}"] input.caixa-baixar`);
    await p.getByRole('button', { name: /Ações em lote/ }).click();
    await p.getByRole('menuitem', { name: 'Alterar categoria' }).click();
    let d = p.getByRole('dialog', { name: 'Alterar categoria' });
    confere(await cabe(d), 'janela de categoria cortando');
    await d.getByLabel('Nova categoria').selectOption(cats[2].id);
    await d.getByRole('button', { name: 'Aplicar' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    await p.waitForLoadState('networkidle');
    for (const id of x) confere((await pag(id)).categoria_id === cats[2].id, 'categoria não mudou');
    for (const id of x) await p.check(`tr[data-linha="pag:${id}"] input.caixa-baixar`);
    await p.getByRole('button', { name: /Ações em lote/ }).click();
    await p.getByRole('menuitem', { name: 'Alterar data de competência' }).click();
    d = p.getByRole('dialog', { name: 'Alterar data de competência' });
    await d.getByLabel('Nova data de competência').fill(somarDias(hoje, -40));
    await d.getByRole('button', { name: 'Aplicar' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    for (const id of x) confere((await pag(id)).data_competencia === somarDias(hoje, -40), 'competência não mudou');
    for (const id of x) await p.check(`tr[data-linha="pag:${id}"] input.caixa-baixar`);
    await p.getByRole('button', { name: /Ações em lote/ }).click();
    await p.getByRole('menuitem', { name: 'Cancelar lançamentos' }).click();
    d = p.getByRole('dialog', { name: 'Cancelar lançamentos' });
    await d.getByLabel('Motivo').fill('ab');
    confere(await d.getByRole('button', { name: 'Aplicar' }).isDisabled(), 'motivo de 2 letras habilitou o cancelamento em lote');
    await d.getByLabel('Motivo').fill('Lançadas por engano');
    await d.getByRole('button', { name: 'Aplicar' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    await p.waitForTimeout(1200);
    for (const id of x) confere((await pag(id)).status === 'cancelado', 'cancelamento em lote falhou');
  });

  await passo('Ações em lote › "Voltar para em aberto" só habilita com conta paga marcada e estorna em lote; cancelar PAGO é recusado', async () => {
    const x = [await nova({ fav: 'EstLote1', valor: 8 }), await nova({ fav: 'EstLote2', valor: 9 })];
    await baixar(x[0], null); await baixar(x[1], null);
    await ir(p, `/pagamentos?periodo=todos&busca=EstLote`);
    for (const id of x) await p.check(`tr[data-linha="pag:${id}"] input.caixa-baixar`);
    await p.getByRole('button', { name: /Ações em lote/ }).click();
    // cancelar contas pagas: o banco recusa e a tela mostra o motivo
    await p.getByRole('menuitem', { name: 'Cancelar lançamentos' }).click();
    let d = p.getByRole('dialog', { name: 'Cancelar lançamentos' });
    await d.getByLabel('Motivo').fill('Tentativa de cancelar pago');
    await d.getByRole('button', { name: 'Aplicar' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    await p.waitForTimeout(1200);
    const msg = await p.locator('[data-msg-lote]').innerText().catch(() => '');
    confere((await pag(x[0])).status === 'pago' && (await pag(x[1])).status === 'pago', 'cancelou conta paga em lote');
    confere(/pag/i.test(msg) || msg.length > 0, 'sem mensagem do lote');
    for (const id of x) await p.check(`tr[data-linha="pag:${id}"] input.caixa-baixar`).catch(() => {});
    await p.getByRole('button', { name: /Ações em lote/ }).click();
    await p.getByRole('menuitem', { name: /Voltar para em aberto/ }).click();
    d = p.getByRole('dialog', { name: 'Voltar para em aberto' });
    await d.getByLabel('Motivo').fill('Conferência de extrato');
    await d.getByRole('button', { name: 'Aplicar' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    await p.waitForTimeout(1200);
    for (const id of x) confere((await pag(id)).status === 'aguardando_pagamento', 'estorno em lote não aplicou');
  });

  await passo('alterar conta bancária (Ações › Alterar conta bancária): dialogo exige escolha e grava na despesa; também vale numa despesa paga', async () => {
    if (contas.length < 2) await um(admin.from('contas_bancarias').insert({ nome: `Conta extra ${M}`, banco: '777', agencia: '1', conta: String(Date.now()).slice(-8), created_by: finId }));
    const todas = await um(admin.from('contas_bancarias').select('id, nome').eq('ativa', true).order('nome'));
    const outra = todas.find((c) => c.id !== conta.id);
    const id = await nova({ fav: 'TrocaConta', valor: 44.4 });
    await ir(p, lista());
    await linhaDe(p, `pag:${id}`).getByRole('button', { name: /Ações/ }).click();
    await p.getByRole('menuitem', { name: 'Alterar conta bancária' }).click();
    const d = p.getByRole('dialog', { name: 'Alterar conta bancária' });
    confere(await d.getByRole('button', { name: 'Salvar' }).isDisabled(), 'Salvar habilitado sem escolher');
    await d.getByLabel('Nova conta bancária').selectOption(outra.id);
    await d.getByRole('button', { name: 'Salvar' }).click(); await d.waitFor({ state: 'detached', timeout: 20000 });
    confere((await pag(id)).conta_bancaria_id === outra.id, 'conta não mudou');
    await baixar(id, null);
    await ir(p, lista());
    await linhaDe(p, `pag:${id}`).getByRole('button', { name: /Ações/ }).click();
    confere(await p.getByRole('menuitem', { name: 'Alterar conta bancária' }).count() === 1, 'despesa paga deveria permitir trocar a conta (Financeiro)');
    await p.keyboard.press('Escape'); await p.mouse.click(1, 1);
  });

  const paLayout = await nova({ fav: 'Parc3Layout', valor: 90, venc: hoje, parcelas: [30, 30, 30].map((x, i) => ({ valor: x, vencimento: mais(hoje, i), multa: 0, juros: 0, desconto: 0, motivo: null })) });
  // ───────────── Exportação ─────────────
  await passo('exportar planilha: segue a lista da tela (busca + cartão), valores numéricos (centavos exatos) em Excel organizado; selecionadas por ids', async () => {
    const { lerXlsx, dadosDaTabela } = require('../_xlsx.cjs');
    const tabela = async (url, titulo) => dadosDaTabela((await lerXlsx(await (await p.request.get(`${BASE}${url}`)).body()))[0], titulo);
    const todas = await tabela(`/pagamentos/exportar?lista=contas&periodo=todos&busca=${encodeURIComponent('Lote')}`, 'Vencimento');
    const so = await tabela(`/pagamentos/exportar?lista=contas&periodo=todos&busca=${encodeURIComponent('Centavo ' + M)}`, 'Vencimento');
    confere(so.linhas.length === 1 && todas.linhas.length >= 1, `linhas: busca específica=${so.linhas.length}`);
    const iValor = so.cabecalho.indexOf('Valor (R$)');
    confere(so.linhas[0][iValor] === 0.01, `o valor deveria ser o número 0,01 (veio ${JSON.stringify(so.linhas[0][iValor])})`);
    const ids = [lote[0], lote[1]].join(',');
    const sel = await tabela(`/pagamentos/exportar?ids=${ids}`, 'Nº');
    confere(sel.linhas.length === 2, `selecionadas: ${sel.linhas.length}`);
  });

  // ───────────── Tela: janelas e celular ─────────────
  await passo('janelas da lista (Excluir lançamento, Voltar para em aberto, Alterar conta bancária) cabem em 1440px e 390px, com parcela em aberto e parcela paga', async () => {
    const psl = await um(admin.from('pagamento_parcelas').select('id').eq('pagamento_id', paLayout).order('numero'));
    await um(fin.rpc('registrar_baixa_parcela', { p_parcela_id: psl[0].id, p_pago_em: hoje, p_valor_pago: 30, p_observacao: 'x' }));
    const vistas = new Set();
    for (const [pg, nome] of [[p, '1440'], [cel, '390']]) {
      for (const item of ['Excluir lançamento', 'Voltar para em aberto', 'Alterar conta bancária']) {
        await ir(pg, `/pagamentos?periodo=todos&busca=${encodeURIComponent('Parc3Layout ' + M)}`);
        const linhas = pg.locator('tr[data-linha^="parc:"]');
        let aberta = false;
        for (let i = 0; i < await linhas.count() && !aberta; i++) {
          await linhas.nth(i).getByRole('button', { name: /Ações/ }).click();
          const mi = pg.getByRole('menuitem', { name: item, exact: true });
          if (await mi.count()) { await mi.click(); aberta = true; } else { await pg.keyboard.press('Escape'); await pg.mouse.click(1, 1); }
        }
        confere(aberta, `${nome}px: nenhuma linha ofereceu "${item}"`);
        const d = pg.getByRole('dialog', { name: item });
        confere(await cabe(d), `${nome}px: janela "${item}" cortando`);
        vistas.add(`${nome}:${item}`);
      }
    }
    return `${vistas.size} janelas conferidas`;
  });

  await passo('sem rolagem lateral em 1280px e 390px: Contas a pagar, baixar, nova despesa, provisões, agenda, pagamento, editar', async () => {
    const p1280 = await entrar('financeiro', 1280);
    const alvoId = await nova({ fav: 'Layout', valor: 321.09 });
    const problemas = [];
    for (const [pg, w] of [[p1280, 1280], [cel, 390]]) {
      for (const url of [lista(), `/pagamentos/baixar?itens=pag:${alvoId}`, '/pagamentos/novo', '/provisoes', '/agenda', `/pagamentos/${alvoId}`, `/pagamentos/${paLayout}/editar`]) {
        await ir(pg, url);
        if (!(await semRolagem(pg))) {
          const onde = await pg.evaluate(() => [...document.querySelectorAll('main *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)).map((w) => `${w.scrollWidth}>${w.clientWidth}`).join(' '));
          problemas.push(`${url.split('?')[0]} (${w}px: ${onde || 'página'})`);
        }
      }
    }
    await cel.screenshot({ path: path.join(DIR, 'marina-celular.png') });
    confere(problemas.length === 0, `rolagem lateral em: ${problemas.join(' | ')}`);
  });
});
