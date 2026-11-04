// Testes de integração das regras do banco (RLS, fluxos A/B/C, assinaturas,
// versões e auditoria) contra um Supabase real (local: `npx supabase start`).
//
// Uso: npm run test:integracao
// ATENÇÃO: cria usuários e dados de teste. Rode apenas no ambiente local.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321'
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SECRET = process.env.SUPABASE_SECRET_KEY
if (!PUB || !SECRET) throw new Error('Defina as variáveis do .env.local (node --env-file=.env.local).')
if (!/127\.0\.0\.1|localhost/.test(URL)) throw new Error('Os testes de integração só rodam contra o Supabase local.')

const admin = createClient(URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } })
const sufixo = randomUUID().slice(0, 8)
const SENHA = 'Senha-Teste-123'
const u = {} // perfil -> { id, client }

async function criarUsuario(chave, perfil, nome) {
  const email = `${chave}-${sufixo}@teste.local`
  const { data, error } = await admin.auth.admin.createUser({ email, password: SENHA, email_confirm: true })
  if (error) throw error
  const { error: e2 } = await admin.from('profiles').insert({
    id: data.user.id, nome, email, perfil, troca_senha_pendente: false,
  })
  if (e2) throw e2
  const client = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error: e3 } = await client.auth.signInWithPassword({ email, password: SENHA })
  if (e3) throw e3
  u[chave] = { id: data.user.id, client, email }
}

async function rpc(chave, fn, args) {
  const { data, error } = await u[chave].client.rpc(fn, args)
  if (error) throw new Error(error.message)
  return data
}

async function rpcFalha(chave, fn, args, trecho) {
  const { error } = await u[chave].client.rpc(fn, args)
  assert.ok(error, `esperava erro em ${fn} por ${chave}`)
  if (trecho) assert.match(error.message, trecho)
}

