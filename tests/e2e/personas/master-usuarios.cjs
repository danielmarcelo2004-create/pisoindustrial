// Persona: "Rui", administrador master, e a gestão de usuários/perfis/vínculos feita pelo Financeiro (única área
// que pode criar e alterar usuários: ver README e src/app/(app)/usuarios/actions.ts).
// Cobre: master vê todas as obras e assina só onde é o administrador responsável; dá baixa em qualquer obra; não cria obra,
// despesa nem usuário (tela e API); criação de usuário com senha provisória; troca obrigatória no 1º acesso; senha
// provisória nova; desativar/reativar (login, sessão aberta, token antigo, avisos, obra órfã); perfis e vínculos obra x usuário;
// auditoria (tela do Financeiro e imutabilidade); celular 390px.
// Dados fictícios (marca). Não recria o banco. Usuários criados aqui são apagados (ou, se houver histórico, ficam desativados).
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

const ate = async (fn, ms = 20000) => {
  const fim = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição'); await new Promise((r) => setTimeout(r, 300)); }
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const erroDe = async (q) => { const r = await q; return r.error ? r.error.message : null; };
const dep = async (q) => { const r = await q; if (r.error) throw new Error(r.error.message); return r.data; };
const semEfeito = async (nome, q) => { const r = await q; confere(r.error || !(r.data && r.data.length), `${nome}: gravou (${JSON.stringify(r.data)?.slice(0, 80)})`); };
async function clienteEmail(email, senha) {
  const c = createClient(SUPA, PUB, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: senha });
  if (error) throw new Error(error.message);
  return c;
}

