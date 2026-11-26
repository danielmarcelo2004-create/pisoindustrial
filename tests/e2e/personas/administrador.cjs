// Persona: "Dona Helena", administradora da obra (administrador@demo.local).
// Cobre: visão só das obras vinculadas, assinatura/rejeição na etapa dela, ordem do fluxo, reenvio, valor alterado
// depois da assinatura, assinatura duplicada/lote, permissões negativas (tela e API direta), auditoria imutável,
// notificações (sino, e-mail e WhatsApp pelo cron simulado) e celular 390px.
// Dados fictícios (marca). Não recria o banco: cria obras/pagamentos próprios e cancela o que sobrar no fim.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { BASE, admin, hoje, somarDias, marca, confere, cliente, rodar, ir } = require('./_util.cjs');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const SUPA = env.NEXT_PUBLIC_SUPABASE_URL;
const PUB = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SENHA = 'Demo-1234';
const SEGREDO = 'segredo-teste';

const ate = async (fn, ms = 20000) => {
  const fim = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição'); await new Promise((r) => setTimeout(r, 300)); }
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const erroDe = async (q) => { const r = await q; return r.error ? r.error.message : null; };
const dep = async (q) => { const r = await q; if (r.error) throw new Error(r.error.message); return r.data; };

(async () => {
  const stamp = marca('Helena');
  let n = 0;
  const desc = (t = '') => `${stamp} [${String(++n).padStart(2, '0')}] ${t}`.trim();

  const fin = await cliente('financeiro');
  const eng = await cliente('engenheiro');
  const hel = await cliente('administrador');
  const adm2 = await cliente('administrador2');
  const sup = await cliente('suprimentos');
  const anon = createClient(SUPA, PUB, { auth: { persistSession: false } });
  const perfis = await dep(admin.from('profiles').select('id, email, nome'));
  const id = (e) => perfis.find((x) => x.email === `${e}@demo.local`).id;
  const ID = { hel: id('administrador'), adm2: id('administrador2'), eng: id('engenheiro'), fin: id('financeiro') };

  // ---- fixtures: obras A (engenheiro + Helena), B (só Helena), C (sem responsáveis), X (de outra administradora)
  const mkObra = async (nome, fluxo, o = {}) => (await dep(fin.from('obras').insert({ nome: `${stamp} ${nome}`, cidade: 'Salvador', uf: 'BA', fluxo, ...o }).select().single()));
  const obraA = await mkObra('Obra A', 'A', { engenheiro_id: ID.eng, administrador_id: ID.hel });
  const obraB = await mkObra('Obra B', 'B', { administrador_id: ID.hel });
  const obraC = await mkObra('Obra C', 'C');
  const obraX = await mkObra('Obra X alheia', 'B', { administrador_id: ID.adm2 });
  const criados = [];
  const novoPag = async (obra, valor = 1000, d = desc('pag'), cli = fin) => {
    const pid = await dep(cli.rpc('criar_pagamento', { p_obra_id: obra.id, p_fornecedor_id: null, p_favorecido: 'Fornecedor Helena', p_descricao: d, p_valor: valor, p_vencimento: somarDias(hoje, 7), p_forma_pagamento: 'boleto' }));
    criados.push(pid);
    return { id: pid, desc: d };
  };
  const pag = async (pid) => dep(admin.from('pagamentos').select('*').eq('id', pid).single());
  const assin = async (pid) => dep(admin.from('assinaturas').select('*').eq('pagamento_id', pid).order('created_at'));
  const audit = async (pid) => dep(admin.from('auditoria').select('*').eq('pagamento_id', pid).order('id'));
  const decidirRPC = (cli, pid, versao, decisao = 'aprovado', comentario = null) => cli.rpc('decidir_aprovacao', { p_itens: [{ id: pid, versao }], p_decisao: decisao, p_comentario: comentario });
  const engAssina = async (pid) => { const e = await erroDe(decidirRPC(eng, pid, (await pag(pid)).versao)); confere(!e, 'engenheiro não conseguiu assinar: ' + e); };
  const upd = (pid, campos) => fin.rpc('atualizar_pagamento', { p_id: pid, p_fornecedor_id: null, p_favorecido: 'Fornecedor Helena', p_descricao: campos.descricao, p_valor: campos.valor, p_vencimento: somarDias(hoje, 7), p_forma_pagamento: 'boleto', p_numero_documento: null, p_observacoes: campos.obs ?? null, p_motivo: campos.motivo ?? 'ajuste de teste' });

  // ---- helpers de tela
  async function marcarItens(p, descs) {
    await ir(p, '/aprovacoes');
    for (const d of descs) await p.locator('tr', { hasText: d }).first().locator('input[type=checkbox]').check();
    await p.click('button:has-text("Revisar e assinar selecionados")');
    await p.locator('[role=dialog]').waitFor();
  }
  async function preencher(p, { senha = SENHA, conferi = true, rejeitar = false, motivo = '', enviar = true } = {}) {
    const f = p.locator('[role=dialog] form');
    if (rejeitar) await f.locator('label:has-text("Rejeitar") input[type=radio]').check();
    if (motivo) await f.locator('textarea[name=comentario]').fill(motivo);
    if (conferi) await f.locator('input[name=conferi]').check();
    await f.locator('input[name=senha]').fill(senha);
    if (enviar) await f.locator('button[type=submit]').click();
  }
  async function assinarNaLista(p, d, opcoes) { await marcarItens(p, [d]); await preencher(p, opcoes); }
  const larguraOk = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  await rodar('Persona Helena (administradora)', async ({ b, passo, entrar }) => {
    const helena = await entrar('administrador');
    const eng1 = await entrar('engenheiro');

    // =============== visibilidade ===============
    await passo('administradora só enxerga as obras em que é responsável (API)', async () => {
      const obras = await dep(hel.from('obras').select('id, nome'));
      const ids = obras.map((o) => o.id);
      confere(ids.includes(obraA.id) && ids.includes(obraB.id), 'não vê as próprias obras');
      confere(!ids.includes(obraX.id) && !ids.includes(obraC.id), 'vê obra que não é dela');
      confere(obras.every((o) => !o.nome.includes('alheia')), 'nome de obra alheia vazou');
      return `${obras.length} obra(s)`;
    });
    await passo('tela Centros de custo lista só as obras dela', async () => {
      await ir(helena, '/obras');
      const t = await helena.textContent('main');
      confere(t.includes(`${stamp} Obra A`) && t.includes(`${stamp} Obra B`), 'faltam as próprias obras');
      confere(!t.includes('Obra X alheia') && !t.includes(`${stamp} Obra C`), 'mostra obra alheia');
      confere(!(await helena.$('a:has-text("+ Novo centro de custo")')), 'oferece criar obra');
    });
    await passo('URL direta de obra e de pagamento de obra alheia dá 404', async () => {
      const pX = await novoPag(obraX, 500);
      const r1 = await helena.goto(`${BASE}/obras/${obraX.id}`);
      confere(r1.status() === 404, `obra alheia respondeu ${r1.status()}`);
      const r2 = await helena.goto(`${BASE}/pagamentos/${pX.id}`);
      confere(r2.status() === 404, `pagamento alheio respondeu ${r2.status()}`);
      const pC = await novoPag(obraC, 500);
      const r3 = await helena.goto(`${BASE}/pagamentos/${pC.id}`);
      confere(r3.status() === 404, `pagamento de obra sem vínculo respondeu ${r3.status()}`);
    });
    await passo('API direta: pagamentos, documentos, assinaturas e auditoria de obra alheia vêm vazios', async () => {
      const pX = await novoPag(obraX, 700);
      const a = await dep(hel.from('pagamentos').select('id').eq('obra_id', obraX.id));
      const d = await dep(hel.from('documentos').select('id').eq('obra_id', obraX.id));
      const s = await dep(hel.from('assinaturas').select('id').eq('pagamento_id', pX.id));
      const au = await dep(hel.from('auditoria').select('id').eq('pagamento_id', pX.id));
      confere(a.length + d.length + s.length + au.length === 0, `vazou: ${a.length}/${d.length}/${s.length}/${au.length}`);
      const e = await erroDe(decidirRPC(hel, pX.id, 1));
      confere(e && /não encontrado/i.test(e), 'RPC de pagamento alheio devia dizer "não encontrado": ' + e);
    });

    // =============== permissões negativas: telas ===============
    await passo('telas proibidas redirecionam com aviso de permissão (usuários, auditoria, obra nova, baixa, fornecedores…)', async () => {
      const proibidas = ['/usuarios', '/usuarios/novo', `/usuarios/${ID.eng}`, '/auditoria', '/obras/nova', '/pagamentos/novo', '/pagamentos/baixar', '/fornecedores', '/fornecedores/novo', '/notas-contabeis', '/notas-medicao', '/categorias', '/compras/ler-notas'];
      const ruins = [];
      for (const rota of proibidas) {
        await helena.goto(BASE + rota); await helena.waitForLoadState('networkidle');
        if (!helena.url().includes('sem-permissao=1')) ruins.push(`${rota} → ${helena.url().replace(BASE, '')}`);
      }
      confere(!ruins.length, 'abriu sem permissão: ' + ruins.join('; '));
    });
    await passo('menu da administradora não mostra Usuários, Histórico, Baixa nem Fornecedores; mostra Aprovações e Minha assinatura', async () => {
      await ir(helena, '/');
      const menu = await helena.locator('nav').first().textContent();
      for (const x of ['Usuários e permissões', 'Histórico de atividades', 'Fornecedores', 'Notas de medição', 'Categorias']) confere(!menu.includes(x), `menu mostra "${x}"`);
      for (const x of ['Aprovações e assinaturas', 'Minha assinatura']) confere(menu.includes(x), `menu sem "${x}"`);
    });

    // =============== permissões negativas: API direta ===============
    await passo('API direta: administradora não cria, edita, cancela, reenvia nem dá baixa em pagamentos', async () => {
      const p = await novoPag(obraB, 300);
      const base = { p_obra_id: obraB.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'X', p_valor: 10, p_vencimento: somarDias(hoje, 3), p_forma_pagamento: 'pix' };
      const falhas = {
        criar: await erroDe(hel.rpc('criar_pagamento', base)),
        editar: await erroDe(hel.rpc('atualizar_pagamento', { p_id: p.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'hack', p_valor: 1, p_vencimento: somarDias(hoje, 3), p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null })),
        cancelar: await erroDe(hel.rpc('cancelar_pagamento', { p_id: p.id, p_motivo: 'x' })),
        reenviar: await erroDe(hel.rpc('reenviar_pagamento', { p_id: p.id })),
        baixa: await erroDe(hel.rpc('registrar_baixa', { p_id: p.id, p_pago_em: hoje })),
      };
      for (const [k, v] of Object.entries(falhas)) confere(v, `${k}: devia ser negado`);
      const depois = await pag(p.id);
      confere(depois.valor == 300 && depois.status === 'aguardando_administrador' && depois.versao === 1, 'pagamento foi alterado');
    });
    await passo('API direta: administradora não grava em obras, vínculos, usuários, perfis nem em tabelas de pagamento', async () => {
      const p = await novoPag(obraB, 310);
      const sem = async (nome, q) => { const r = await q; confere(r.error || !(r.data && r.data.length), `${nome}: gravou (${JSON.stringify(r.data)?.slice(0, 80)})`); };
      await sem('obra insert', hel.from('obras').insert({ nome: 'hack', cidade: 'X', uf: 'BA' }).select());
      await sem('obra update', hel.from('obras').update({ nome: 'hack' }).eq('id', obraB.id).select());
      await sem('vínculo insert', hel.from('obra_acessos').insert({ obra_id: obraB.id, user_id: ID.hel }).select());
      await sem('vínculo delete', hel.from('obra_acessos').delete().eq('obra_id', obraA.id).select());
      await sem('perfil próprio -> financeiro', hel.from('profiles').update({ perfil: 'financeiro' }).eq('id', ID.hel).select());
      await sem('perfil de outro', hel.from('profiles').update({ ativo: false }).eq('id', ID.eng).select());
      await sem('pagamento update', hel.from('pagamentos').update({ status: 'pago', valor: 1 }).eq('id', p.id).select());
      await sem('pagamento insert', hel.from('pagamentos').insert({ obra_id: obraB.id, favorecido: 'X', descricao: 'X', valor: 1, vencimento: hoje, fluxo: 'B', status: 'aguardando_pagamento', created_by: ID.hel }).select());
      await sem('pagamento delete', hel.from('pagamentos').delete().eq('id', p.id).select());
      await sem('assinatura insert', hel.from('assinaturas').insert({ pagamento_id: p.id, etapa: 'administrador', decisao: 'aprovado', user_id: ID.hel, user_nome: 'Helena', pagamento_versao: 1, hash_integridade: 'x', conteudo_assinado: {} }).select());
      confere(await erroDe(hel.rpc('criar_perfil_completo', { p_id: crypto.randomUUID(), p_nome: 'x', p_email: `x${stamp}@demo.local`, p_telefone: '', p_perfil: 'financeiro', p_obras: [] })), 'criar_perfil_completo devia ser negado');
      const pg = await pag(p.id);
      confere(pg.status === 'aguardando_administrador' && pg.valor == 310, 'pagamento mudou por API direta');
      const perfilDepois = await dep(admin.from('profiles').select('perfil, ativo').eq('id', ID.hel).single());
      confere(perfilDepois.perfil === 'administrador' && perfilDepois.ativo, 'perfil da administradora foi alterado');
    });
    await passo('API direta: administradora não cria usuário no Auth e não lê e-mail/telefone de outros', async () => {
      const rAuth = await hel.auth.admin.createUser({ email: `hack-${stamp}@demo.local`, password: 'Demo-1234' });
      confere(rAuth.error, 'Auth admin devia recusar a chave publicável');
      const rows = await dep(hel.from('profiles_completo').select('id, email, telefone'));
      confere(rows.every((r) => r.id === ID.hel || (!r.email && !r.telefone)), 'e-mail/telefone de outro usuário visível');
      const { error } = await hel.from('profiles').select('email').limit(1);
      confere(error, 'coluna email de profiles devia estar bloqueada');
    });
    await passo('sem login: tela de aprovações manda para o login e RPC anônima é negada', async () => {
      const ctx = await b.newContext();
      const p = await ctx.newPage();
      await p.goto(BASE + '/aprovacoes'); await p.waitForLoadState('networkidle');
      confere(p.url().includes('/login'), 'não redirecionou ao login: ' + p.url());
      const e = await erroDe(decidirRPC(anon, '00000000-0000-0000-0000-000000000000', 1));
      confere(e, 'RPC anônima devia falhar');
      const r = await anon.from('pagamentos').select('id').limit(1);
      confere(!r.data?.length, 'anônimo leu pagamentos');
      await ctx.close();
    });

    // =============== ordem do fluxo ===============
    await passo('aprovar fora de ordem: aguardando engenheiro não aparece para ela e a RPC recusa', async () => {
      const p = await novoPag(obraA, 1200);
      await ir(helena, '/aprovacoes');
      confere(!(await helena.textContent('main')).includes(p.desc), 'item da etapa do engenheiro apareceu para a administradora');
      const e = await erroDe(decidirRPC(hel, p.id, 1));
      confere(e && /não está aguardando a sua assinatura/.test(e), 'mensagem: ' + e);
      const e2 = await erroDe(decidirRPC(hel, p.id, 1, 'rejeitado', 'fora de ordem'));
      confere(e2 && /não está aguardando/.test(e2), 'rejeitar fora de ordem: ' + e2);
      confere((await pag(p.id)).status === 'aguardando_engenheiro' && (await assin(p.id)).length === 0, 'estado mudou');
      await ir(helena, `/pagamentos/${p.id}`);
      confere(!(await helena.$('input[name=conferi]')), 'formulário de assinatura apareceu fora da etapa dela');
    });
    await passo('fluxo A completo: engenheiro → administradora (tela) → financeiro paga; assinaturas, hash, auditoria e avisos', async () => {
      const p = await novoPag(obraA, 2345.67);
      await engAssina(p.id);
      confere((await pag(p.id)).status === 'aguardando_administrador', 'não foi para a administradora');
      const antes = await dep(fin.from('notificacoes').select('id').eq('pagamento_id', p.id).eq('titulo', 'Pagamento liberado para pagamento'));
      await assinarNaLista(helena, p.desc);
      await ate(async () => (await pag(p.id)).status === 'aguardando_pagamento');
      const a = await assin(p.id);
      confere(a.length === 2 && a[0].etapa === 'engenheiro' && a[1].etapa === 'administrador', 'assinaturas: ' + a.map((x) => x.etapa));
      confere(a.every((x) => x.decisao === 'aprovado' && x.pagamento_versao === 1 && /^[0-9a-f]{64}$/.test(x.hash_integridade)), 'dados da assinatura');
      confere(a[1].user_id === ID.hel && a[1].user_nome && /Mozilla|Headless/i.test(a[1].user_agent ?? ''), 'assinatura sem usuário/navegador');
      const au = await audit(p.id);
      confere(au.some((x) => x.acao === 'assinou' && /administrador/.test(x.descricao) && x.user_id === ID.hel), 'auditoria sem a assinatura dela');
      const nots = await dep(fin.from('notificacoes').select('id, titulo').eq('pagamento_id', p.id).eq('titulo', 'Pagamento liberado para pagamento'));
      confere(nots.length === antes.length + 1, 'financeiro não foi avisado');
      await dep(fin.rpc('registrar_baixa', { p_id: p.id, p_pago_em: hoje })).catch((e) => { throw e; });
      confere((await pag(p.id)).status === 'pago', 'baixa não concluiu');
      await ir(helena, `/pagamentos/${p.id}`);
      const t = await helena.textContent('main');
      confere(/Pago/.test(t) && /Assinado/.test(t), 'tela do pagamento pago não mostra Pago/Assinado');
      confere(!(await helena.$('input[name=conferi]')), 'formulário de assinatura em pagamento pago');
      const e = await erroDe(decidirRPC(hel, p.id, 1));
      confere(e, 'assinou pagamento já pago');
    });
    await passo('fluxo B: obra só com administradora recebe direto na etapa dela, sem engenheiro', async () => {
      const p = await novoPag(obraB, 880);
      confere((await pag(p.id)).status === 'aguardando_administrador', 'fluxo B devia ir direto à administradora');
      await assinarNaLista(helena, p.desc);
      await ate(async () => (await pag(p.id)).status === 'aguardando_pagamento');
      const a = await assin(p.id);
      confere(a.length === 1 && a[0].etapa === 'administrador', 'só a etapa da administradora devia existir');
    });
    await passo('fluxo C: pagamento vai direto ao financeiro e não pede nada à administradora', async () => {
      const p = await novoPag(obraC, 150);
      confere((await pag(p.id)).status === 'aguardando_pagamento', 'fluxo C devia ir direto ao financeiro');
      const pend = await dep(hel.rpc('minhas_pendencias'));
      confere(!pend.some((x) => x.id === p.id), 'pendência no fluxo C');
    });

    // =============== senha, confirmação e campos obrigatórios ===============
    await passo('senha errada na assinatura: mostra "Senha incorreta." e nada é assinado', async () => {
      const p = await novoPag(obraB, 410);
      await assinarNaLista(helena, p.desc, { senha: 'Errada-999' });
      await helena.getByText('Senha incorreta.').waitFor({ timeout: 15000 });
      confere((await pag(p.id)).status === 'aguardando_administrador' && (await assin(p.id)).length === 0, 'assinou com senha errada');
      await helena.keyboard.press('Escape');
    });
    await passo('assinar sem marcar "conferi" é bloqueado e nada é assinado', async () => {
      const p = await novoPag(obraB, 420);
      await marcarItens(helena, [p.desc]);
      await preencher(helena, { conferi: false });
      await dormir(800);
      confere(await helena.locator('[role=dialog] input[name=conferi]:invalid').count() === 1, 'campo conferi devia estar inválido');
      confere((await assin(p.id)).length === 0 && (await pag(p.id)).status === 'aguardando_administrador', 'assinou sem conferir');
      await helena.keyboard.press('Escape');
    });
    await passo('rejeitar sem motivo é bloqueado na tela e na API', async () => {
      const p = await novoPag(obraB, 430);
      await marcarItens(helena, [p.desc]);
      await preencher(helena, { rejeitar: true });
      await dormir(800);
      confere(await helena.locator('[role=dialog] textarea[name=comentario]:invalid').count() === 1, 'motivo devia ser obrigatório');
      confere((await pag(p.id)).status === 'aguardando_administrador', 'rejeitou sem motivo');
      const e = await erroDe(decidirRPC(hel, p.id, 1, 'rejeitado', '   '));
      confere(e && /motivo/i.test(e), 'API: ' + e);
      await helena.keyboard.press('Escape');
    });
    await passo('clique duplo em "Assinar e aprovar" gera uma só assinatura', async () => {
      const p = await novoPag(obraB, 440);
      await marcarItens(helena, [p.desc]);
      await preencher(helena, { enviar: false });
      await helena.locator('[role=dialog] button[type=submit]').dblclick();
      await ate(async () => (await pag(p.id)).status === 'aguardando_pagamento');
      await dormir(800);
      confere((await assin(p.id)).length === 1, 'assinatura duplicada: ' + (await assin(p.id)).length);
    });
    await passo('assinatura duplicada: reassinar e duas chamadas simultâneas só valem uma vez', async () => {
      const p = await novoPag(obraB, 450);
      const [r1, r2] = await Promise.all([decidirRPC(hel, p.id, 1), decidirRPC(hel, p.id, 1)]);
      confere([r1, r2].filter((r) => !r.error).length === 1, 'esperava exatamente 1 sucesso: ' + [r1.error?.message, r2.error?.message]);
      const e = await erroDe(decidirRPC(hel, p.id, 1));
      confere(e, 'reassinar devia falhar');
      confere((await assin(p.id)).length === 1, 'mais de uma assinatura registrada');
    });

    // =============== rejeição e reenvio ===============
    await passo('rejeição na tela do pagamento: motivo, avisos ao criador e ao financeiro, reenvio gera v2 e cadeia nova', async () => {
      const p = await novoPag(obraA, 1750);
      await engAssina(p.id);
      await ir(helena, `/pagamentos/${p.id}`);
      const f = helena.locator('form:has(input[name=conferi])');
      await f.locator('label:has-text("Rejeitar") input').check();
      await f.locator('textarea[name=comentario]').fill('Valor divergente da proposta');
      await f.locator('input[name=conferi]').check();
      await f.locator('input[name=senha]').fill(SENHA);
      await f.locator('button[type=submit]').click();
      await helena.getByText(/Rejeição registrada/).waitFor({ timeout: 20000 });
      const r = await pag(p.id);
      confere(r.status === 'rejeitado' && r.rejeicao_motivo === 'Valor divergente da proposta', 'status/motivo: ' + r.status);
      const ns = await dep(admin.from('notificacoes').select('user_id, titulo, mensagem').eq('pagamento_id', p.id).eq('titulo', 'Pagamento rejeitado'));
      confere(ns.some((x) => x.user_id === ID.fin && /Valor divergente/.test(x.mensagem)), 'criador/financeiro não foi avisado com o motivo');
      await ir(helena, '/aprovacoes');
      confere(!(await helena.textContent('main')).includes(p.desc), 'rejeitado continua na fila');
      confere(await erroDe(decidirRPC(hel, p.id, 1)), 'assinou rejeitado');
      const eR = await erroDe(hel.rpc('reenviar_pagamento', { p_id: p.id }));
      confere(eR, 'administradora não pode reenviar');
      await dep(fin.rpc('reenviar_pagamento', { p_id: p.id, p_observacao: 'Valor conferido' }));
      const r2 = await pag(p.id);
      confere(r2.versao === 2 && r2.status === 'aguardando_engenheiro' && r2.rejeicao_motivo === null, 'reenvio: ' + r2.status + ' v' + r2.versao);
      confere(await erroDe(decidirRPC(hel, p.id, 2)), 'administradora pulou o engenheiro após reenvio');
      await engAssina(p.id);
      await assinarNaLista(helena, p.desc);
      await ate(async () => (await pag(p.id)).status === 'aguardando_pagamento');
      const a = await assin(p.id);
      confere(a.length === 4 && a[1].decisao === 'rejeitado' && a[1].pagamento_versao === 1 && a[3].decisao === 'aprovado' && a[3].pagamento_versao === 2, 'histórico de assinaturas: ' + a.map((x) => `${x.etapa}:${x.decisao}:v${x.pagamento_versao}`));
      const t = (await ir(helena, `/pagamentos/${p.id}`), await helena.textContent('main'));
      confere(/Rejeitado/.test(t) && /\(anterior\)/.test(t), 'tela não preserva a rejeição anterior');
    });

    // =============== valor alterado depois de assinar ===============
    await passo('valor alterado após assinatura do engenheiro reinicia o fluxo; versão antiga não vale mais', async () => {
      const p = await novoPag(obraA, 1000);
      await engAssina(p.id);
      const e0 = await erroDe(upd(p.id, { descricao: p.desc, valor: 1500 }));
      confere(!e0, 'financeiro não conseguiu editar: ' + e0);
      const r = await pag(p.id);
      confere(r.versao === 2 && r.status === 'aguardando_engenheiro' && Number(r.valor) === 1500, `esperava v2/aguardando_engenheiro: ${r.status} v${r.versao}`);
      confere((await audit(p.id)).some((x) => x.acao === 'fluxo_reiniciado'), 'auditoria sem fluxo_reiniciado');
      confere(await erroDe(decidirRPC(hel, p.id, 1)), 'administradora assinou pela versão antiga');
      await engAssina(p.id);
      const e1 = await erroDe(decidirRPC(hel, p.id, 1));
      confere(e1 && /alterado depois|versão atual/.test(e1), 'versão 1 devia ser recusada: ' + e1);
      await assinarNaLista(helena, p.desc);
      await ate(async () => (await pag(p.id)).status === 'aguardando_pagamento');
      const a = await assin(p.id);
      confere(a.filter((x) => x.pagamento_versao === 2).length === 2 && a[0].hash_integridade !== a.find((x) => x.pagamento_versao === 2 && x.etapa === 'engenheiro').hash_integridade, 'hash devia mudar com o valor');
    });
    await passo('valor alterado depois da assinatura final (liberado p/ pagamento): exige motivo, fica na auditoria e avisa a administradora que aprovou', async () => {
      const p = await novoPag(obraB, 600);
      await dep(decidirRPC(hel, p.id, 1));
      confere((await pag(p.id)).status === 'aguardando_pagamento', 'não liberou');
      const semMotivo = await erroDe(fin.rpc('atualizar_pagamento', { p_id: p.id, p_fornecedor_id: null, p_favorecido: 'Fornecedor Helena', p_descricao: p.desc, p_valor: 650, p_vencimento: somarDias(hoje, 7), p_forma_pagamento: 'boleto', p_numero_documento: null, p_observacoes: null, p_motivo: '' }));
      confere(semMotivo && /motivo/i.test(semMotivo), 'alterar pagamento liberado sem motivo devia ser bloqueado: ' + semMotivo);
      await dep(upd(p.id, { descricao: p.desc, valor: 650, motivo: 'reajuste combinado' }));
      confere((await audit(p.id)).some((x) => x.acao === 'alterou' && /reajuste combinado/.test(x.descricao)), 'auditoria sem a alteração');
      const av = await dep(admin.from('notificacoes').select('titulo, mensagem').eq('pagamento_id', p.id).eq('user_id', ID.hel).eq('titulo', 'Valor alterado após a sua aprovação'));
      confere(av.length === 1 && /600,00/.test(av[0].mensagem) && /650,00/.test(av[0].mensagem), 'administradora não foi avisada do novo valor');
    });
    await passo('decisão do produto: valor alterado depois da assinatura final NÃO reinicia o fluxo (só avisa quem aprovou); a baixa segue liberada e a mudança fica na auditoria', async () => {
      const p = await novoPag(obraB, 600);
      await dep(decidirRPC(hel, p.id, 1));
      await dep(upd(p.id, { descricao: p.desc, valor: 6000, motivo: 'valor alterado após assinatura' }));
      const r = await pag(p.id);
      confere(r.status === 'aguardando_pagamento' && Number(r.valor) === 6000, `esperado liberado com o valor novo; veio "${r.status}" / ${r.valor}`);
      const av = await dep(admin.from('notificacoes').select('mensagem').eq('pagamento_id', p.id).eq('user_id', ID.hel).eq('titulo', 'Valor alterado após a sua aprovação'));
      confere(av.length === 1 && /6\.000,00/.test(av[0].mensagem), 'a administradora que aprovou não foi avisada do novo valor');
      confere((await audit(p.id)).some((x) => x.acao === 'alterou' && /valor alterado após assinatura/.test(x.descricao)), 'a alteração não ficou na auditoria');
    });
    await passo('só observação alterada não reinicia o fluxo nem muda a versão', async () => {
      const p = await novoPag(obraB, 333);
      await dep(upd(p.id, { descricao: p.desc, valor: 333, obs: 'apenas uma observação' }));
      const r = await pag(p.id);
      confere(r.versao === 1 && r.status === 'aguardando_administrador', `não devia reiniciar: ${r.status} v${r.versao}`);
    });
    await passo('janela de assinatura aberta e valor alterado por outro: assinatura recusada com aviso na tela', async () => {
      const p = await novoPag(obraB, 700);
      await marcarItens(helena, [p.desc]);
      await dep(decidirRPC(hel, p.id, 1)); // simula a etapa já concluída por outra aba
      await dep(upd(p.id, { descricao: p.desc, valor: 777 })); // valor muda: v2, reinicia
      await preencher(helena);
      await helena.locator('[role=dialog]').getByText(/não está aguardando|foi alterado/).waitFor({ timeout: 15000 });
      const a = (await assin(p.id)).filter((x) => x.pagamento_versao === 2);
      confere(a.length === 0, 'assinou a versão nova sem conferir');
      await helena.keyboard.press('Escape');
    });

    // =============== lote ===============
    await passo('lote atômico: um item com versão velha faz nenhum ser assinado; lote correto assina todos com o mesmo lote', async () => {
      const p1 = await novoPag(obraB, 101);
      const p2 = await novoPag(obraB, 102);
      const { error } = await hel.rpc('decidir_aprovacao', { p_itens: [{ id: p1.id, versao: 1 }, { id: p2.id, versao: 99 }], p_decisao: 'aprovado' });
      confere(error && /alterado|versão/.test(error.message), 'lote com versão errada devia falhar: ' + error?.message);
      confere((await pag(p1.id)).status === 'aguardando_administrador' && (await assin(p1.id)).length === 0, 'item 1 foi assinado apesar do erro no lote');
      await marcarItens(helena, [p1.desc, p2.desc]);
      await preencher(helena);
      await ate(async () => (await pag(p1.id)).status === 'aguardando_pagamento' && (await pag(p2.id)).status === 'aguardando_pagamento');
      const [a1] = await assin(p1.id); const [a2] = await assin(p2.id);
      confere(a1.lote_id && a1.lote_id === a2.lote_id && a1.hash_integridade !== a2.hash_integridade, 'registro por documento com o mesmo lote');
      confere((await audit(p1.id)).some((x) => /assinatura em lote/.test(x.descricao ?? '')), 'auditoria sem marca de lote');
    });

    // =============== vínculos ===============
    await passo('outra administradora: sem vínculo não vê; com vínculo extra só vê (não assina); sem vínculo some', async () => {
      const p = await novoPag(obraB, 222);
      confere(!(await dep(adm2.from('obras').select('id').eq('id', obraB.id))).length, 'viu a obra sem vínculo');
      confere((await erroDe(decidirRPC(adm2, p.id, 1)))?.includes('não encontrado'), 'assinou/enxergou sem vínculo');
      await dep(fin.from('obra_acessos').insert({ obra_id: obraB.id, user_id: ID.adm2 }).select());
      try {
        confere((await dep(adm2.from('pagamentos').select('id').eq('id', p.id))).length === 1, 'vínculo não deu visão');
        const e = await erroDe(decidirRPC(adm2, p.id, 1));
        confere(e && /não está aguardando a sua assinatura/.test(e), 'vínculo extra não pode assinar: ' + e);
        const pend = await dep(adm2.rpc('minhas_pendencias'));
        confere(!pend.some((x) => x.id === p.id), 'pendência para quem só tem vínculo');
        confere((await dep(adm2.from('auditoria').select('id').eq('pagamento_id', p.id))).length > 0, 'vínculo não vê a linha do tempo');
      } finally {
        await dep(fin.from('obra_acessos').delete().eq('obra_id', obraB.id).eq('user_id', ID.adm2).select());
      }
      confere(!(await dep(adm2.from('pagamentos').select('id').eq('id', p.id))).length, 'ainda vê após remover o vínculo');
      confere((await assin(p.id)).length === 0, 'foi assinado');
    });

    // =============== notificações ===============
    await passo('sino: contador de não lidas, clique abre o pagamento e marca como lida, "Marcar todas" zera', async () => {
      const p = await novoPag(obraB, 515);
      await ir(helena, '/');
      const rot = await helena.getAttribute('a[href="/notificacoes"]', 'aria-label');
      const m = rot.match(/\((\d+) não lidas\)/);
      confere(m && Number(m[1]) >= 1, 'sino sem contador: ' + rot);
      const naoLidasDb = (await dep(admin.from('notificacoes').select('id').eq('user_id', ID.hel).is('lida_em', null))).length;
      confere(Number(m[1]) === naoLidasDb, `contador ${m[1]} ≠ banco ${naoLidasDb}`);
      await ir(helena, '/notificacoes');
      const item = helena.locator('main li a', { hasText: 'Documento aguardando sua assinatura' }).filter({ hasText: 'Fornecedor Helena' }).first();
      const href = await item.getAttribute('href');
      // O servidor monta o destino a partir de request.url (host do servidor, não o do navegador): confere só o caminho.
      const resp = await helena.context().request.get(BASE + href, { maxRedirects: 0 });
      confere(resp.status() === 303 && new URL(resp.headers().location).pathname.startsWith('/pagamentos/'), `redirecionamento do aviso: ${resp.status()} ${resp.headers().location}`);
      const nid = href.split('/').pop();
      confere((await dep(admin.from('notificacoes').select('lida_em').eq('id', nid).single())).lida_em, 'clique não marcou como lida');
      await ir(helena, '/notificacoes');
      const botao = helena.locator('button:has-text("Marcar todas como lidas")');
      if (await botao.count()) { await botao.click(); await ate(async () => !(await dep(admin.from('notificacoes').select('id').eq('user_id', ID.hel).is('lida_em', null))).length); }
      await ir(helena, '/notificacoes');
      confere((await helena.textContent('main')).includes('Tudo em dia'), 'não zerou as não lidas');
      const vazamento = await dep(hel.from('notificacoes').select('user_id'));
      confere(vazamento.every((x) => x.user_id === ID.hel), 'enxerga notificações de outro usuário');
      { const r = await hel.from('notificacoes').update({ lida_em: null }).eq('user_id', ID.eng).select(); confere(r.error || !r.data?.length, 'alterou notificação alheia'); }
      confere(await erroDe(hel.from('notificacoes').insert({ user_id: ID.hel, titulo: 'x' })), 'inseriu notificação direto');
      await dep(decidirRPC(hel, p.id, 1));
    });
    await passo('uma notificação por evento: engenheiro assina e a administradora recebe um único aviso', async () => {
      const p = await novoPag(obraA, 616);
      await engAssina(p.id);
      const ns = await dep(admin.from('notificacoes').select('id, titulo, whatsapp_status, email_status').eq('pagamento_id', p.id).eq('user_id', ID.hel));
      confere(ns.length === 1 && ns[0].titulo === 'Documento aguardando sua assinatura', 'avisos da administradora: ' + ns.length);
      confere(ns[0].whatsapp_status === 'pendente' && ns[0].email_status === 'pendente', `fila: wpp=${ns[0].whatsapp_status} email=${ns[0].email_status}`);
      await dep(decidirRPC(hel, p.id, 1));
    });
    await passo('cron: sem segredo ou com segredo errado responde 401; com segredo envia e-mail e WhatsApp e não reenvia', async () => {
      for (const rota of ['/api/cron/email', '/api/cron/whatsapp']) {
        const sem = await fetch(BASE + rota); confere(sem.status === 401, `${rota} sem segredo: ${sem.status}`);
        const errado = await fetch(BASE + rota, { headers: { authorization: 'Bearer errado' } }); confere(errado.status === 401, `${rota} segredo errado: ${errado.status}`);
      }
      const p = await novoPag(obraA, 717);
      await engAssina(p.id);
      const recebidos = { email: [], wpp: [] };
      const sobe = (porta, lista) => new Promise((res) => {
        const s = http.createServer((req, rs) => { let c = ''; req.on('data', (d) => (c += d)); req.on('end', () => { try { lista.push(JSON.parse(c || '{}')); } catch { /* ignora */ } rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"id":"t"}'); }); });
        s.on('error', () => res(null)); s.listen(porta, '127.0.0.1', () => res(s));
      });
      const sEmail = await sobe(4556, recebidos.email); const sWpp = await sobe(4555, recebidos.wpp);
      try {
        const minha = () => dep(admin.from('notificacoes').select('email_status, whatsapp_status').eq('pagamento_id', p.id).eq('user_id', ID.hel).single());
        let ultimo;
        for (let i = 0; i < 12; i++) {
          for (const rota of ['/api/cron/email', '/api/cron/whatsapp']) {
            const r = await fetch(BASE + rota, { headers: { authorization: `Bearer ${SEGREDO}` } }); ultimo = await r.json();
            confere(ultimo.configurado === true, `${rota} não configurado no servidor: ${JSON.stringify(ultimo)}`);
          }
          const m = await minha(); if (m.email_status === 'enviado' && m.whatsapp_status === 'enviado') break; await dormir(500);
        }
        const m = await minha();
        confere(m.email_status === 'enviado' && m.whatsapp_status === 'enviado', `fila não foi entregue: ${JSON.stringify(m)}`);
        if (sEmail) { const e = recebidos.email.find((x) => x.to?.[0] === 'administrador@demo.local' && /Documento aguardando/.test(x.subject) && (x.text ?? '').includes(p.id)); confere(e, 'e-mail da administradora não chegou ao Resend simulado com o link do pagamento'); }
        if (sWpp) { const w = recebidos.wpp.find((x) => x.to === '5571999990004' && JSON.stringify(x).includes(p.id)); confere(w, 'WhatsApp da administradora: ' + JSON.stringify(w)?.slice(0, 120)); }
        const antes = recebidos.email.length + recebidos.wpp.length;
        for (const rota of ['/api/cron/email', '/api/cron/whatsapp']) await fetch(BASE + rota, { headers: { authorization: `Bearer ${SEGREDO}` } });
        await dormir(500);
        const m2 = await minha();
        confere(m2.email_status === 'enviado' && m2.whatsapp_status === 'enviado' && !recebidos.email.concat(recebidos.wpp).slice(antes).some((x) => JSON.stringify(x).includes(p.id)), 'reenviou o mesmo aviso');
        return `e-mail via ${sEmail ? 'simulado local' : 'outro simulador'}, WhatsApp via ${sWpp ? 'simulado local' : 'outro simulador'}`;
      } finally { sEmail?.close(); sWpp?.close(); }
    });

    // =============== auditoria ===============
    await passo('auditoria imutável: ninguém altera, apaga nem trunca (nem a chave administrativa); ela só vê a linha do tempo dos pagamentos dela', async () => {
      const p = await novoPag(obraB, 818);
      await dep(decidirRPC(hel, p.id, 1));
      const alvo = (await audit(p.id))[0];
      for (const [nome, q] of [
        ['update chave admin', admin.from('auditoria').update({ descricao: 'x' }).eq('id', alvo.id).select()],
        ['delete chave admin', admin.from('auditoria').delete().eq('id', alvo.id).select()],
        ['update administradora', hel.from('auditoria').update({ descricao: 'x' }).eq('id', alvo.id).select()],
        ['delete financeiro', fin.from('auditoria').delete().eq('id', alvo.id).select()],
        ['insert administradora', hel.from('auditoria').insert({ entidade: 'x', acao: 'x', descricao: 'forjado' }).select()],
        ['update assinatura (chave admin)', admin.from('assinaturas').update({ decisao: 'rejeitado' }).eq('pagamento_id', p.id).select()],
        ['delete assinatura (chave admin)', admin.from('assinaturas').delete().eq('pagamento_id', p.id).select()],
      ]) { const r = await q; confere(r.error || !r.data?.length, `${nome}: conseguiu alterar`); }
      const igual = await dep(admin.from('auditoria').select('descricao').eq('id', alvo.id).single());
      confere(igual.descricao === alvo.descricao, 'descrição mudou');
      const vistos = await dep(hel.from('auditoria').select('entidade, pagamento_id'));
      confere(vistos.every((x) => x.pagamento_id), 'vê auditoria que não é de pagamento (cadastros, usuários)');
      await ir(helena, `/pagamentos/${p.id}`);
      const t = await helena.textContent('main');
      confere(/Linha do tempo/.test(t) && /assin/i.test(t), 'linha do tempo sem a assinatura');
    });

    await passo('pagamento cancelado não pode ser assinado nem reaberto pela administradora', async () => {
      const p = await novoPag(obraB, 919);
      await dep(fin.rpc('cancelar_pagamento', { p_id: p.id, p_motivo: 'cancelado no teste' }));
      confere(await erroDe(decidirRPC(hel, p.id, 1)), 'assinou cancelado');
      await ir(helena, '/aprovacoes');
      confere(!(await helena.textContent('main')).includes(p.desc), 'cancelado na fila');
    });

    // =============== celular 390px ===============
    await passo('celular 390px: aprovações, notificações e pagamento sem rolagem lateral', async () => {
      const m = await entrar('administrador', 390);
      const p = await novoPag(obraB, 1111);
      for (const rota of ['/', '/aprovacoes', '/notificacoes', '/obras', `/pagamentos/${p.id}`]) {
        await ir(m, rota);
        confere(await larguraOk(m), `rolagem lateral em ${rota}`);
      }
      confere(await m.locator('a[href="/notificacoes"]').isVisible(), 'sino não visível no celular');
      await m.context().close();
    });
    await passo('celular 390px: janela de assinatura cabe na tela e assina (lote de 2)', async () => {
      const m = await entrar('administrador', 390);
      const p1 = await novoPag(obraB, 1211); const p2 = await novoPag(obraB, 1212);
      await marcarItens(m, [p1.desc, p2.desc]);
      const caixa = await m.locator('[role=dialog] > div').first().boundingBox();
      const vp = m.viewportSize();
      confere(caixa.x >= 0 && caixa.x + caixa.width <= vp.width + 1 && caixa.y >= 0 && caixa.y + caixa.height <= vp.height + 1, `janela fora da tela: ${JSON.stringify(caixa)}`);
      const sobra = await m.evaluate(() => { const d = document.querySelector('[role=dialog] > div'); return d.scrollWidth - d.clientWidth; });
      confere(sobra <= 1, 'janela com rolagem lateral: ' + sobra);
      const botao = m.locator('[role=dialog] button[type=submit]'); await botao.scrollIntoViewIfNeeded();
      const bb = await botao.boundingBox(); confere(bb.x >= 0 && bb.x + bb.width <= vp.width, 'botão cortado');
      await preencher(m);
      await ate(async () => (await pag(p1.id)).status === 'aguardando_pagamento' && (await pag(p2.id)).status === 'aguardando_pagamento');
      await m.context().close();
    });
    await passo('celular 390px: rejeição pela tela do pagamento', async () => {
      const m = await entrar('administrador', 390);
      const p = await novoPag(obraB, 1311);
      await ir(m, `/pagamentos/${p.id}`);
      const f = m.locator('form:has(input[name=conferi])');
      await f.locator('label:has-text("Rejeitar") input').check();
      await f.locator('textarea[name=comentario]').fill('Sem nota fiscal');
      await f.locator('input[name=conferi]').check();
      await f.locator('input[name=senha]').fill(SENHA);
      await f.locator('button[type=submit]').click();
      await ate(async () => (await pag(p.id)).status === 'rejeitado');
      confere(await larguraOk(m), 'rolagem lateral após rejeitar');
      await m.context().close();
    });

    await passo('limpeza: cancela o que ficou aberto e encerra as obras de teste', async () => {
      for (const pid of criados) {
        const p = await admin.from('pagamentos').select('status').eq('id', pid).single();
        if (p.data && ['aguardando_engenheiro', 'aguardando_administrador', 'aguardando_pagamento', 'rejeitado'].includes(p.data.status)) await fin.rpc('cancelar_pagamento', { p_id: pid, p_motivo: 'limpeza do teste da persona' });
      }
      for (const o of [obraA, obraB, obraC, obraX]) await dep(fin.from('obras').update({ status: 'concluida' }).eq('id', o.id).select());
    });
  });
})().catch((e) => { console.error('✘ interrompido:', e.message.slice(0, 400)); process.exit(1); });
