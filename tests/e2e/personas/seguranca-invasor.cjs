// Persona "Beto, usuário curioso/mal-intencionado" — parte 1: fala direto com a API REST/RPC/Storage do Supabase
// (chave pública + token de cada perfil, ou sem login). Cada passo afirma o que DEVE acontecer (erro ou zero linhas)
// e, quando a tentativa muda dados, confere no banco (chave de serviço) que NADA mudou.
// Parte 2 (URLs, cron, redirecionamento, cabeçalhos, busca): seguranca-invasor-web.cjs.
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { admin, um, marca, confere, cliente, rodar } = require('./_util.cjs');

const env = Object.fromEntries(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]),
);
const URL_API = env.NEXT_PUBLIC_SUPABASE_URL;
const CHAVE = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const semLogin = () => createClient(URL_API, CHAVE, { auth: { persistSession: false } });
const SEM_ID = '00000000-0000-0000-0000-00000000dead';
const J = (x) => JSON.stringify(x);
// Mensagem de bloqueio de verdade (permissão/regra), e não um erro qualquer de digitação.
const BLOQUEIO = /permission denied|não encontrado|nao encontrado|somente|apenas|sem permiss|não tem permiss|não autoriz|não está aguardando|inválid|row-level security|violates|not allowed|não pode|não é possível|Usuário|financeiro|perfil|liberado|não pode ser|podem ser reenviados/i;

/** Chamada RPC que DEVE falhar com bloqueio. Devolve o texto do erro. */
async function rpcBloqueada(c, fn, args, quem = '') {
  const { data, error } = await c.rpc(fn, args);
  confere(error, `${quem} ${fn} FUNCIONOU (devia bloquear): ${J(data).slice(0, 120)}`);
  confere(BLOQUEIO.test(error.message) || error.code === '42501' || error.code === 'PGRST202', `${quem} ${fn} falhou por outro motivo: ${error.message}`);
  return error.message;
}
/** Leitura que DEVE vir negada (erro de permissão) ou vazia. */
async function leituraNegada(c, tabela, colunas = '*', filtro = (q) => q) {
  const { data, error } = await filtro(c.from(tabela).select(colunas));
  if (error) return `erro ${error.code}`;
  confere(Array.isArray(data) && data.length === 0, `${tabela}(${colunas}) devolveu ${data?.length} linha(s): ${J(data).slice(0, 160)}`);
  return '0 linhas';
}
const foto = async (tabela) => { const { data, error } = await admin.from(tabela).select('id').limit(20000); if (error) throw new Error(error.message); return new Set(data.map((r) => r.id)); };
/** Nenhuma linha que existia antes sumiu (outros testes podem estar criando linhas ao mesmo tempo, então não comparo totais). */
const semPerdas = async (tabela, antes) => { const agora = await foto(tabela); for (const id of antes) confere(agora.has(id), `${tabela}: a linha ${id} foi apagada`); };
const contar = async (tabela, filtro = (q) => q) => { const { count, error } = await filtro(admin.from(tabela).select('*', { count: 'exact', head: true })); if (error) throw new Error(error.message); return count; };