(async () => {
  const stamp = marca('Rui');
  let n = 0;
  const desc = (t = '') => `${stamp} [${String(++n).padStart(2, '0')}] ${t}`.trim();
  const fin = await cliente('financeiro');
  const eng = await cliente('engenheiro');
  const hel = await cliente('administrador');
  const perfis = await dep(admin.from('profiles').select('id, email'));
  const id = (e) => perfis.find((x) => x.email === `${e}@demo.local`).id;
  const ID = { hel: id('administrador'), eng: id('engenheiro'), fin: id('financeiro') };

  // ---- Rui: administrador master de teste (e-mail único; o e-mail do seed de demonstração não existe neste banco)
  const login = `rui-${Date.now() % 1000000}`;
  const { data: cr, error: ecr } = await admin.auth.admin.createUser({ email: `${login}@demo.local`, password: SENHA, email_confirm: true });
  if (ecr) throw new Error(ecr.message);
  const RUI = cr.user.id;
  await dep(admin.from('profiles').insert({ id: RUI, nome: `Rui Master ${stamp}`, email: `${login}@demo.local`, perfil: 'administrador_master', troca_senha_pendente: false }));
  const rui = await cliente(login);
  const usuariosCriados = [RUI];

  const mkObra = async (nome, fluxo, o = {}) => dep(fin.from('obras').insert({ nome: `${stamp} ${nome}`, cidade: 'Salvador', uf: 'BA', fluxo, ...o }).select().single());
  const obraM = await mkObra('Obra do Rui A', 'A', { engenheiro_id: ID.eng, administrador_id: RUI });
  const obraM2 = await mkObra('Obra do Rui B', 'B', { administrador_id: RUI });
  const obraH = await mkObra('Obra da Helena', 'B', { administrador_id: ID.hel });
  const obraC = await mkObra('Obra sem aprovadores', 'C');
  const obras = [obraM, obraM2, obraH, obraC];
  const criados = [];
  const novoPag = async (obra, valor = 1000, d = desc('pag')) => {
    const pid = await dep(fin.rpc('criar_pagamento', { p_obra_id: obra.id, p_fornecedor_id: null, p_favorecido: 'Fornecedor Rui', p_descricao: d, p_valor: valor, p_vencimento: somarDias(hoje, 7), p_forma_pagamento: 'boleto' }));
    criados.push(pid);
    return { id: pid, desc: d };
  };
  const pag = async (pid) => dep(admin.from('pagamentos').select('*').eq('id', pid).single());
  const assin = async (pid) => dep(admin.from('assinaturas').select('*').eq('pagamento_id', pid).order('created_at'));
  const decidirRPC = (cli, pid, versao, decisao = 'aprovado', comentario = null) => cli.rpc('decidir_aprovacao', { p_itens: [{ id: pid, versao }], p_decisao: decisao, p_comentario: comentario });
  const engAssina = async (pid) => { const e = await erroDe(decidirRPC(eng, pid, (await pag(pid)).versao)); confere(!e, 'engenheiro não conseguiu assinar: ' + e); };

  // ---- helpers de tela
  async function marcarItens(p, descs) {
    await ir(p, '/aprovacoes');
    for (const d of descs) await p.locator('tr', { hasText: d }).first().locator('input[type=checkbox]').check();
    await p.click('button:has-text("Revisar e assinar selecionados")');
    await p.locator('[role=dialog]').waitFor();
  }
  async function preencher(p, { senha = SENHA, conferi = true, rejeitar = false, motivo = '' } = {}) {
    const f = p.locator('[role=dialog] form');
    if (rejeitar) await f.locator('label:has-text("Rejeitar") input[type=radio]').check();
    if (motivo) await f.locator('textarea[name=comentario]').fill(motivo);
    if (conferi) await f.locator('input[name=conferi]').check();
    await f.locator('input[name=senha]').fill(senha);
    await f.locator('button[type=submit]').click();
  }
  const larguraOk = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  await rodar('Persona Rui (master) e gestão de usuários', async ({ b, passo, entrar }) => {
    const ruiP = await entrar(login);
    const finP = await entrar('financeiro');

    async function entrarComo(email, senha, largura = 1440) {
      const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
      const p = await ctx.newPage();
      await p.goto(BASE + '/login'); await p.fill('input[name=email]', email); await p.fill('input[name=senha]', senha);
      await p.click('button:has-text("Entrar")');
      await p.waitForLoadState('networkidle'); await dormir(800);
      return p;
    }
    // Cria um usuário pela tela do Financeiro; devolve e-mail, senha provisória e id
    async function criarPelaTela({ nome, email, perfil, obrasMarcadas = [], senha }) {
      await ir(finP, '/usuarios/novo');
      await finP.fill('input[name=nome]', nome);
      await finP.fill('input[name=email]', email);
      await finP.selectOption('select[name=perfil]', perfil);
      if (senha !== undefined) await finP.fill('input[name=senha]', senha);
      for (const o of obrasMarcadas) await finP.locator(`label:has-text("${o}") input[type=checkbox]`).check();
      await finP.click('button:has-text("Criar usuário")');
      await finP.locator('dl.font-mono dd').first().waitFor({ timeout: 8000 }).catch(() => {});
      const dd = finP.locator('dl.font-mono dd');
      if (!(await dd.count())) return { erro: (await finP.textContent('main')).replace(/\s+/g, ' ') };
      const [lg, pw] = [await dd.nth(0).textContent(), await dd.nth(1).textContent()];
      const uid = (await finP.getAttribute('a:has-text("Abrir cadastro do usuário")', 'href')).split('/').pop();
      usuariosCriados.push(uid);
      return { email: lg.trim(), senha: pw.trim(), id: uid };
    }
    const perfilDb = async (uid) => dep(admin.from('profiles').select('*').eq('id', uid).single());
    const salvarCadastro = async (uid, ajustar) => {
      await ir(finP, `/usuarios/${uid}`);
      await ajustar();
      await finP.locator('button[type=submit]:text-is("Salvar")').click();
    };

    // =============== master: visão e limites ===============
    await passo('master vê todas as obras (API e tela), mas não aparece o botão de criar centro de custo', async () => {
      const todas = await dep(admin.from('obras').select('id'));
      const vistas = await dep(rui.from('obras').select('id'));
      const vs = new Set(vistas.map((o) => o.id)); confere(todas.every((o) => vs.has(o.id)), `master vê ${vistas.length} de ${todas.length} obras`);
      await ir(ruiP, '/obras');
      const t = await ruiP.textContent('main');
      for (const o of obras) confere(t.includes(o.nome), `tela sem ${o.nome}`);
      confere(!(await ruiP.$('a:has-text("+ Novo centro de custo")')), 'master vê botão de criar obra');
    });
    await passo('master vê pagamento e linha do tempo de obra alheia, mas só da linha do tempo (não a auditoria geral)', async () => {
      const p = await novoPag(obraH, 321);
      confere((await dep(rui.from('pagamentos').select('id').eq('id', p.id))).length === 1, 'master não vê o pagamento da obra da Helena');
      confere((await dep(rui.from('auditoria').select('id').eq('pagamento_id', p.id))).length > 0, 'master sem a linha do tempo');
      const vistos = await dep(rui.from('auditoria').select('pagamento_id'));
      confere(vistos.every((x) => x.pagamento_id), 'master lê auditoria de cadastros/usuários');
      const r = await ruiP.goto(`${BASE}/pagamentos/${p.id}`);
      confere(r.status() === 200, 'tela do pagamento não abriu: ' + r.status());
      confere(!(await ruiP.$('input[name=conferi]')), 'master viu formulário de assinatura em obra da Helena');
    });
    await passo('master não cria obra, despesa, nem altera/cancela/reenvia pagamento (API) e a tela de nova despesa/obra redireciona', async () => {
      const p = await novoPag(obraH, 322);
      const base = { p_obra_id: obraM2.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'X', p_valor: 10, p_vencimento: somarDias(hoje, 3), p_forma_pagamento: 'pix' };
      confere(await erroDe(rui.rpc('criar_pagamento', base)), 'criar_pagamento devia ser negado');
      confere(await erroDe(rui.rpc('cancelar_pagamento', { p_id: p.id, p_motivo: 'x' })), 'cancelar devia ser negado');
      confere(await erroDe(rui.rpc('reenviar_pagamento', { p_id: p.id })), 'reenviar devia ser negado');
      confere(await erroDe(rui.rpc('atualizar_pagamento', { p_id: p.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'hack', p_valor: 1, p_vencimento: somarDias(hoje, 3), p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null })), 'atualizar devia ser negado');
      await semEfeito('obra insert', rui.from('obras').insert({ nome: 'hack', cidade: 'X', uf: 'BA' }).select());
      await semEfeito('obra update', rui.from('obras').update({ nome: 'hack' }).eq('id', obraM.id).select());
      for (const rota of ['/obras/nova', '/pagamentos/novo']) {
        await ruiP.goto(BASE + rota); await ruiP.waitForLoadState('networkidle');
        confere(ruiP.url().includes('sem-permissao=1'), `${rota} abriu para o master: ${ruiP.url()}`);
      }
    });
    await passo('master não gerencia usuários nem vínculos: telas redirecionam e API recusa (profiles, perfil_completo, vínculos, Auth)', async () => {
      for (const rota of ['/usuarios', '/usuarios/novo', `/usuarios/${ID.eng}`]) {
        await ruiP.goto(BASE + rota); await ruiP.waitForLoadState('networkidle');
        confere(ruiP.url().includes('sem-permissao=1'), `${rota} abriu para o master: ${ruiP.url()}`);
      }
      const menu = await ruiP.locator('nav').first().textContent();
      confere(!menu.includes('Usuários e permissões'), 'menu do master mostra Usuários e permissões');
      await semEfeito('perfil do engenheiro', rui.from('profiles').update({ perfil: 'financeiro' }).eq('id', ID.eng).select());
      await semEfeito('perfil próprio', rui.from('profiles').update({ ativo: false }).eq('id', RUI).select());
      await semEfeito('vínculo', rui.from('obra_acessos').insert({ obra_id: obraM.id, user_id: ID.eng }).select());
      confere(await erroDe(rui.rpc('criar_perfil_completo', { p_id: crypto.randomUUID(), p_nome: 'x', p_email: `x${stamp}@demo.local`, p_telefone: '', p_perfil: 'financeiro', p_obras: [] })), 'criar_perfil_completo devia ser negado');
      const rAuth = await rui.auth.admin.createUser({ email: `hack-${stamp}@demo.local`, password: SENHA });
      confere(rAuth.error, 'Auth admin devia recusar a chave publicável');
      const rows = await dep(rui.from('profiles_completo').select('id, email, telefone'));
      confere(rows.every((r) => r.id === RUI || (!r.email && !r.telefone)), 'e-mail/telefone de outros visíveis ao master');
      const e = await dep(admin.from('profiles').select('perfil, ativo').eq('id', RUI).single());
      confere(e.perfil === 'administrador_master' && e.ativo, 'perfil do master foi alterado');
    });
    await passo('master não abre o Histórico de atividades (tela só do Financeiro) nem exclui/edita auditoria', async () => {
      await ruiP.goto(BASE + '/auditoria'); await ruiP.waitForLoadState('networkidle');
      confere(ruiP.url().includes('sem-permissao=1'), 'abriu /auditoria: ' + ruiP.url());
      const alvo = (await dep(admin.from('auditoria').select('id, descricao').order('id', { ascending: false }).limit(1)))[0];
      await semEfeito('update', rui.from('auditoria').update({ descricao: 'x' }).eq('id', alvo.id).select());
      await semEfeito('delete', rui.from('auditoria').delete().eq('id', alvo.id).select());
    });

    // =============== master assina onde é o administrador ===============
    await passo('master assina só a etapa dele: fora de ordem e obra de outro administrador são recusados', async () => {
      const pM = await novoPag(obraM, 900);
      await ir(ruiP, '/aprovacoes');
      confere(!(await ruiP.textContent('main')).includes(pM.desc), 'etapa do engenheiro apareceu para o master');
      const e1 = await erroDe(decidirRPC(rui, pM.id, 1));
      confere(e1 && /não está aguardando a sua assinatura/.test(e1), 'fora de ordem: ' + e1);
      const pH = await novoPag(obraH, 901);
      const e2 = await erroDe(decidirRPC(rui, pH.id, 1));
      confere(e2 && /não está aguardando a sua assinatura/.test(e2), 'obra da Helena (master não é o responsável): ' + e2);
      await ir(ruiP, '/aprovacoes');
      confere(!(await ruiP.textContent('main')).includes(pH.desc), 'pagamento da Helena na fila do master');
      confere((await assin(pM.id)).length + (await assin(pH.id)).length === 0, 'houve assinatura indevida');
    });
    await passo('fluxo A com master: engenheiro → master (tela, senha) → financeiro; master é avisado por sino e fila de e-mail', async () => {
      const p = await novoPag(obraM, 1500.5);
      await engAssina(p.id);
      const av = await dep(admin.from('notificacoes').select('titulo, email_status, whatsapp_status').eq('pagamento_id', p.id).eq('user_id', RUI));
      confere(av.length === 1 && av[0].titulo === 'Documento aguardando sua assinatura' && av[0].email_status === 'pendente', 'aviso do master: ' + JSON.stringify(av));
      confere(av[0].whatsapp_status === null, 'sem telefone não devia haver WhatsApp: ' + av[0].whatsapp_status);
      await marcarItens(ruiP, [p.desc]); await preencher(ruiP);
      await ate(async () => (await pag(p.id)).status === 'aguardando_pagamento');
      const a = await assin(p.id);
      confere(a.length === 2 && a[1].user_id === RUI && a[1].etapa === 'administrador' && /^[0-9a-f]{64}$/.test(a[1].hash_integridade), 'assinatura do master');
      await dep(rui.rpc('registrar_baixa', { p_id: p.id, p_pago_em: hoje }));
      confere((await pag(p.id)).status === 'pago', 'master não deu baixa');
    });
    await passo('master dá baixa em qualquer obra (inclusive da Helena) e abre a tela de baixa; engenheiro não', async () => {
      const p = await novoPag(obraC, 450);
      confere(await erroDe(eng.rpc('registrar_baixa', { p_id: p.id, p_pago_em: hoje })), 'engenheiro deu baixa');
      confere(await erroDe(hel.rpc('registrar_baixa', { p_id: p.id, p_pago_em: hoje })), 'administradora deu baixa');
      const r = await ruiP.goto(BASE + '/pagamentos/baixar'); await ruiP.waitForLoadState('networkidle');
      confere(r.status() === 200 && !ruiP.url().includes('sem-permissao'), 'master não abriu a tela de baixa: ' + ruiP.url());
      await dep(rui.rpc('registrar_baixa', { p_id: p.id, p_pago_em: hoje }));
      const q = await pag(p.id);
      confere(q.status === 'pago' && q.pago_por === RUI, 'baixa não registrada pelo master');
      const dup = await erroDe(rui.rpc('registrar_baixa', { p_id: p.id, p_pago_em: hoje }));
      confere(dup && /não está liberado/.test(dup), 'baixa duplicada devia falhar: ' + dup);
    });
    await passo('master rejeita com motivo; financeiro reenvia; master assina a versão 2 e o pagamento é liberado', async () => {
      const p = await novoPag(obraM2, 700);
      await marcarItens(ruiP, [p.desc]); await preencher(ruiP, { rejeitar: true, motivo: 'Sem proposta anexada' });
      await ate(async () => (await pag(p.id)).status === 'rejeitado');
      confere((await pag(p.id)).rejeicao_motivo === 'Sem proposta anexada', 'motivo não gravado');
      confere(await erroDe(decidirRPC(rui, p.id, 1)), 'assinou rejeitado');
      await dep(fin.rpc('reenviar_pagamento', { p_id: p.id, p_observacao: 'proposta anexada' }));
      confere((await pag(p.id)).versao === 2 && (await pag(p.id)).status === 'aguardando_administrador', 'reenvio');
      await dep(decidirRPC(rui, p.id, 2));
      confere((await pag(p.id)).status === 'aguardando_pagamento', 'não liberou');
      const a = await assin(p.id);
      confere(a.length === 2 && a[0].decisao === 'rejeitado' && a[0].pagamento_versao === 1 && a[1].decisao === 'aprovado' && a[1].pagamento_versao === 2, 'histórico de assinaturas do master');
    });

    // =============== usuários: criação, 1º acesso, troca de senha ===============
    let novo;
    await passo('Financeiro cria usuário pela tela: senha provisória exibida, perfil e auditoria gravados, "Aguardando 1º acesso"', async () => {
      const email = `novo-${stamp.toLowerCase()}@demo.local`;
      novo = await criarPelaTela({ nome: `Novo Engenheiro ${stamp}`, email, perfil: 'engenheiro' });
      confere(!novo.erro, 'não criou: ' + novo.erro);
      confere(novo.email === email && /^[A-Za-z]{4}-\d{4}-[A-Za-z]{4}$/.test(novo.senha), `credenciais: ${novo.email} / ${novo.senha}`);
      const p = await perfilDb(novo.id);
      confere(p.perfil === 'engenheiro' && p.ativo && p.troca_senha_pendente === true, 'perfil gravado errado');
      const au = await dep(admin.from('auditoria').select('user_id, acao, entidade').eq('entidade', 'profiles').eq('entidade_id', novo.id));
      confere(au.length >= 1 && au.every((x) => x.user_id === ID.fin), 'auditoria da criação sem o autor (Financeiro)');
      await ir(finP, '/usuarios');
      const linha = finP.locator('tr', { hasText: email });
      confere((await linha.textContent()).includes('Aguardando 1º acesso'), 'lista sem "Aguardando 1º acesso"');
    });
    await passo('criação recusada: e-mail repetido, senha provisória fraca e nada fica pela metade', async () => {
      const antes = (await dep(admin.from('profiles').select('id'))).length;
      const r1 = await criarPelaTela({ nome: 'Duplicado', email: 'engenheiro@demo.local', perfil: 'engenheiro' });
      confere(r1.erro && /Já existe um usuário com este e-mail/.test(r1.erro), 'e-mail repetido: ' + r1.erro);
      const r2 = await criarPelaTela({ nome: 'Fraca', email: `fraca-${stamp.toLowerCase()}@demo.local`, perfil: 'suprimentos', senha: 'abc' });
      confere(r2.erro && /Senha provisória: A senha deve ter pelo menos 8/.test(r2.erro), 'senha fraca: ' + r2.erro);
      const r3 = await criarPelaTela({ nome: 'Sem letras', email: `fraca2-${stamp.toLowerCase()}@demo.local`, perfil: 'suprimentos', senha: '12345678' });
      confere(r3.erro && /letras e números/.test(r3.erro), 'senha só com números: ' + r3.erro);
      const depois = (await dep(admin.from('profiles').select('id'))).length;
      confere(antes === depois, `perfis ${antes} → ${depois}`);
      const { data: lista } = await admin.auth.admin.listUsers({ perPage: 1000 });
      confere(!lista.users.some((u) => u.email.startsWith(`fraca`) && u.email.includes(stamp.toLowerCase())), 'sobrou login no Auth');
    });
    await passo('1º acesso: a senha provisória entra, mas todas as telas levam a /trocar-senha até definir a senha', async () => {
      const p = await entrarComo(novo.email, novo.senha);
      for (const rota of ['/', '/aprovacoes', '/obras', '/pagamentos']) {
        await p.goto(BASE + rota); await p.waitForLoadState('networkidle');
        confere(new URL(p.url()).pathname === '/trocar-senha', `${rota} → ${p.url()}`);
      }
      confere((await p.textContent('main')).includes('Defina sua senha'), 'sem a mensagem de primeiro acesso');
      confere(!(await p.$('nav')), 'menu do sistema apareceu antes da troca');
      await p.context().close();
    });
    const tentaTroca = async (p, s, c) => { await p.fill('input[name=senha]', s); await p.fill('input[name=confirmacao]', c); await p.click('button:has-text("Salvar senha")'); await dormir(1500); return (await p.textContent('main')).replace(/\s+/g, ' '); };
    await passo('trocar senha: recusa senha curta, sem número e confirmação diferente (a pendência continua)', async () => {
      const p = await entrarComo(novo.email, novo.senha);
      await ir(p, '/trocar-senha');
      await tentaTroca(p, 'Ab1', 'Ab1'); // minLength do navegador impede o envio
      confere(new URL(p.url()).pathname === '/trocar-senha', 'senha curta passou');
      let t = await tentaTroca(p, 'SomenteLetras', 'SomenteLetras'); confere(/letras e números/.test(t), 'sem número: ' + t.slice(-160));
      t = await tentaTroca(p, 'Nova-Senha-9', 'Nova-Senha-8'); confere(/confirmação não confere/.test(t), 'confirmação: ' + t.slice(-160));
      confere((await perfilDb(novo.id)).troca_senha_pendente === true, 'trocou com dados inválidos');
      await p.context().close();
    });
    await passo('trocar senha: nova senha igual à provisória é recusada com mensagem em português', async () => {
      const p = await entrarComo(novo.email, novo.senha);
      await ir(p, '/trocar-senha');
      const t = await tentaTroca(p, novo.senha, novo.senha);
      confere(/diferente da senha provisória/.test(t), 'mensagem esperada: "A nova senha deve ser diferente da senha provisória."; a tela mostra: ' + t.slice(-130));
      confere((await perfilDb(novo.id)).troca_senha_pendente === true, 'pendência zerou com a mesma senha');
      await p.context().close();
    });
    await passo('trocar senha: aceita a nova, libera o sistema, senha provisória deixa de valer e a nova entra', async () => {
      const p = await entrarComo(novo.email, novo.senha);
      await ir(p, '/trocar-senha');
      await p.fill('input[name=senha]', 'Nova-Senha-9'); await p.fill('input[name=confirmacao]', 'Nova-Senha-9');
      await Promise.all([p.waitForURL((u) => u.pathname === '/'), p.click('button:has-text("Salvar senha")')]);
      confere((await perfilDb(novo.id)).troca_senha_pendente === false, 'pendência não zerou');
      confere(await p.locator('nav').count() > 0, 'menu não apareceu após a troca');
      await ir(p, '/obras'); confere(new URL(p.url()).pathname === '/obras', 'ainda forçando a troca');
      await p.context().close();
      confere(await erroDe(createClient(SUPA, PUB, { auth: { persistSession: false } }).auth.signInWithPassword({ email: novo.email, password: novo.senha })), 'senha provisória ainda funciona');
      await clienteEmail(novo.email, 'Nova-Senha-9');
      const pe = await entrarComo(novo.email, 'Nova-Senha-9');
      await ir(pe, '/trocar-senha');
      confere((await pe.textContent('main')).includes('Alterar senha') && !!(await pe.$('a:has-text("Cancelar")')), 'tela voluntária de alterar senha');
      await pe.context().close();
    });
    await passo('senha provisória não dá acesso à API antes da troca (README: troca obrigatória no 1º acesso)', async () => {
      const email = `prov-${stamp.toLowerCase()}@demo.local`;
      const u = await criarPelaTela({ nome: `Provisório ${stamp}`, email, perfil: 'suprimentos' }); // Suprimentos enxerga todas as obras
      confere(!u.erro, 'não criou: ' + u.erro);
      const c = await clienteEmail(u.email, u.senha);
      const obrasVistas = await dep(c.from('obras').select('id').limit(1));
      confere((await perfilDb(u.id)).troca_senha_pendente === true && !obrasVistas.length, 'com a senha provisória, sem ter trocado, a API já devolve dados (a troca só é exigida na tela)');
    });
    await passo('redefinir senha: gera nova provisória, a antiga para de valer, volta a exigir a troca; no próprio cadastro não há o botão', async () => {
      await ir(finP, `/usuarios/${novo.id}`);
      finP.once('dialog', (d) => d.accept());
      await finP.click('button:has-text("Gerar nova senha provisória")');
      await finP.waitForSelector('dl.font-mono dd', { timeout: 20000 });
      const nova = (await finP.locator('dl.font-mono dd').nth(1).textContent()).trim();
      confere(nova !== 'Nova-Senha-9' && /^[A-Za-z]{4}-\d{4}-[A-Za-z]{4}$/.test(nova), 'senha provisória: ' + nova);
      confere((await perfilDb(novo.id)).troca_senha_pendente === true, 'não voltou a exigir troca');
      confere(await erroDe(createClient(SUPA, PUB, { auth: { persistSession: false } }).auth.signInWithPassword({ email: novo.email, password: 'Nova-Senha-9' })), 'senha antiga ainda funciona');
      const p = await entrarComo(novo.email, nova);
      await p.goto(BASE + '/obras'); await p.waitForLoadState('networkidle');
      confere(new URL(p.url()).pathname === '/trocar-senha', 'não forçou a troca: ' + p.url());
      await p.context().close();
      await ir(finP, `/usuarios/${ID.fin}`);
      confere(!(await finP.$('button:has-text("Gerar nova senha provisória")')), 'financeiro pode gerar senha para si');
      novo.senha = nova;
    });

    // =============== desativar / reativar ===============
    let adm; // administrador temporário
    await passo('desativar: login recusado com mensagem, sessão aberta é encerrada, token antigo não lê nem assina; reativar volta', async () => {
      const email = `adm-${stamp.toLowerCase()}@demo.local`;
      adm = await criarPelaTela({ nome: `Adm Temporário ${stamp}`, email, perfil: 'administrador' });
      confere(!adm.erro, 'não criou: ' + adm.erro);
      adm.senha2 = 'Adm-Temp-2026';
      let p = await entrarComo(adm.email, adm.senha);
      await p.fill('input[name=senha]', adm.senha2); await p.fill('input[name=confirmacao]', adm.senha2);
      await Promise.all([p.waitForURL((u) => u.pathname === '/'), p.click('button:has-text("Salvar senha")')]);
      const tokenAntigo = await clienteEmail(adm.email, adm.senha2);
      adm.obra = await mkObra('Obra do administrador temporário', 'B', { administrador_id: adm.id });
      obras.push(adm.obra);
      const p1 = await novoPag(adm.obra, 111);
      confere((await dep(tokenAntigo.rpc('minhas_pendencias'))).some((x) => x.id === p1.id), 'pendência não apareceu antes de desativar');
      await salvarCadastro(adm.id, async () => { await finP.locator('input[name=ativo]').uncheck(); });
      await finP.getByText('Usuário desativado: o acesso foi bloqueado.').waitFor({ timeout: 20000 });
      confere((await perfilDb(adm.id)).ativo === false, 'ativo não ficou false');
      // 1) sessão aberta é encerrada na próxima navegação
      await p.goto(BASE + '/obras'); await p.waitForLoadState('networkidle');
      confere(new URL(p.url()).pathname === '/login', 'sessão aberta continuou: ' + p.url());
      await p.context().close();
      // 2) novo login recusado com a mensagem
      p = await entrarComo(adm.email, adm.senha2);
      confere(new URL(p.url()).pathname === '/login' && (await p.textContent('body')).includes('Seu acesso está desativado'), 'login não foi recusado com a mensagem');
      await p.context().close();
      // 3) token que já existia: nada de leitura nem de assinatura
      confere(!(await dep(tokenAntigo.from('obras').select('id'))).length, 'token antigo ainda lê obras');
      confere(!(await dep(tokenAntigo.rpc('minhas_pendencias'))).length, 'token antigo ainda vê pendências');
      const e = await erroDe(decidirRPC(tokenAntigo, p1.id, 1));
      confere(e, 'token antigo assinou depois de desativado');
      confere((await assin(p1.id)).length === 0, 'assinatura registrada por usuário desativado');
      // 4) reativar
      await salvarCadastro(adm.id, async () => { await finP.locator('input[name=ativo]').check(); });
      await finP.getByText('Usuário reativado.').waitFor({ timeout: 20000 });
      p = await entrarComo(adm.email, adm.senha2);
      confere(new URL(p.url()).pathname === '/', 'reativado não entrou: ' + p.url());
      await p.context().close();
      const au = await dep(admin.from('auditoria').select('descricao, dados_antes, dados_depois').eq('entidade', 'profiles').eq('entidade_id', adm.id).order('id'));
      confere(au.some((x) => x.dados_depois?.ativo === false) && au.some((x) => x.dados_depois?.ativo === true), 'auditoria sem desativar/reativar');
    });
    await passo('usuário desativado não recebe avisos, não pode ser responsável de obra; pendência órfã segue ao novo responsável', async () => {
      await salvarCadastro(adm.id, async () => { await finP.locator('input[name=ativo]').uncheck(); });
      await finP.getByText('Usuário desativado').waitFor({ timeout: 20000 });
      const p = await novoPag(adm.obra, 222);
      const ns = await dep(admin.from('notificacoes').select('id').eq('pagamento_id', p.id).eq('user_id', adm.id));
      confere(ns.length === 0, 'usuário desativado recebeu aviso');
      const e = await erroDe(fin.from('obras').update({ administrador_id: adm.id }).eq('id', obraM2.id).select());
      confere(e && /ativo/i.test(e), 'obra aceitou responsável desativado: ' + e);
      // obra órfã: o Financeiro passa a obra para a Helena e a pendência vai junto
      await dep(fin.from('obras').update({ administrador_id: ID.hel }).eq('id', adm.obra.id).select());
      confere((await dep(hel.rpc('minhas_pendencias'))).some((x) => x.id === p.id), 'pendência não foi reencaminhada à nova administradora');
      const av = await dep(admin.from('notificacoes').select('id').eq('pagamento_id', p.id).eq('user_id', ID.hel));
      confere(av.length >= 1, 'nova administradora não foi avisada');
      await dep(decidirRPC(hel, p.id, 1));
      confere((await pag(p.id)).status === 'aguardando_pagamento', 'nova administradora não conseguiu assinar');
    });
    await passo('Financeiro não consegue desativar nem mudar o perfil do próprio cadastro (tela)', async () => {
      await ir(finP, `/usuarios/${ID.fin}`);
      confere(await finP.locator('input[name=ativo][type=checkbox]').isDisabled(), 'checkbox de ativo habilitado no próprio cadastro');
      confere(await finP.locator('select[name=perfil]').isDisabled(), 'perfil editável no próprio cadastro');
    });

    // =============== perfis e vínculos ===============
    await passo('mudar o perfil pela tela vale na hora (engenheiro → suprimentos) e fica na auditoria com antes e depois', async () => {
      const u = await criarPelaTela({ nome: `Mudança de perfil ${stamp}`, email: `perfil-${stamp.toLowerCase()}@demo.local`, perfil: 'engenheiro' });
      confere(!u.erro, 'não criou: ' + u.erro);
      await salvarCadastro(u.id, async () => { await finP.selectOption('select[name=perfil]', 'suprimentos'); });
      await finP.getByText('Usuário atualizado.').waitFor({ timeout: 20000 });
      confere((await perfilDb(u.id)).perfil === 'suprimentos', 'perfil não mudou');
      const au = await dep(admin.from('auditoria').select('dados_antes, dados_depois, user_id').eq('entidade', 'profiles').eq('entidade_id', u.id).order('id', { ascending: false }).limit(1));
      confere(au[0].dados_antes?.perfil === 'engenheiro' && au[0].dados_depois?.perfil === 'suprimentos' && au[0].user_id === ID.fin, 'auditoria sem antes/depois do perfil: ' + JSON.stringify(au[0]));
      novo.alterado = u;
    });
    await passo('vínculos obra x usuário: marcar libera Suprimentos a lançar na obra; desmarcar tira; auditoria registra os dois', async () => {
      const u = novo.alterado;
      const base = { p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'vínculo', p_valor: 10, p_vencimento: somarDias(hoje, 3), p_forma_pagamento: 'pix' };
      const c0 = await clienteEmail(u.email, u.senha);
      confere(await erroDe(c0.rpc('criar_pagamento', base)), 'lançou sem vínculo');
      await ir(finP, `/usuarios/${u.id}`);
      await finP.locator(`label:has-text("${obraC.nome}") input[type=checkbox]`).check();
      await finP.click('button:has-text("Salvar acessos")');
      await finP.getByText(/Acessos atualizados \(\+1 \/ −0\)/).waitFor({ timeout: 20000 });
      const c1 = await clienteEmail(u.email, u.senha);
      const pid = await dep(c1.rpc('criar_pagamento', base)); criados.push(pid);
      await ir(finP, `/usuarios/${u.id}`);
      await finP.locator(`label:has-text("${obraC.nome}") input[type=checkbox]`).uncheck();
      await finP.click('button:has-text("Salvar acessos")');
      await finP.getByText(/Acessos atualizados \(\+0 \/ −1\)/).waitFor({ timeout: 20000 });
      confere(await erroDe(c1.rpc('criar_pagamento', base)), 'lançou depois de remover o vínculo');
      const au = await dep(admin.from('auditoria').select('acao').eq('entidade', 'obra_acessos').eq('user_id', ID.fin).order('id', { ascending: false }).limit(4));
      confere(au.length >= 2, 'auditoria dos vínculos: ' + au.length);
      await ir(finP, `/usuarios/${u.id}`);
      await finP.click('button:has-text("Salvar acessos")');
      await finP.getByText('Nenhuma alteração.').waitFor({ timeout: 20000 });
    });
    await passo('vínculo no cadastro: usuário Suprimentos criado já com a obra marcada recebe o acesso', async () => {
      const u = await criarPelaTela({ nome: `Sup vinculado ${stamp}`, email: `sup-${stamp.toLowerCase()}@demo.local`, perfil: 'suprimentos', obrasMarcadas: [obraM2.nome] });
      confere(!u.erro, 'não criou: ' + u.erro);
      const v = await dep(admin.from('obra_acessos').select('obra_id').eq('user_id', u.id));
      confere(v.length === 1 && v[0].obra_id === obraM2.id, 'vínculo não gravado: ' + JSON.stringify(v));
    });
    await passo('engenheiro e suprimentos não abrem Usuários nem Histórico de atividades (tela)', async () => {
      for (const perfil of ['engenheiro', 'suprimentos']) {
        const p = await entrar(perfil);
        for (const rota of ['/usuarios', '/usuarios/novo', '/auditoria']) {
          await p.goto(BASE + rota); await p.waitForLoadState('networkidle');
          confere(p.url().includes('sem-permissao=1'), `${perfil} abriu ${rota}: ${p.url()}`);
        }
        await p.context().close();
      }
    });

    // =============== auditoria (tela do Financeiro) ===============
    await passo('Histórico de atividades (Financeiro): filtra por registro, usuário e data; sem botão de editar/apagar; entradas do cadastro aparecem', async () => {
      await ir(finP, '/auditoria');
      const t = await finP.textContent('main');
      confere(/imutável/i.test(t), 'sem o aviso de registro imutável');
      await ir(finP, '/auditoria?entidade=profiles');
      const t2 = await finP.textContent('main');
      confere(t2.includes(novo.email.split('@')[0]) || /Novo Engenheiro|Usuário|usuário/.test(t2), 'entradas de usuário não aparecem');
      await ir(finP, `/auditoria?usuario=${ID.fin}&entidade=obra_acessos`);
      const linhas = await finP.locator('main tbody tr, main li').count();
      confere(linhas > 0, 'filtro por usuário e vínculos sem resultado');
      await ir(finP, `/auditoria?de=${hoje}&ate=${hoje}`);
      confere((await finP.locator('main tbody tr, main li').count()) > 0, 'filtro por data de hoje sem resultado');
      await ir(finP, `/auditoria?de=2000-01-01&ate=2000-01-02`);
      confere(!(await finP.$('button:has-text("Excluir")')) && !(await finP.$('button:has-text("Apagar")')) && !(await finP.$('button:has-text("Editar")')), 'há botão de editar/apagar na auditoria');
    });
    await passo('auditoria imutável para o Financeiro e para a chave administrativa: update, delete e truncate falham', async () => {
      const alvo = (await dep(admin.from('auditoria').select('id, descricao').eq('entidade', 'profiles').order('id', { ascending: false }).limit(1)))[0];
      for (const [nome, q] of [
        ['update financeiro', fin.from('auditoria').update({ descricao: 'x' }).eq('id', alvo.id).select()],
        ['delete financeiro', fin.from('auditoria').delete().eq('id', alvo.id).select()],
        ['update chave admin', admin.from('auditoria').update({ descricao: 'x' }).eq('id', alvo.id).select()],
        ['delete chave admin', admin.from('auditoria').delete().eq('id', alvo.id).select()],
      ]) { const r = await q; confere(r.error || !r.data?.length, `${nome}: conseguiu`); }
      confere((await dep(admin.from('auditoria').select('descricao').eq('id', alvo.id).single())).descricao === alvo.descricao, 'registro mudou');
    });

    // =============== celular 390px ===============
    await passo('celular 390px: Financeiro em Usuários, Novo usuário, cadastro e Histórico sem rolagem lateral', async () => {
      const m = await entrar('financeiro', 390);
      for (const rota of ['/usuarios', '/usuarios/novo', `/usuarios/${RUI}`, '/auditoria', '/obras']) {
        await ir(m, rota);
        confere(await larguraOk(m), `rolagem lateral em ${rota}`);
      }
      await m.context().close();
    });
    await passo('celular 390px: master em aprovações, janela de assinatura cabe na tela e assina', async () => {
      const m = await entrar(login, 390);
      const p = await novoPag(obraM2, 1999);
      await marcarItens(m, [p.desc]);
      const vp = m.viewportSize();
      const caixa = await m.locator('[role=dialog] > div').first().boundingBox();
      confere(caixa.x >= 0 && caixa.x + caixa.width <= vp.width + 1 && caixa.y >= 0 && caixa.y + caixa.height <= vp.height + 1, `janela fora da tela: ${JSON.stringify(caixa)}`);
      confere((await m.evaluate(() => { const d = document.querySelector('[role=dialog] > div'); return d.scrollWidth - d.clientWidth; })) <= 1, 'janela com rolagem lateral');
      await preencher(m);
      await ate(async () => (await pag(p.id)).status === 'aguardando_pagamento');
      for (const rota of ['/', '/aprovacoes', '/notificacoes', '/obras', `/pagamentos/${p.id}`]) { await ir(m, rota); confere(await larguraOk(m), `rolagem lateral em ${rota}`); }
      await m.context().close();
    });

    // =============== limpeza ===============
    await passo('limpeza: cancela o que ficou aberto, encerra as obras e remove (ou desativa) os usuários criados', async () => {
      for (const pid of criados) {
        const p = await admin.from('pagamentos').select('status').eq('id', pid).single();
        if (p.data && ['aguardando_engenheiro', 'aguardando_administrador', 'aguardando_pagamento', 'rejeitado'].includes(p.data.status)) await fin.rpc('cancelar_pagamento', { p_id: pid, p_motivo: 'limpeza do teste da persona' });
      }
      for (const o of obras) await dep(fin.from('obras').update({ status: 'concluida' }).eq('id', o.id).select());
      let apagados = 0, desativados = 0;
      for (const uid of usuariosCriados) {
        await admin.from('obra_acessos').delete().eq('user_id', uid);
        const d = await admin.from('profiles').delete().eq('id', uid);
        if (!d.error) { const a = await admin.auth.admin.deleteUser(uid); if (!a.error) { apagados++; continue; } }
        await admin.from('profiles').update({ ativo: false }).eq('id', uid);
        await admin.auth.admin.updateUserById(uid, { ban_duration: '876000h' });
        desativados++;
      }
      return `${apagados} usuário(s) apagado(s), ${desativados} desativado(s)`;
    });
  });
})().catch((e) => { console.error('✘ interrompido:', e.message.slice(0, 400)); process.exit(1); });