async function pagamento(id) {
  const { data, error } = await admin.from('pagamentos').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

async function anexar(chave, pag, tipo = 'boleto', substitui = null, motivo = null) {
  const conteudo = Buffer.from(`%PDF-1.4 teste ${randomUUID()}`)
  const path = `${pag.obra_id}/${pag.id}/${randomUUID()}.pdf`
  const { error } = await u[chave].client.storage.from('documentos').upload(path, conteudo, { contentType: 'application/pdf' })
  if (error) throw new Error('upload: ' + error.message)
  return rpc(chave, 'registrar_documento', {
    p_pagamento_id: pag.id, p_tipo: tipo, p_nome_arquivo: `${tipo}.pdf`, p_storage_path: path,
    p_mime_type: 'application/pdf', p_tamanho: conteudo.length,
    p_sha256: createHash('sha256').update(conteudo).digest('hex'),
    p_substitui_id: substitui, p_motivo: motivo,
  })
}

function novoPagamento(chave, obraId, valor = 1500) {
  return rpc(chave, 'criar_pagamento', {
    p_obra_id: obraId, p_fornecedor_id: null, p_favorecido: 'Concreteira Teste', p_descricao: 'Concreto usinado',
    p_valor: valor, p_vencimento: '2026-12-10', p_forma_pagamento: 'boleto',
  })
}

let obraA, obraB, obraC

before(async () => {
  await criarUsuario('fin', 'financeiro', 'Fin Teste')
  await criarUsuario('sup', 'suprimentos', 'Sup Teste')
  await criarUsuario('eng', 'engenheiro', 'Eng Teste')
  await criarUsuario('adm', 'administrador', 'Adm Teste')
  await criarUsuario('adm2', 'administrador', 'Adm2 Teste')

  const ins = async (obra) => {
    const { data, error } = await u.fin.client.from('obras').insert(obra).select().single()
    if (error) throw error
    return data
  }
  obraA = await ins({ nome: `Obra A ${sufixo}`, cidade: 'Salvador', uf: 'BA', fluxo: 'A', engenheiro_id: u.eng.id, administrador_id: u.adm.id })
  obraB = await ins({ nome: `Obra B ${sufixo}`, cidade: 'Feira de Santana', uf: 'BA', fluxo: 'B', administrador_id: u.adm2.id })
  obraC = await ins({ nome: `Obra C ${sufixo}`, cidade: 'Aracaju', uf: 'SE', fluxo: 'C' })
  const { error } = await u.fin.client.from('obra_acessos').insert({ obra_id: obraA.id, user_id: u.sup.id })
  if (error) throw error
})

test('somente o Financeiro cria obras e concede acessos', async () => {
  const { error } = await u.sup.client.from('obras').insert({ nome: 'X', cidade: 'X', uf: 'BA' })
  assert.ok(error)
  const { error: e2 } = await u.sup.client.from('obra_acessos').insert({ obra_id: obraB.id, user_id: u.sup.id })
  assert.ok(e2)
})

test('fluxo A exige engenheiro e administrador', async () => {
  const { error } = await u.fin.client.from('obras').insert({ nome: 'Sem resp', cidade: 'X', uf: 'BA', fluxo: 'A' })
  assert.ok(error)
})

test('obra só aceita responsável com o perfil correto', async () => {
  const { error } = await u.fin.client.from('obras').insert({
    nome: 'Errada', cidade: 'X', uf: 'BA', fluxo: 'B', administrador_id: u.eng.id,
  })
  assert.match(error.message, /administrador/i)
})

test('Suprimentos vê todas as obras, mas só atua nas liberadas', async () => {
  const { data } = await u.sup.client.from('obras').select('id').in('id', [obraA.id, obraB.id, obraC.id])
  assert.equal(data.length, 3)
  await novoPagamento('sup', obraA.id)
  await rpcFalha('sup', 'criar_pagamento', {
    p_obra_id: obraB.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'X',
    p_valor: 10, p_vencimento: '2026-12-10', p_forma_pagamento: 'pix',
  }, /permissão/)
})

test('engenheiro e administrador só veem as próprias obras', async () => {
  const { data: e } = await u.eng.client.from('obras').select('id')
  assert.deepEqual(e.map((o) => o.id), [obraA.id])
  const { data: a2 } = await u.adm2.client.from('obras').select('id')
  assert.deepEqual(a2.map((o) => o.id), [obraB.id])
})

test('ninguém grava pagamentos diretamente na tabela', async () => {
  const { error } = await u.fin.client.from('pagamentos').insert({
    obra_id: obraC.id, favorecido: 'X', descricao: 'X', valor: 1, vencimento: '2026-12-01', fluxo: 'C',
    status: 'pago', created_by: u.fin.id,
  })
  assert.ok(error)
  const id = await novoPagamento('fin', obraC.id)
  const { data } = await u.fin.client.from('pagamentos').update({ status: 'pago' }).eq('id', id).select()
  assert.equal(data?.length ?? 0, 0)
  assert.equal((await pagamento(id)).status, 'aguardando_pagamento')
})

test('engenheiro não cadastra pagamentos', async () => {
  await rpcFalha('eng', 'criar_pagamento', {
    p_obra_id: obraA.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'X',
    p_valor: 10, p_vencimento: '2026-12-10', p_forma_pagamento: 'pix',
  }, /permissão/)
})

test('fluxo A completo: engenheiro → administrador → financeiro → pago', async () => {
  const id = await novoPagamento('sup', obraA.id, 2345.67)
  let p = await pagamento(id)
  assert.equal(p.status, 'aguardando_engenheiro')
  const docId = await anexar('sup', p, 'boleto')

  // administrador de outra obra não vê nada
  const { data: vis } = await u.adm2.client.from('pagamentos').select('id').eq('id', id)
  assert.equal(vis.length, 0)
  const { data: docs } = await u.adm2.client.from('documentos').select('storage_path').eq('pagamento_id', id)
  assert.equal(docs.length, 0)
  const { data: doc } = await admin.from('documentos').select('storage_path').eq('id', docId).single()
  const { error: dlErr } = await u.adm2.client.storage.from('documentos').download(doc.storage_path)
  assert.ok(dlErr, 'adm2 não pode baixar arquivo de outra obra')
  const { error: dlOk } = await u.eng.client.storage.from('documentos').download(doc.storage_path)
  assert.equal(dlOk, null)

  // engenheiro recebe notificação
  const { data: notifEng } = await u.eng.client.from('notificacoes').select('*').eq('pagamento_id', id)
  assert.equal(notifEng.length, 1)

  // administrador não pode pular a etapa do engenheiro
  await rpcFalha('adm', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado' }, /não está aguardando/)
  // versão desatualizada é recusada
  await rpcFalha('eng', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao + 5 }], p_decisao: 'aprovado' }, /alterado/)

  await rpc('eng', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado', p_ip: '10.0.0.1' })
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_administrador')

  await rpc('adm', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado' })
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_pagamento')

  const { data: assin } = await u.fin.client.from('assinaturas').select('*').eq('pagamento_id', id).order('created_at')
  assert.equal(assin.length, 2)
  assert.match(assin[0].hash_integridade, /^[0-9a-f]{64}$/)
  assert.equal(assin[0].conteudo_assinado.documentos.length, 1)

  // financeiro foi notificado
  const { data: notifFin } = await u.fin.client.from('notificacoes').select('*').eq('pagamento_id', id)
  assert.ok(notifFin.some((n) => /liberado/i.test(n.titulo)))

  // só o financeiro dá baixa
  await rpcFalha('sup', 'registrar_baixa', { p_id: id, p_pago_em: '2026-12-09' }, /Financeiro/)
  await rpc('fin', 'registrar_baixa', { p_id: id, p_pago_em: '2026-12-09' })
  await anexar('fin', await pagamento(id), 'comprovante')
  p = await pagamento(id)
  assert.equal(p.status, 'pago')
  assert.equal(Number(p.valor_pago), 2345.67)

  // documento de pagamento pago não é mais alterado
  await assert.rejects(() => anexar('sup', p, 'outro'), /pagos ou cancelados/)

  const { data: tl } = await u.eng.client.from('auditoria').select('acao').eq('pagamento_id', id).order('id')
  assert.deepEqual(tl.map((t) => t.acao), ['criou', 'anexou_documento', 'assinou', 'assinou', 'baixa', 'anexou_documento'])
})

test('substituir documento após assinatura gera nova versão e reinicia o fluxo', async () => {
  const id = await novoPagamento('sup', obraA.id)
  let p = await pagamento(id)
  const doc1 = await anexar('sup', p)
  await rpc('eng', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado' })
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_administrador')

  await assert.rejects(() => anexar('sup', p, 'boleto', doc1, null), /motivo/)
  const doc2 = await anexar('sup', p, 'boleto', doc1, 'Boleto com valor errado')
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_engenheiro')
  assert.equal(p.versao, 2)

  const { data: docs } = await admin.from('documentos').select('*').eq('pagamento_id', id).order('versao')
  assert.equal(docs.length, 2)
  assert.equal(docs[0].ativo, false)
  assert.equal(docs[0].substituido_por, doc2)
  assert.equal(docs[1].versao, 2)

  // a assinatura antiga continua registrada com a versão 1
  const { data: assin } = await admin.from('assinaturas').select('pagamento_versao').eq('pagamento_id', id)
  assert.deepEqual(assin.map((a) => a.pagamento_versao), [1])
})

test('alterar valor após assinatura gera nova versão; observação não', async () => {
  const id = await novoPagamento('sup', obraA.id, 100)
  let p = await pagamento(id)
  await rpc('eng', 'decidir_aprovacao', { p_itens: [{ id, versao: 1 }], p_decisao: 'aprovado' })
  const base = {
    p_id: id, p_fornecedor_id: null, p_favorecido: p.favorecido, p_descricao: p.descricao, p_valor: 100,
    p_vencimento: p.vencimento, p_forma_pagamento: p.forma_pagamento, p_numero_documento: null,
  }
  await rpc('sup', 'atualizar_pagamento', { ...base, p_observacoes: 'só uma nota' })
  p = await pagamento(id)
  assert.equal(p.versao, 1)
  assert.equal(p.status, 'aguardando_administrador')

  await rpc('sup', 'atualizar_pagamento', { ...base, p_valor: 150, p_observacoes: 'só uma nota', p_motivo: 'reajuste' })
  p = await pagamento(id)
  assert.equal(p.versao, 2)
  assert.equal(p.status, 'aguardando_engenheiro')
  const { data: aud } = await admin.from('auditoria').select('*').eq('pagamento_id', id).eq('acao', 'alterou')
  assert.ok(aud.some((a) => Number(a.dados_antes.valor) === 100 && Number(a.dados_depois.valor) === 150))
})

test('assinatura em lote gera um registro por documento', async () => {
  const id1 = await novoPagamento('sup', obraA.id, 10)
  const id2 = await novoPagamento('sup', obraA.id, 20)
  const lote = await rpc('eng', 'decidir_aprovacao', {
    p_itens: [{ id: id1, versao: 1 }, { id: id2, versao: 1 }], p_decisao: 'aprovado',
  })
  const { data } = await admin.from('assinaturas').select('pagamento_id, lote_id').eq('lote_id', lote)
  assert.equal(data.length, 2)
  assert.equal((await pagamento(id1)).status, 'aguardando_administrador')
  assert.equal((await pagamento(id2)).status, 'aguardando_administrador')
})

test('lote é atômico: um item inválido cancela todos', async () => {
  const ok = await novoPagamento('sup', obraA.id, 30)
  const outro = await novoPagamento('fin', obraB.id, 40)
  await rpcFalha('eng', 'decidir_aprovacao', {
    p_itens: [{ id: ok, versao: 1 }, { id: outro, versao: 1 }], p_decisao: 'aprovado',
  })
  assert.equal((await pagamento(ok)).status, 'aguardando_engenheiro')
})

test('fluxo B vai direto ao administrador; rejeição e reenvio', async () => {
  const id = await novoPagamento('fin', obraB.id)
  assert.equal((await pagamento(id)).status, 'aguardando_administrador')
  await rpcFalha('adm2', 'decidir_aprovacao', { p_itens: [{ id, versao: 1 }], p_decisao: 'rejeitado' }, /motivo/)
  await rpc('adm2', 'decidir_aprovacao', { p_itens: [{ id, versao: 1 }], p_decisao: 'rejeitado', p_comentario: 'NF divergente' })
  let p = await pagamento(id)
  assert.equal(p.status, 'rejeitado')
  assert.equal(p.rejeicao_motivo, 'NF divergente')
  await rpc('fin', 'reenviar_pagamento', { p_id: id, p_observacao: 'NF corrigida' })
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_administrador')
  assert.equal(p.versao, 2)
})

test('fluxo C vai direto ao financeiro', async () => {
  const id = await novoPagamento('fin', obraC.id)
  assert.equal((await pagamento(id)).status, 'aguardando_pagamento')
})

test('alterar o fluxo da obra reencaminha pendências', async () => {
  const { data: obra } = await u.fin.client.from('obras').insert({
    nome: `Obra D ${sufixo}`, cidade: 'Salvador', uf: 'BA', fluxo: 'A', engenheiro_id: u.eng.id, administrador_id: u.adm.id,
  }).select().single()
  const id = await novoPagamento('fin', obra.id)
  assert.equal((await pagamento(id)).status, 'aguardando_engenheiro')
  const { error } = await u.fin.client.from('obras').update({ fluxo: 'B' }).eq('id', obra.id)
  assert.equal(error, null)
  assert.equal((await pagamento(id)).status, 'aguardando_administrador')
  const { data: aud } = await admin.from('auditoria').select('*').eq('entidade', 'obras').eq('entidade_id', obra.id).eq('acao', 'alterou')
  assert.equal(aud[0].dados_antes.fluxo, 'A')
  assert.equal(aud[0].dados_depois.fluxo, 'B')
})

test('auditoria é imutável, inclusive para a chave de serviço', async () => {
  const { data } = await admin.from('auditoria').select('id').limit(1).single()
  const { error } = await admin.from('auditoria').delete().eq('id', data.id)
  assert.match(error.message, /não pode ser alterado/)
  const { error: e2 } = await admin.from('auditoria').update({ acao: 'x' }).eq('id', data.id)
  assert.match(e2.message, /não pode ser alterado/)
})

test('Suprimentos não vê a auditoria geral nem cria usuários', async () => {
  const { data } = await u.sup.client.from('auditoria').select('id').eq('entidade', 'profiles')
  assert.equal(data.length, 0)
  const { error } = await u.sup.client.from('profiles').insert({ id: randomUUID(), nome: 'x', email: 'x@x', perfil: 'financeiro' })
  assert.ok(error)
})

test('usuário desativado perde o acesso imediatamente', async () => {
  await criarUsuario('eng2', 'engenheiro', 'Eng2 Teste')
  await u.fin.client.from('obra_acessos').insert({ obra_id: obraA.id, user_id: u.eng2.id })
  let { data } = await u.eng2.client.from('obras').select('id')
  assert.equal(data.length, 1)
  const { error } = await u.fin.client.from('profiles').update({ ativo: false }).eq('id', u.eng2.id)
  assert.equal(error, null)
  ;({ data } = await u.eng2.client.from('obras').select('id'))
  assert.equal(data.length, 0)
})

test('financeiro não pode rebaixar o próprio perfil', async () => {
  const { error } = await u.fin.client.from('profiles').update({ perfil: 'engenheiro' }).eq('id', u.fin.id)
  assert.match(error.message, /próprio perfil/)
})

test('visitante sem login não acessa nada', async () => {
  const anon = createClient(URL, PUB, { auth: { persistSession: false } })
  const { data } = await anon.from('pagamentos').select('id')
  assert.equal(data?.length ?? 0, 0)
  const { error } = await anon.rpc('criar_pagamento', {
    p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'X',
    p_valor: 10, p_vencimento: '2026-12-10', p_forma_pagamento: 'pix',
  })
  assert.ok(error)
})