rodar('Segurança — invasor (API)', async ({ passo }) => {
  // ---------- preparação (dados fictícios) ----------
  const anon = semLogin();
  const eng = await cliente('engenheiro');
  const adm = await cliente('administrador');
  const adm2 = await cliente('administrador2');
  const sup = await cliente('suprimentos');
  const fin = await cliente('financeiro');
  const perfis = await um(admin.from('profiles').select('id, email, perfil'));
  const idDe = (email) => perfis.find((p) => p.email === email).id;
  const ID = { eng: idDe('engenheiro@demo.local'), adm: idDe('administrador@demo.local'), adm2: idDe('administrador2@demo.local'), sup: idDe('suprimentos@demo.local'), fin: idDe('financeiro@demo.local') };

  const obras = await um(admin.from('obras').select('id, nome, fluxo, engenheiro_id, administrador_id'));
  const visiveisEng = (await um(eng.from('obras').select('id'))).map((o) => o.id);
  const obraEng = obras.find((o) => o.engenheiro_id === ID.eng && o.administrador_id === ID.adm && o.fluxo === 'A');
  confere(obraEng, 'base de teste sem obra do engenheiro com fluxo A');
  const alheias = obras.filter((o) => !visiveisEng.includes(o.id));
  confere(alheias.length >= 1, 'base de teste sem obra alheia ao engenheiro');
  const obraAlheia = alheias[0];
  const obraDoAdm2 = obras.find((o) => o.administrador_id === ID.adm2);

  // Canários: dados sensíveis únicos que ninguém além de Financeiro/Suprimentos/master pode enxergar.
  const M = marca('invasor');
  const cnpjCanario = `99${String(Date.now()).padStart(12, '0').slice(-12)}`;
  const pixCanario = `pix-${M}@canario.test`;
  const contaCanario = `88${String(Date.now()).padStart(8, '0').slice(-8)}`;
  const forn = await um(fin.from('fornecedores').insert({ nome: `Fornecedor ${M}`, cpf_cnpj: cnpjCanario, chave_pix: pixCanario, banco: 'Banco Canário', agencia: '0001', conta: contaCanario, email: `forn-${M}@canario.test` }).select('id').single());
  await um(fin.rpc('criar_conta_bancaria', { p_nome: `Conta ${M}`, p_banco: '999', p_agencia: '4242', p_conta: contaCanario }));
  const canarios = [cnpjCanario, pixCanario, contaCanario, `forn-${M}@canario.test`, 'financeiro@demo.local', 'suprimentos@demo.local', 'administrador2@demo.local'];

  // Pagamentos de teste (criados pelo Financeiro, em cada obra)
  const pagCriar = async (obra, desc) => um(fin.rpc('criar_pagamento', { p_obra_id: obra, p_fornecedor_id: forn.id, p_favorecido: `Fav ${M}`, p_descricao: desc, p_valor: 1234.56, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null }));
  const idAlheio = await pagCriar(obraAlheia.id, `Pagamento alheio ${M}`);
  const idProprio = await pagCriar(obraEng.id, `Pagamento da obra do engenheiro ${M}`);
  const pg = async (id) => um(admin.from('pagamentos').select('id, status, valor, versao, favorecido, descricao, pago_em, valor_pago, created_by').eq('id', id).single());
  const unico = async (status, extra = (q) => q) => { const { data } = await extra(admin.from('pagamentos').select('id, obra_id, status, versao, valor').eq('status', status).limit(1)); return data?.[0]; };
  const pago = await unico('pago');
  const aguardPag = await unico('aguardando_pagamento', (q) => q.eq('obra_id', obraEng.id));
  const aguardAdm = await unico('aguardando_administrador', (q) => q.eq('obra_id', obraEng.id));
  const aguardEng = await unico('aguardando_engenheiro', (q) => q.eq('obra_id', obraEng.id));
  confere(pago && aguardPag && aguardAdm && aguardEng, 'base de teste sem pagamentos nos estados pago/aguardando_pagamento/administrador/engenheiro na obra do engenheiro');

  // =================== SEM LOGIN ===================
  await passo('sem login: tabelas e visões sensíveis negadas ou vazias (pagamentos, perfis, fornecedores, contas, auditoria, notificações, assinaturas, documentos, NF…)', async () => {
    const tabelas = ['profiles', 'profiles_completo', 'fornecedores', 'fornecedores_dados', 'contas_bancarias', 'contas_bancarias_dados', 'pagamentos', 'pagamento_parcelas', 'documentos', 'assinaturas', 'auditoria', 'notificacoes', 'obras', 'obra_acessos', 'nf_notas', 'nf_itens', 'compras_itens', 'ordens_pagamento', 'fundos_fixos', 'fundo_gastos', 'recebimentos', 'transferencias', 'extrato_linhas', 'extrato_importacoes', 'provisoes', 'notas_medicao', 'notas_contabeis', 'categorias'];
    for (const t of tabelas) await leituraNegada(anon, t);
    return `${tabelas.length} tabelas`;
  });

  await passo('sem login: RPCs de baixa, conciliação, usuários, fundos, criação de pagamento e fila de avisos negadas', async () => {
    const chamadas = {
      registrar_baixa: { p_id: aguardPag.id, p_pago_em: '2026-12-01', p_valor_pago: 1, p_observacao: null, p_diferenca: null },
      estornar_baixa: { p_id: pago.id, p_motivo: 'x' },
      criar_perfil_completo: { p_id: SEM_ID, p_nome: 'Invasor', p_email: `inv-${M}@x.test`, p_telefone: null, p_perfil: 'financeiro', p_obras: [] },
      criar_fundo_fixo: { p_obra_id: obraEng.id, p_pessoa_id: ID.eng, p_valor: 100, p_conta_id: SEM_ID, p_vencimento: '2026-12-30' },
      criar_conta_bancaria: { p_nome: 'x', p_banco: 'x', p_agencia: '1', p_conta: '1' },
      conciliar_linha: { p_linha_id: SEM_ID, p_itens: [], p_diferenca: null },
      importar_extrato: { p_banco: 'x', p_agencia: '1', p_conta: '1', p_arquivo: 'x.ofx', p_inicio: '2026-01-01', p_fim: '2026-01-31', p_saldo: 0, p_saldo_em: '2026-01-31', p_linhas: [] },
      criar_pagamento: { p_obra_id: obraEng.id, p_fornecedor_id: null, p_favorecido: 'x', p_descricao: 'x', p_valor: 1, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null },
      cancelar_pagamento: { p_id: aguardPag.id, p_motivo: 'x' },
      decidir_aprovacao: { p_itens: [{ id: aguardAdm.id, versao: aguardAdm.versao }], p_decisao: 'aprovado', p_comentario: null, p_ip: null, p_user_agent: null },
      reservar_avisos: { p_canal: 'email', p_limite: 100 },
      gerar_lembretes_diarios: {},
      marcar_notificacoes_lidas: { p_ids: [SEM_ID] },
      definir_assinatura: { p_path: `${ID.fin}/x.png` },
    };
    for (const [fn, args] of Object.entries(chamadas)) await rpcBloqueada(anon, fn, args, 'anônimo');
    return `${Object.keys(chamadas).length} RPCs`;
  });

  await passo('sem login: RPC auxiliar interna _validar_receita (SECURITY DEFINER) não pode ser chamada nem revelar se uma obra existe', async () => {
    // Brecha conhecida do teste: meu_perfil() é NULL para anônimo e "NULL not in (...)" não levanta erro; a função responde
    // sucesso (obra existe) ou "Escolha o centro de custo" (não existe): oráculo de existência de UUID para quem não tem login.
    const args = (obra) => ({ p_obra_id: obra, p_categoria_id: null, p_cliente: 'x', p_descricao: 'x', p_valor: 1, p_vencimento: '2026-12-30' });
    const real = await anon.rpc('_validar_receita', args(obraEng.id));
    const falso = await anon.rpc('_validar_receita', args(SEM_ID));
    confere(real.error, `anônimo executou _validar_receita com obra existente e o banco respondeu sucesso (${J(real.data)}), enquanto obra inexistente deu "${falso.error?.message}": revela existência de obras sem login`);
  });

  await passo('sem login: escrever direto nas tabelas (insert/update/delete) é negado e nada muda', async () => {
    const T = ['pagamentos', 'auditoria', 'fornecedores', 'obras', 'profiles']; const fotos = {}; for (const t of T) fotos[t] = await foto(t);
    const tent = [
      anon.from('pagamentos').insert({ obra_id: obraEng.id, favorecido: 'hack', valor: 1, vencimento: '2026-12-30', forma_pagamento: 'pix', status: 'pago', fluxo: 'C', numero: 99999 }),
      anon.from('pagamentos').update({ status: 'pago', valor: 0.01 }).eq('id', aguardPag.id),
      anon.from('pagamentos').delete().eq('id', aguardPag.id),
      anon.from('auditoria').delete().neq('id', SEM_ID),
      anon.from('fornecedores').insert({ nome: `Fantasma ${M}` }),
      anon.from('profiles').update({ perfil: 'financeiro' }).eq('id', ID.eng),
      anon.from('obras').update({ engenheiro_id: ID.eng }).eq('id', obraAlheia.id),
      anon.from('assinaturas').insert({ pagamento_id: aguardAdm.id, user_id: ID.adm }),
    ];
    for (const r of await Promise.all(tent.map((t) => t.select()))) confere(r.error || (Array.isArray(r.data) && r.data.length === 0), `escrita anônima passou: ${J(r.data).slice(0, 120)}`);
    for (const t of T) await semPerdas(t, fotos[t]);
    confere((await contar('fornecedores', (q) => q.eq('nome', `Fantasma ${M}`))) === 0, 'fornecedor fantasma criado por anônimo');
    const p = await pg(aguardPag.id); confere(p.status === 'aguardando_pagamento' && Number(p.valor) === Number(aguardPag.valor), 'pagamento foi alterado por anônimo');
  });

  await passo('sem login: Storage — listar, baixar, assinar URL e enviar nos dois buckets é negado; URL "pública" não serve arquivo', async () => {
    const doc = (await um(admin.from('documentos').select('storage_path').limit(1)))[0];
    confere(doc, 'sem documento de base');
    for (const b of ['documentos', 'assinaturas']) {
      const l = await anon.storage.from(b).list('', { limit: 5 });
      confere(l.error || (l.data ?? []).length === 0, `listou ${b}: ${J(l.data).slice(0, 100)}`);
      const up = await anon.storage.from(b).upload(`${SEM_ID}/${M}.png`, new Blob(['x'], { type: 'image/png' }));
      confere(up.error, `anônimo enviou arquivo para ${b}`);
    }
    const dl = await anon.storage.from('documentos').download(doc.storage_path);
    confere(dl.error, 'anônimo baixou documento');
    const su = await anon.storage.from('documentos').createSignedUrl(doc.storage_path, 60);
    confere(su.error, 'anônimo assinou URL de documento');
    const r = await fetch(`${URL_API}/storage/v1/object/public/documentos/${doc.storage_path}`);
    confere(r.status !== 200, `URL pública do bucket privado serviu o arquivo (${r.status})`);
    const r2 = await fetch(`${URL_API}/storage/v1/object/documentos/${doc.storage_path}`, { headers: { apikey: CHAVE } });
    confere(r2.status !== 200, `GET direto sem token serviu o arquivo (${r2.status})`);
  });

  await passo('sem login: cadastro aberto (signUp) e login anônimo desativados — não dá para criar conta própria', async () => {
    const e = `invasor-${M}@canario.test`.toLowerCase();
    const r = await anon.auth.signUp({ email: e, password: 'Invasor-1234' });
    if (r.data?.user?.id) await admin.auth.admin.deleteUser(r.data.user.id).catch(() => {});
    confere(r.error && !r.data?.session, `signUp deu certo: ${J(r.data).slice(0, 120)}`);
    const an = await anon.auth.signInAnonymously();
    confere(an.error && !an.data?.session, 'login anônimo funcionou');
    return r.error.message;
  });

  // =================== PRIVACIDADE ===================
  await passo('engenheiro e administrador: colunas sensíveis direto nas tabelas (e-mail, telefone, CPF/CNPJ, PIX, banco, conta) → permissão negada, inclusive com select(*)', async () => {
    for (const [nome, c] of [['engenheiro', eng], ['administrador', adm]]) {
      for (const [t, cols] of [['profiles', 'email'], ['profiles', 'telefone'], ['profiles', '*'], ['fornecedores', 'cpf_cnpj'], ['fornecedores', 'chave_pix'], ['fornecedores', 'banco,agencia,conta'], ['fornecedores', '*'], ['fornecedores', 'email,telefone,observacoes'], ['contas_bancarias', 'banco,agencia,conta'], ['contas_bancarias', '*']]) {
        const { data, error } = await c.from(t).select(cols);
        confere(error?.code === '42501', `${nome}: ${t}(${cols}) não foi negado: ${error ? error.message : data.length + ' linhas'}`);
      }
    }
  });

  await passo('engenheiro e administrador: não adivinham dados ocultos por filtro/ordem (oráculo): filtrar ou ordenar por e-mail/CPF/PIX também é negado', async () => {
    for (const c of [eng, adm]) {
      for (const f of [(q) => q.eq('email', 'financeiro@demo.local'), (q) => q.ilike('email', 'fin%'), (q) => q.order('email'), (q) => q.eq('telefone', '71999990000')]) {
        const r = await f(c.from('profiles').select('id'));
        confere(r.error?.code === '42501', `filtro em profiles passou: ${r.error ? r.error.message : r.data.length + ' linhas'}`);
      }
      for (const f of [(q) => q.eq('cpf_cnpj', cnpjCanario), (q) => q.like('chave_pix', 'pix-%'), (q) => q.order('conta')]) {
        const r = await f(c.from('fornecedores').select('id'));
        confere(r.error?.code === '42501', `filtro em fornecedores passou: ${r.error ? r.error.message : r.data.length + ' linhas'}`);
      }
      const r = await c.from('contas_bancarias').select('id').eq('conta', contaCanario);
      confere(r.error?.code === '42501', 'filtro por número da conta da empresa passou');
    }
  });

  await passo('engenheiro e administrador: embutir tabelas relacionadas (embed) não contorna — pagamentos→fornecedores(cpf_cnpj), obras→profiles(email), documentos→profiles(email)', async () => {
    for (const c of [eng, adm]) {
      const tentativas = [
        ['pagamentos', 'id, fornecedores(cpf_cnpj, chave_pix)'],
        ['pagamentos', 'id, fornecedores(*)'],
        ['obras', 'id, profiles!obras_engenheiro_id_fkey(email, telefone)'],
        ['obras', 'id, profiles!obras_administrador_id_fkey(*)'],
        ['documentos', 'id, profiles!documentos_enviado_por_fkey(email)'],
        ['pagamentos', 'id, profiles!pagamentos_created_by_fkey(email)'],
      ];
      for (const [t, sel] of tentativas) {
        const r = await c.from(t).select(sel);
        confere(r.error?.code === '42501' || (!r.error && !J(r.data).match(/@|pix-|"cpf_cnpj":"\d/)), `embed ${t}(${sel}) vazou: ${r.error ? r.error.message : J(r.data).slice(0, 120)}`);
      }
    }
  });

  await passo('engenheiro e administrador: varredura geral — lê tudo que a API deixa ler e NENHUM canário (CPF/CNPJ, PIX, conta, e-mails de colegas) aparece', async () => {
    const tabelas = ['profiles', 'profiles_completo', 'fornecedores', 'fornecedores_dados', 'contas_bancarias', 'contas_bancarias_dados', 'obras', 'obra_acessos', 'pagamentos', 'pagamento_parcelas', 'documentos', 'assinaturas', 'auditoria', 'notificacoes', 'nf_notas', 'nf_itens', 'compras_itens', 'ordens_pagamento', 'ordem_itens', 'ordem_parcelas', 'ordem_anexos', 'fundos_fixos', 'fundo_gastos', 'recebimentos', 'transferencias', 'extrato_linhas', 'provisoes', 'notas_medicao', 'notas_contabeis', 'categorias'];
    let lidas = 0;
    for (const [nome, c, proprioEmail] of [['engenheiro', eng, 'engenheiro@demo.local'], ['administrador', adm, 'administrador@demo.local']]) {
      for (const t of tabelas) {
        const r = await c.from(t).select('*').limit(1000);
        if (r.error) continue;
        lidas += r.data.length;
        const txt = J(r.data);
        for (const k of canarios) {
          if (k === proprioEmail) continue;
          confere(!txt.includes(k), `${nome} leu o canário "${k}" em ${t}`);
        }
      }
    }
    return `${lidas} linhas lidas, 0 vazamentos`;
  });

  await passo('administrador, engenheiro e suprimentos: profiles_completo só devolve a PRÓPRIA linha (e-mail/telefone de colegas só para o Financeiro)', async () => {
    for (const [c, id] of [[eng, ID.eng], [adm, ID.adm], [adm2, ID.adm2], [sup, ID.sup]]) {
      const l = await um(c.from('profiles_completo').select('id, email'));
      confere(l.length === 1 && l[0].id === id, `profiles_completo devolveu ${l.length} linha(s)`);
      const outro = await um(c.from('profiles_completo').select('id').eq('id', ID.fin));
      confere(outro.length === 0, 'conseguiu o e-mail do Financeiro pelo filtro de id');
    }
  });

  await passo('suprimentos: vê fornecedores_dados (por regra), mas NÃO vê conta bancária da empresa nem lê colunas bancárias direto; controle: Financeiro vê tudo', async () => {
    const fs_ = await um(sup.from('fornecedores_dados').select('cpf_cnpj').eq('id', forn.id));
    confere(fs_.length === 1 && fs_[0].cpf_cnpj === cnpjCanario, 'suprimentos devia ver o fornecedor (controle positivo)');
    confere((await um(sup.from('contas_bancarias_dados').select('*'))).length === 0, 'suprimentos viu contas_bancarias_dados');
    const r = await sup.from('contas_bancarias').select('banco,agencia,conta');
    confere(r.error?.code === '42501', 'suprimentos leu colunas bancárias da conta da empresa');
    const todos = await um(fin.from('profiles_completo').select('id'));
    confere(todos.length >= 5, `Financeiro devia ver todos os perfis (viu ${todos.length})`);
    const cf = await um(fin.from('contas_bancarias_dados').select('conta').eq('conta', contaCanario));
    confere(cf.length === 1, 'Financeiro devia ver a conta (controle positivo)');
  });

  await passo('engenheiro e administrador: Inteligência de Compras só pela visão — nf_notas/nf_itens vazias e fornecedor_cnpj sempre nulo (até filtrando por CNPJ)', async () => {
    const cnpjReal = (await um(admin.from('nf_notas').select('emitente_cnpj').not('emitente_cnpj', 'is', null).limit(1)))[0]?.emitente_cnpj;
    confere(cnpjReal, 'base sem NF com CNPJ');
    for (const c of [eng, adm]) {
      await leituraNegada(c, 'nf_notas'); await leituraNegada(c, 'nf_itens');
      const itens = await um(c.from('compras_itens').select('fornecedor_cnpj, fornecedor_nome'));
      confere(itens.length > 0, 'a visão devia abrir preços para todos (controle positivo)');
      confere(itens.every((i) => i.fornecedor_cnpj === null), 'compras_itens vazou fornecedor_cnpj');
      const f = await um(c.from('compras_itens').select('id').eq('fornecedor_cnpj', cnpjReal));
      confere(f.length === 0, 'filtrar compras_itens por CNPJ encontrou linhas (oráculo)');
    }
  });

  // =================== RPCs COM PERFIL ERRADO ===================
  await passo('engenheiro, administrador e suprimentos: baixa, estorno e baixa de parcela de pagamento negadas — pagamento segue aguardando pagamento', async () => {
    const antes = await pg(aguardPag.id);
    const parcela = (await admin.from('pagamento_parcelas').select('id').limit(1)).data?.[0]?.id ?? SEM_ID;
    for (const [nome, c] of [['engenheiro', eng], ['administrador', adm], ['suprimentos', sup]]) {
      await rpcBloqueada(c, 'registrar_baixa', { p_id: aguardPag.id, p_pago_em: '2026-12-01', p_valor_pago: 0.01, p_observacao: 'invasor', p_diferenca: null }, nome);
      await rpcBloqueada(c, 'estornar_baixa', { p_id: pago.id, p_motivo: 'invasor' }, nome);
      await rpcBloqueada(c, 'registrar_baixa_parcela', { p_parcela_id: parcela, p_pago_em: '2026-12-01', p_valor_pago: 0.01, p_observacao: 'invasor' }, nome);
    }
    const depois = await pg(aguardPag.id);
    confere(depois.status === 'aguardando_pagamento' && depois.pago_em === null && J(depois) === J(antes), 'pagamento mudou');
    confere((await pg(pago.id)).status === 'pago', 'pagamento pago foi estornado');
  });

  await passo('engenheiro, administrador e suprimentos: usuários, contas bancárias, conciliação, extrato, fundo fixo e contas a receber — RPCs exclusivas do Financeiro negadas', async () => {
    for (const [nome, c] of [['engenheiro', eng], ['administrador', adm], ['suprimentos', sup]]) {
      await rpcBloqueada(c, 'criar_perfil_completo', { p_id: SEM_ID, p_nome: 'Invasor', p_email: `inv2-${M}@x.test`, p_telefone: null, p_perfil: 'financeiro', p_obras: [] }, nome);
      await rpcBloqueada(c, 'criar_conta_bancaria', { p_nome: `Falsa ${M}`, p_banco: 'x', p_agencia: '1', p_conta: '1' }, nome);
      await rpcBloqueada(c, 'criar_fundo_fixo', { p_obra_id: obraEng.id, p_pessoa_id: ID[nome === 'engenheiro' ? 'eng' : nome === 'administrador' ? 'adm' : 'sup'], p_valor: 5000, p_conta_id: SEM_ID, p_vencimento: '2026-12-30' }, nome);
      await rpcBloqueada(c, 'importar_extrato', { p_banco: 'x', p_agencia: '1', p_conta: '1', p_arquivo: 'x.ofx', p_inicio: '2026-01-01', p_fim: '2026-01-31', p_saldo: 0, p_saldo_em: '2026-01-31', p_linhas: [] }, nome);
      await rpcBloqueada(c, 'conciliar_linha', { p_linha_id: SEM_ID, p_itens: [], p_diferenca: null }, nome);
      await rpcBloqueada(c, 'criar_recebimento', { p_obra_id: obraEng.id, p_categoria_id: null, p_cliente: 'x', p_descricao: 'x', p_valor: 1, p_vencimento: '2026-12-30', p_competencia: null, p_conta_id: null, p_observacoes: null, p_nota_id: null }, nome);
    }
    confere((await contar('profiles', (q) => q.like('email', `inv2-${M}%`))) === 0, 'perfil criado por invasor');
    confere((await contar('contas_bancarias', (q) => q.eq('nome', `Falsa ${M}`))) === 0, 'conta bancária criada por invasor');
    confere((await contar('fundos_fixos', (q) => q.eq('valor', 5000))) === 0, 'fundo de 5000 criado por invasor');
    confere((await contar('recebimentos', (q) => q.eq('descricao', 'x').eq('cliente', 'x'))) === 0, 'recebimento criado por invasor');
  });

  // Fundo fixo de Suprimentos na obra do engenheiro (reaproveita o aberto, pois só existe um por pessoa e obra)
  let fundoId = (await admin.from('fundos_fixos').select('id').eq('pessoa_id', ID.sup).eq('obra_id', obraEng.id).neq('status', 'fechado').limit(1)).data?.[0]?.id;
  if (!fundoId) fundoId = await um(fin.rpc('criar_fundo_fixo', { p_obra_id: obraEng.id, p_pessoa_id: ID.sup, p_valor: 100, p_conta_id: null, p_vencimento: '2026-12-30' }));
  confere(fundoId, 'não consegui um fundo de teste');
  await sup.rpc('informar_dados_bancarios_fundo', { p_fundo_id: fundoId, p_forma: 'pix', p_banco: '999', p_favorecido: 'Suprimentos Demo', p_chave_pix: `fundo-${M}@canario.test` });
  const gastoSup = await um(sup.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: `Gasto ${M}`, p_data: '2026-11-25', p_valor: 1 }));

  await passo('fundo fixo de outra pessoa (leitura): engenheiro que não é o dono nem o administrador não vê o fundo, os gastos nem o saldo do colega (README: "Fundo fixo: o seu")', async () => {
    const f = await um(eng.from('fundos_fixos').select('id, valor').eq('id', fundoId));
    confere(f.length === 0, `engenheiro leu o fundo de Suprimentos (RLS fundos_select usa pode_ver_obra(obra_id), que inclui o engenheiro da obra): ${J(f)}`);
    const g = await um(eng.from('fundo_gastos').select('id, valor, descricao').eq('id', gastoSup));
    confere(g.length === 0, 'engenheiro leu gasto do fundo de outra pessoa');
  });

  await passo('fundo fixo de outra pessoa (ações): engenheiro não lança gasto, não decide e não fecha; Suprimentos não aprova o próprio gasto', async () => {
    await rpcBloqueada(eng, 'lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: 'gasto falso', p_data: '2026-11-25', p_valor: 10 }, 'engenheiro');
    await rpcBloqueada(eng, 'fechar_fundo_fixo', { p_fundo_id: fundoId, p_vencimento: '2026-12-30', p_modo: 'repor', p_conta_id: null }, 'engenheiro');
    await rpcBloqueada(eng, 'decidir_gasto_fundo', { p_gasto_id: gastoSup, p_aprovar: true, p_motivo: null }, 'engenheiro');
    await rpcBloqueada(adm2, 'decidir_gasto_fundo', { p_gasto_id: gastoSup, p_aprovar: true, p_motivo: null }, 'administrador de outra obra');
    await rpcBloqueada(sup, 'decidir_gasto_fundo', { p_gasto_id: gastoSup, p_aprovar: true, p_motivo: null }, 'suprimentos (aprovar o próprio gasto)');
    await rpcBloqueada(sup, 'fechar_fundo_fixo', { p_fundo_id: fundoId, p_vencimento: '2026-12-30', p_modo: 'repor', p_conta_id: null }, 'suprimentos (fechar o próprio fundo)');
    const g = (await um(admin.from('fundo_gastos').select('id, status').eq('id', gastoSup)))[0];
    confere(g && g.status !== 'aprovado' || !g, `gasto mudou de situação: ${J(g)}`);
    await sup.rpc('excluir_gasto_fundo', { p_gasto_id: gastoSup });
  });

  await passo('escalada de privilégio: engenheiro, administrador e suprimentos não mudam o próprio perfil, nem ativam usuários, nem se vinculam a obras, nem alteram obras', async () => {
    const antes = J(await um(admin.from('profiles').select('id, perfil, ativo, nome').order('id')));
    const obrasAntes = J(await um(admin.from('obras').select('id, engenheiro_id, administrador_id, fluxo, status, nome').order('id')));
    const acessosAntes = await contar('obra_acessos');
    for (const [nome, c, id] of [['engenheiro', eng, ID.eng], ['administrador', adm, ID.adm], ['suprimentos', sup, ID.sup]]) {
      const tent = [
        c.from('profiles').update({ perfil: 'financeiro' }).eq('id', id),
        c.from('profiles').update({ perfil: 'administrador_master', ativo: true }).eq('id', id),
        c.from('profiles').update({ nome: `Hackeado ${M}` }).neq('id', id),
        c.from('obras').update({ engenheiro_id: id, administrador_id: id }).eq('id', obraAlheia.id),
        c.from('obras').update({ fluxo: 'C' }).eq('id', obraEng.id),
        c.from('obras').insert({ nome: `Obra falsa ${M}`, codigo: M, fluxo: 'C' }),
        c.from('obra_acessos').insert({ obra_id: obraAlheia.id, user_id: id }),
        c.from('obra_acessos').delete().neq('obra_id', SEM_ID),
        c.from('profiles').insert({ id: SEM_ID, nome: 'x', perfil: 'financeiro' }),
      ];
      for (const t of tent) { const r = await t.select(); confere(r.error || r.data.length === 0, `${nome}: escrita passou: ${J(r.data).slice(0, 100)}`); }
    }
    confere(antes === J(await um(admin.from('profiles').select('id, perfil, ativo, nome').order('id'))), 'perfis mudaram');
    confere(obrasAntes === J(await um(admin.from('obras').select('id, engenheiro_id, administrador_id, fluxo, status, nome').order('id'))), 'obras mudaram');
    confere(acessosAntes === await contar('obra_acessos'), 'vínculos de obra mudaram');
  });

  await passo('forjar dados em escrita direta: NENHUM perfil (nem o Financeiro) grava direto em pagamentos, documentos, assinaturas, parcelas, OP, notificações, fundos, recebimentos — só pelas funções', async () => {
    const tabelas = ['pagamentos', 'pagamento_parcelas', 'documentos', 'assinaturas', 'ordens_pagamento', 'ordem_itens', 'notificacoes', 'fundos_fixos', 'fundo_gastos', 'recebimentos', 'nf_notas', 'notas_contabeis', 'categorias', 'notas_medicao'];
    const fotos = {}; for (const t of tabelas) fotos[t] = await foto(t);
    const snap = J(await um(admin.from('pagamentos').select('id, status, valor, created_by, versao, pago_em, valor_pago').order('id')));
    for (const [nome, c] of [['engenheiro', eng], ['administrador', adm], ['suprimentos', sup], ['financeiro', fin]]) {
      for (const t of tabelas) {
        const forjado = { id: SEM_ID, created_by: ID.fin, status: 'pago', user_id: ID.fin, obra_id: obraAlheia.id, pagamento_id: aguardAdm.id, valor: 0.01 };
        const i = await c.from(t).insert(forjado).select();
        confere(i.error || i.data.length === 0, `${nome}: insert direto em ${t} passou`);
        const u = await c.from(t).update({ status: 'pago', valor: 0.01, created_by: ID.fin }).neq('id', SEM_ID).select();
        confere(u.error || u.data.length === 0, `${nome}: update direto em ${t} alterou ${u.data?.length} linha(s)`);
        const d = await c.from(t).delete().neq('id', SEM_ID).select();
        confere(d.error || d.data.length === 0, `${nome}: delete direto em ${t} apagou ${d.data?.length} linha(s)`);
      }
    }
    for (const t of tabelas) await semPerdas(t, fotos[t]);
    confere(snap === J(await um(admin.from('pagamentos').select('id, status, valor, created_by, versao, pago_em, valor_pago').order('id'))), 'pagamentos mudaram');
  });

  await passo('forjar created_by: fornecedor inserido por Suprimentos com created_by de outro usuário é recusado ou fica com o autor verdadeiro', async () => {
    const r = await sup.from('fornecedores').insert({ nome: `Forja ${M}`, created_by: ID.fin }).select('id, created_by');
    if (!r.error) {
      confere(r.data[0].created_by === ID.sup, `created_by forjado foi aceito: ${r.data[0].created_by} (quem gravou foi suprimentos ${ID.sup})`);
    } else confere(r.error.code === '42501', r.error.message);
    const e = await eng.from('fornecedores').insert({ nome: `Forja eng ${M}` }).select();
    confere(e.error || e.data.length === 0, 'engenheiro cadastrou fornecedor direto');
    const u = await eng.from('fornecedores').update({ nome: 'x' }).eq('id', forn.id).select();
    confere(u.error || u.data.length === 0, 'engenheiro alterou fornecedor');
  });

  await passo('pagamento já pago: engenheiro e administrador não alteram nem cancelam; ninguém cancela, baixa de novo ou reenvia um pago (Financeiro incluído)', async () => {
    const antes = await pg(pago.id);
    const edit = (id) => ({ p_id: id, p_fornecedor_id: null, p_favorecido: 'Desviado', p_descricao: 'x', p_valor: 0.01, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null, p_motivo: 'invasor', p_obra_id: null });
    for (const [nome, c] of [['engenheiro', eng], ['administrador', adm]]) {
      await rpcBloqueada(c, 'atualizar_pagamento', edit(pago.id), nome);
      await rpcBloqueada(c, 'cancelar_pagamento', { p_id: pago.id, p_motivo: 'invasor' }, nome);
    }
    // Pagamento criado e pago por este teste (obra de fluxo C), para o Financeiro tentar o que não pode
    const obraC = obras.find((o) => o.fluxo === 'C');
    const meuPago = await um(fin.rpc('criar_pagamento', { p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: `Pago ${M}`, p_descricao: 'teste de pago', p_valor: 10, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null }));
    await um(fin.rpc('registrar_baixa', { p_id: meuPago, p_pago_em: '2026-11-25', p_valor_pago: 10, p_observacao: null, p_diferenca: null }));
    for (const [nome, c] of [['financeiro', fin], ['suprimentos', sup]]) {
      await rpcBloqueada(c, 'cancelar_pagamento', { p_id: meuPago, p_motivo: 'invasor' }, nome);
      await rpcBloqueada(c, 'reenviar_pagamento', { p_id: meuPago }, nome);
    }
    await rpcBloqueada(fin, 'registrar_baixa', { p_id: meuPago, p_pago_em: '2026-11-26', p_valor_pago: 0.01, p_observacao: 'baixa dupla', p_diferenca: null }, 'financeiro (baixa dupla)');
    const dep = await pg(meuPago);
    confere(dep.status === 'pago' && Number(dep.valor_pago) === 10 && dep.pago_em === '2026-11-25', `pago mudou: ${J(dep)}`);
    confere(J(antes) === J(await pg(pago.id)), 'pagamento pago do banco foi alterado');
  });

  await passo('assinar por outro usuário: aprovação fora da etapa ou da obra negada — engenheiro em etapa do administrador, administrador na etapa do engenheiro, administrador da OUTRA obra, versão forjada', async () => {
    const antes = J([await pg(aguardAdm.id), await pg(aguardEng.id)]);
    const item = (p, versao) => [{ id: p.id, versao: versao ?? p.versao }];
    await rpcBloqueada(eng, 'decidir_aprovacao', { p_itens: item(aguardAdm), p_decisao: 'aprovado', p_comentario: null, p_ip: '1.1.1.1', p_user_agent: 'invasor' }, 'engenheiro (etapa do administrador)');
    await rpcBloqueada(adm, 'decidir_aprovacao', { p_itens: item(aguardEng), p_decisao: 'aprovado', p_comentario: null, p_ip: null, p_user_agent: null }, 'administrador (etapa do engenheiro)');
    await rpcBloqueada(adm2, 'decidir_aprovacao', { p_itens: item(aguardAdm), p_decisao: 'aprovado', p_comentario: null, p_ip: null, p_user_agent: null }, 'administrador de outra obra');
    await rpcBloqueada(adm2, 'decidir_aprovacao', { p_itens: item(aguardAdm), p_decisao: 'rejeitado', p_comentario: 'invasor', p_ip: null, p_user_agent: null }, 'administrador de outra obra (rejeitar)');
    await rpcBloqueada(sup, 'decidir_aprovacao', { p_itens: item(aguardAdm), p_decisao: 'aprovado', p_comentario: null, p_ip: null, p_user_agent: null }, 'suprimentos');
    await rpcBloqueada(fin, 'decidir_aprovacao', { p_itens: item(aguardEng), p_decisao: 'aprovado', p_comentario: null, p_ip: null, p_user_agent: null }, 'financeiro');
    await rpcBloqueada(eng, 'decidir_aprovacao', { p_itens: item(aguardEng, 999), p_decisao: 'aprovado', p_comentario: null, p_ip: null, p_user_agent: null }, 'engenheiro com versão forjada').catch(() => {});
    confere(antes === J([await pg(aguardAdm.id), await pg(aguardEng.id)]), 'status de algum pagamento mudou');
    // assinatura "carimbada" direto na tabela com o nome de outra pessoa
    const ass = await eng.from('assinaturas').insert({ pagamento_id: aguardAdm.id, user_id: ID.adm, etapa: 'administrador', decisao: 'aprovado' }).select();
    confere(ass.error || ass.data.length === 0, 'inseriu assinatura em nome do administrador');
  });

  await passo('isolamento por obra (engenheiro): pagamentos, documentos, assinaturas, parcelas, auditoria e notificações de obra alheia não aparecem — nem por id direto', async () => {
    const alheios = await um(admin.from('pagamentos').select('id').eq('obra_id', obraAlheia.id));
    confere(alheios.length >= 1, 'sem pagamentos alheios na base');
    const ids = alheios.map((p) => p.id);
    confere((await um(eng.from('pagamentos').select('id').in('id', ids))).length === 0, 'engenheiro leu pagamento alheio');
    confere((await um(eng.from('pagamentos').select('id').eq('obra_id', obraAlheia.id))).length === 0, 'engenheiro leu pagamentos da obra alheia');
    confere((await um(eng.from('documentos').select('id').eq('obra_id', obraAlheia.id))).length === 0, 'leu documentos de obra alheia');
    confere((await um(eng.from('assinaturas').select('id').in('pagamento_id', ids))).length === 0, 'leu assinaturas de obra alheia');
    confere((await um(eng.from('pagamento_parcelas').select('id').in('pagamento_id', ids))).length === 0, 'leu parcelas de obra alheia');
    confere((await um(eng.from('auditoria').select('id').eq('obra_id', obraAlheia.id))).length === 0, 'leu auditoria de obra alheia');
    confere((await um(eng.from('obras').select('id').eq('id', obraAlheia.id))).length === 0, 'viu a obra alheia');
    const naoMinhas = await um(eng.from('notificacoes').select('user_id'));
    confere(naoMinhas.every((n) => n.user_id === ID.eng), 'viu notificação de outro usuário');
    const rpcs = await um(eng.rpc('minhas_pendencias'));
    confere(!J(rpcs).includes(idAlheio), 'pendências trouxeram pagamento de obra alheia');
  });

  await passo('isolamento por obra (RPC): engenheiro e administradores não criam, editam, cancelam, anexam nem aprovam pagamento de obra alheia', async () => {
    const antes = J(await pg(idAlheio));
    const edit = { p_id: idAlheio, p_fornecedor_id: null, p_favorecido: 'Desviado', p_descricao: 'x', p_valor: 1, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null, p_motivo: 'invasor', p_obra_id: null };
    await rpcBloqueada(eng, 'criar_pagamento', { p_obra_id: obraAlheia.id, p_fornecedor_id: null, p_favorecido: `Intruso ${M}`, p_descricao: 'x', p_valor: 1, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null }, 'engenheiro');
    await rpcBloqueada(eng, 'atualizar_pagamento', edit, 'engenheiro');
    await rpcBloqueada(eng, 'cancelar_pagamento', { p_id: idAlheio, p_motivo: 'invasor' }, 'engenheiro');
    await rpcBloqueada(eng, 'registrar_documento', { p_pagamento_id: idAlheio, p_tipo: 'boleto', p_nome_arquivo: 'b.pdf', p_storage_path: `${obraAlheia.id}/${idAlheio}/b.pdf`, p_mime_type: 'application/pdf', p_tamanho: 10, p_sha256: 'a'.repeat(64), p_substitui_id: null, p_motivo: null }, 'engenheiro');
    await rpcBloqueada(eng, 'decidir_aprovacao', { p_itens: [{ id: idAlheio, versao: 1 }], p_decisao: 'rejeitado', p_comentario: 'invasor', p_ip: null, p_user_agent: null }, 'engenheiro');
    if (obraDoAdm2) await rpcBloqueada(adm2, 'atualizar_pagamento', { ...edit, p_id: aguardAdm.id }, 'administrador2 (obra do administrador 1)');
    await rpcBloqueada(adm, 'cancelar_pagamento', { p_id: idAlheio, p_motivo: 'invasor' }, 'administrador');
    confere(antes === J(await pg(idAlheio)), 'pagamento alheio mudou');
  });

  await passo('auditoria imutável: ninguém (nem Financeiro, nem a chave de serviço) altera, apaga ou forja registros', async () => {
    const fotoAud = await foto('auditoria');
    const ref = (await um(admin.from('auditoria').select('id, descricao').limit(1)))[0];
    for (const [nome, c] of [['engenheiro', eng], ['administrador', adm], ['suprimentos', sup], ['financeiro', fin]]) {
      const u = await c.from('auditoria').update({ descricao: 'adulterado' }).eq('id', ref.id).select();
      confere(u.error || u.data.length === 0, `${nome} alterou auditoria`);
      const d = await c.from('auditoria').delete().eq('id', ref.id).select();
      confere(d.error || d.data.length === 0, `${nome} apagou auditoria`);
      const i = await c.from('auditoria').insert({ acao: 'forjado', descricao: 'registro forjado', user_id: ID.fin }).select();
      confere(i.error || i.data.length === 0, `${nome} inseriu auditoria`);
    }
    const us = await admin.from('auditoria').update({ descricao: 'adulterado' }).eq('id', ref.id);
    confere(us.error, 'a chave de serviço conseguiu editar a auditoria');
    const ds = await admin.from('auditoria').delete().eq('id', ref.id);
    confere(ds.error, 'a chave de serviço conseguiu apagar a auditoria');
    await semPerdas('auditoria', fotoAud);
    confere((await contar('auditoria', (q) => q.eq('acao', 'forjado'))) === 0, 'registro de auditoria forjado foi gravado');
    confere((await um(admin.from('auditoria').select('descricao').eq('id', ref.id).single())).descricao === ref.descricao, 'descrição mudou');
  });

  await passo('notificações de outra pessoa: marcar como lida pelas ids do Financeiro não altera nada; escrita direta negada', async () => {
    const dele = await um(admin.from('notificacoes').select('id, lida_em, titulo').eq('user_id', ID.fin).is('lida_em', null).limit(5));
    confere(dele.length > 0, 'Financeiro sem notificação não lida na base');
    await eng.rpc('marcar_notificacoes_lidas', { p_ids: dele.map((n) => n.id) });
    const dep = await um(admin.from('notificacoes').select('id, lida_em').in('id', dele.map((n) => n.id)));
    confere(dep.every((n) => n.lida_em === null), 'engenheiro marcou como lida a notificação do Financeiro');
    const u = await eng.from('notificacoes').update({ titulo: 'forjada' }).in('id', dele.map((n) => n.id)).select();
    confere(u.error || u.data.length === 0, 'engenheiro editou notificação alheia');
    const i = await eng.from('notificacoes').insert({ user_id: ID.fin, titulo: 'phishing', mensagem: 'clique aqui', link: 'https://evil.example' }).select();
    confere(i.error || i.data.length === 0, 'engenheiro criou notificação para outro usuário (phishing interno)');
  });

  // =================== STORAGE ===================
  await passo('Storage (engenheiro): arquivos de obra alheia — baixar, assinar URL, listar, enviar e sobrescrever são negados', async () => {
    const docAlheio = (await um(admin.from('documentos').select('storage_path, obra_id').eq('obra_id', obraAlheia.id).limit(1)))[0];
    confere(docAlheio, 'sem documento de obra alheia na base');
    const b = eng.storage.from('documentos');
    confere((await b.download(docAlheio.storage_path)).error, 'baixou arquivo de obra alheia');
    confere((await b.createSignedUrl(docAlheio.storage_path, 60)).error, 'assinou URL de arquivo alheio');
    const lista = await b.list(`${obraAlheia.id}/${docAlheio.storage_path.split('/')[1]}`, { limit: 20 });
    confere(lista.error || (lista.data ?? []).length === 0, 'listou a pasta da obra alheia');
    const up = await b.upload(`${obraAlheia.id}/${idAlheio}/${M}.pdf`, new Blob(['%PDF-1.4 x'], { type: 'application/pdf' }));
    confere(up.error, 'enviou arquivo para a pasta de obra alheia');
    const sob = await b.upload(docAlheio.storage_path, new Blob(['%PDF-1.4 adulterado'], { type: 'application/pdf' }), { upsert: true });
    confere(sob.error, 'sobrescreveu arquivo de obra alheia');
    const rm = await b.remove([docAlheio.storage_path]);
    confere(rm.error || (rm.data ?? []).length === 0, 'apagou arquivo de obra alheia');
    const ainda = await admin.storage.from('documentos').download(docAlheio.storage_path);
    confere(!ainda.error, 'o arquivo alheio sumiu do Storage');
    const tr = await b.upload(`${obraEng.id}/../${obraAlheia.id}/${idAlheio}/${M}.pdf`, new Blob(['x'], { type: 'application/pdf' }));
    confere(tr.error, 'path traversal (..) foi aceito');
  });

  await passo('Storage (assinaturas): ler, sobrescrever ou apagar a imagem de assinatura de OUTRO usuário é negado; só PNG/JPEG até 2 MB', async () => {
    const b = eng.storage.from('assinaturas');
    const minha = await b.upload(`${ID.eng}/${M}.png`, new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }));
    confere(!minha.error, `não consegui enviar a minha própria assinatura (controle): ${minha.error?.message}`);
    await b.remove([`${ID.eng}/${M}.png`]);
    const alheia = await b.upload(`${ID.adm}/${M}.png`, new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }));
    confere(alheia.error, 'gravou assinatura na pasta de outro usuário');
    const lista = await b.list(ID.adm, { limit: 10 });
    confere(lista.error || (lista.data ?? []).length === 0, 'listou assinaturas de outro usuário');
    const dono = (await admin.storage.from('assinaturas').list(ID.adm)).data?.[0];
    if (dono) {
      confere((await b.download(`${ID.adm}/${dono.name}`)).error, 'baixou assinatura de outro usuário');
      const rm = await b.remove([`${ID.adm}/${dono.name}`]);
      confere(rm.error || (rm.data ?? []).length === 0, 'apagou assinatura de outro usuário');
    }
    const pdf = await b.upload(`${ID.eng}/${M}.pdf`, new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
    confere(pdf.error, 'bucket de assinaturas aceitou PDF');
    const svg = await b.upload(`${ID.eng}/${M}.svg`, new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' }));
    confere(svg.error, 'bucket de assinaturas aceitou SVG (XSS)');
    const grande = await b.upload(`${ID.eng}/${M}-grande.png`, new Blob([Buffer.alloc(2 * 1024 * 1024 + 10)], { type: 'image/png' }));
    confere(grande.error, 'bucket de assinaturas aceitou arquivo maior que 2 MB');
  });

  await passo('uploads com tipo falso: .exe, .html, .svg e .js nos documentos são recusados pelo Storage (tipo permitido: PDF, imagem, XML)', async () => {
    const b = eng.storage.from('documentos');
    for (const [nome, tipo, corpo] of [['virus.exe', 'application/x-msdownload', 'MZ'], ['pagina.html', 'text/html', '<script>alert(1)</script>'], ['x.svg', 'image/svg+xml', '<svg onload=alert(1)>'], ['x.js', 'application/javascript', 'alert(1)'], ['x.sh', 'application/x-sh', '#!/bin/sh'], ['sem-tipo.pdf', 'application/octet-stream', 'x']]) {
      const r = await b.upload(`${obraEng.id}/${idProprio}/${M}-${nome}`, new Blob([corpo], { type: tipo }));
      confere(r.error, `Storage aceitou ${nome} (${tipo})`);
    }
  });

  await passo('uploads com tipo falso (RPC): registrar_documento só aceita arquivo que existe no Storage, no caminho obra/pagamento; tipo e caminho inventados são recusados', async () => {
    // arquivo legítimo do próprio engenheiro, só para ter um objeto real no caminho certo
    const ok = `${obraEng.id}/${idProprio}/${M}-ok.pdf`;
    const up = await eng.storage.from('documentos').upload(ok, new Blob(['%PDF-1.4 teste'], { type: 'application/pdf' }));
    confere(!up.error, `controle: engenheiro devia enviar PDF na própria obra: ${up.error?.message}`);
    const base = { p_pagamento_id: idProprio, p_tipo: 'boleto', p_nome_arquivo: 'ok.pdf', p_mime_type: 'application/pdf', p_tamanho: 14, p_sha256: 'a'.repeat(64), p_substitui_id: null, p_motivo: null };
    const antes = await contar('documentos', (q) => q.eq('pagamento_id', idProprio));
    await rpcBloqueada(eng, 'registrar_documento', { ...base, p_storage_path: `${obraAlheia.id}/${idProprio}/${M}-ok.pdf` }, 'caminho de outra obra');
    await rpcBloqueada(eng, 'registrar_documento', { ...base, p_storage_path: `${obraEng.id}/${idProprio}/inexistente-${M}.pdf` }, 'arquivo inexistente');
    await rpcBloqueada(eng, 'registrar_documento', { ...base, p_storage_path: `${obraEng.id}/${idProprio}/../${M}-ok.pdf` }, 'path traversal');
    await rpcBloqueada(eng, 'registrar_documento', { ...base, p_tipo: 'comprovante', p_storage_path: ok }, 'engenheiro anexando comprovante de pagamento');
    // documento com extensão/mime perigosos declarados: precisa ser recusado (mime declarado ≠ permitido)
    const exe = await eng.rpc('registrar_documento', { ...base, p_nome_arquivo: 'virus.exe', p_mime_type: 'application/x-msdownload', p_storage_path: ok });
    confere(exe.error, 'registrar_documento aceitou nome .exe com mime application/x-msdownload (o banco não valida o tipo declarado)');
    confere((await contar('documentos', (q) => q.eq('pagamento_id', idProprio))) === antes, 'documentos foram registrados indevidamente');
  });

  await passo('RPCs aceitam lixo sem erro 500: valores negativos, textos gigantes, UUID inválido, JSON malformado e injeção SQL em parâmetros viram erro claro e não alteram dados', async () => {
    const fp = await foto('pagamentos');
    const sql = `'; drop table public.pagamentos; --`;
    const r1 = await fin.rpc('criar_pagamento', { p_obra_id: obraEng.id, p_fornecedor_id: null, p_favorecido: sql, p_descricao: sql, p_valor: -50, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: sql, p_observacoes: sql });
    confere(r1.error, 'aceitou valor negativo');
    const r2 = await fin.rpc('criar_pagamento', { p_obra_id: 'não-é-uuid', p_fornecedor_id: null, p_favorecido: 'x', p_descricao: 'x', p_valor: 1, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null });
    confere(r2.error && !/internal|stack/i.test(r2.error.message), 'UUID inválido não gerou erro tratado');
    const r3 = await fin.rpc('criar_pagamento', { p_obra_id: obraEng.id, p_fornecedor_id: null, p_favorecido: 'x', p_descricao: 'x', p_valor: 1, p_vencimento: '2026-12-30', p_forma_pagamento: 'bitcoin', p_numero_documento: null, p_observacoes: null });
    confere(r3.error, 'aceitou forma de pagamento inexistente');
    const r4 = await fin.rpc('criar_pagamento', { p_obra_id: obraEng.id, p_fornecedor_id: null, p_favorecido: 'x', p_descricao: 'x', p_valor: 1e20, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix', p_numero_documento: null, p_observacoes: null });
    confere(r4.error, 'aceitou valor absurdo (1e20)');
    const r5 = await fin.rpc('decidir_aprovacao', { p_itens: 'não é array', p_decisao: 'aprovado', p_comentario: null, p_ip: null, p_user_agent: null });
    confere(r5.error, 'aceitou itens que não são lista');
    const r6 = await eng.rpc('decidir_aprovacao', { p_itens: [{ id: `${aguardEng.id}' or '1'='1`, versao: 'x' }], p_decisao: 'aprovado', p_comentario: null, p_ip: null, p_user_agent: null });
    confere(r6.error, 'aceitou id/versão malformados');
    await semPerdas('pagamentos', fp);
    confere((await contar('pagamentos', (q) => q.like('favorecido', '%drop table%'))) === 0, 'pagamento com texto de injeção foi criado apesar do valor negativo');
    confere((await contar('pagamentos')) > 0, 'a tabela pagamentos sumiu');
  });

  await passo('injeção por filtros do PostgREST: vírgula, parêntese e ponto no valor de busca não viram filtro extra — engenheiro não enxerga obra alheia nem com "or" forjado', async () => {
    const forjados = [`x%,id.not.is.null`, `x),obra_id.eq.${obraAlheia.id},(favorecido.ilike.%`, `%`, `_`, `\\`, `'`, `"`, `;`, `a,b.c`, `)(`, '\u0000x'];
    for (const v of forjados) {
      const r = await eng.from('pagamentos').select('id, obra_id').or(`favorecido.ilike.%${v}%,descricao.ilike.%${v}%`);
      confere(r.error || r.data.every((p) => p.obra_id !== obraAlheia.id), `filtro forjado "${v}" trouxe pagamento de obra alheia`);
      confere(!r.error || /^(PGRST|22|42|XX)/.test(r.error.code), `erro inesperado: ${r.error?.message}`);
    }
    const doc = await eng.from('pagamentos').select('id').eq('id', idAlheio);
    confere(doc.data?.length === 0, 'eq direto na id alheia trouxe linha');
  });

  // Limpeza: cancela os pagamentos de teste (também prova que o Financeiro consegue o que o invasor não consegue)
  await passo('limpeza: o Financeiro cancela os pagamentos de teste e apaga o fornecedor forjado (controle positivo)', async () => {
    for (const id of [idAlheio, idProprio]) await um(fin.rpc('cancelar_pagamento', { p_id: id, p_motivo: 'limpeza do teste de segurança' }));
    await admin.from('fornecedores').delete().like('nome', `Forja%${M}`);
    confere((await pg(idAlheio)).status === 'cancelado', 'não cancelou');
  });
});
