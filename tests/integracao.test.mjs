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

// -----------------------------------------------------------------------------
// Ordens de Pagamento (OP)
// -----------------------------------------------------------------------------
const itensOP = [
  { descricao: 'Diária de pedreiro', unidade: 'dia', quantidade: 5, valor_unitario: 180 },
  { descricao: 'Ajudante', unidade: 'dia', quantidade: 5, valor_unitario: 120.5 },
]
function salvarOP(chave, obraId, extra = {}) {
  return rpc(chave, 'salvar_op', {
    p_id: null, p_obra_id: obraId, p_favorecido: 'João da Silva', p_cpf_cnpj: '123.456.789-09',
    p_descricao: 'Mão de obra avulsa — juntas', p_vencimento: '2026-12-15', p_forma_pagamento: 'pix',
    p_dados_bancarios: 'PIX 123.456.789-09', p_observacoes: null, p_itens: itensOP, ...extra,
  })
}

test('OP: só o engenheiro vinculado cria; rascunho é privado', async () => {
  await rpcFalha('sup', 'salvar_op', {
    p_id: null, p_obra_id: obraA.id, p_favorecido: 'X', p_cpf_cnpj: null, p_descricao: 'X', p_vencimento: null,
    p_forma_pagamento: 'pix', p_dados_bancarios: null, p_observacoes: null, p_itens: itensOP,
  }, /engenheiros/)
  await rpcFalha('eng', 'salvar_op', {
    p_id: null, p_obra_id: obraB.id, p_favorecido: 'X', p_cpf_cnpj: null, p_descricao: 'X', p_vencimento: null,
    p_forma_pagamento: 'pix', p_dados_bancarios: null, p_observacoes: null, p_itens: itensOP,
  }, /vinculado/)
  const id = await salvarOP('eng', obraA.id)
  const { data: vAdm } = await u.adm.client.from('ordens_pagamento').select('id').eq('id', id)
  assert.equal(vAdm.length, 0)
  const { data: vEng } = await u.eng.client.from('ordens_pagamento').select('*, ordem_itens(total)').eq('id', id).single()
  assert.equal(vEng.status, 'em_elaboracao')
  assert.equal(vEng.ordem_itens.reduce((s, i) => s + Number(i.total), 0), 1502.5)
  await rpc('eng', 'excluir_op', { p_id: id })
})

test('OP: envio cria pagamento direto ao administrador e acompanha o status até paga', async () => {
  const id = await salvarOP('eng', obraA.id)
  const pagId = await rpc('eng', 'enviar_op', { p_id: id })
  await rpcFalha('eng', 'salvar_op', {
    p_id: id, p_obra_id: obraA.id, p_favorecido: 'X', p_cpf_cnpj: null, p_descricao: 'X', p_vencimento: null,
    p_forma_pagamento: 'pix', p_dados_bancarios: null, p_observacoes: null, p_itens: itensOP,
  }, /já foi enviada/)
  let p = await pagamento(pagId)
  assert.equal(p.status, 'aguardando_administrador') // obra é fluxo A, mas a OP vai direto ao administrador
  assert.equal(Number(p.valor), 1502.5)
  assert.equal(p.created_by, u.eng.id)
  const op = async () => (await admin.from('ordens_pagamento').select('*').eq('id', id).single()).data
  assert.match((await op()).numero, /^OP-\d{4}-\d{5}$/)
  assert.equal(p.numero_documento, (await op()).numero)
  assert.equal((await op()).status, 'enviada')

  // engenheiro anexa o PDF da OP
  await anexar('eng', p, 'ordem_pagamento')
  // mas não anexa em outros pagamentos da obra
  const outro = await pagamento(await novoPagamento('sup', obraA.id))
  await assert.rejects(() => anexar('eng', outro, 'outro'), /permissão|upload/)

  await rpc('adm', 'marcar_op_em_analise', { p_pagamento_id: pagId })
  assert.equal((await op()).status, 'em_analise')
  await rpc('adm', 'decidir_aprovacao', { p_itens: [{ id: pagId, versao: 1 }], p_decisao: 'aprovado' })
  assert.equal((await op()).status, 'aprovada')
  const { data: n } = await u.eng.client.from('notificacoes').select('titulo').eq('pagamento_id', pagId)
  assert.ok(n.some((x) => /aprovada/.test(x.titulo)))
  await rpc('fin', 'registrar_baixa', { p_id: pagId, p_pago_em: '2026-12-14' })
  assert.equal((await op()).status, 'paga')
})

test('OP: rejeição pelo administrador', async () => {
  const id = await salvarOP('eng', obraA.id)
  const pagId = await rpc('eng', 'enviar_op', { p_id: id })
  await rpc('adm', 'decidir_aprovacao', { p_itens: [{ id: pagId, versao: 1 }], p_decisao: 'rejeitado', p_comentario: 'Sem medição' })
  const { data } = await admin.from('ordens_pagamento').select('status').eq('id', id).single()
  assert.equal(data.status, 'rejeitada')
})

test('OP: obra sem administrador segue ao Financeiro', async () => {
  const { data: obra } = await u.fin.client.from('obras').insert({ nome: `Obra E ${sufixo}`, cidade: 'Lauro de Freitas', uf: 'BA', fluxo: 'C' }).select().single()
  await u.fin.client.from('obra_acessos').insert({ obra_id: obra.id, user_id: u.eng.id })
  const id = await salvarOP('eng', obra.id)
  const pagId = await rpc('eng', 'enviar_op', { p_id: id })
  assert.equal((await pagamento(pagId)).status, 'aguardando_pagamento')
})

// -----------------------------------------------------------------------------
// Inteligência de Compras
// -----------------------------------------------------------------------------
test('NF: registro de itens, duplicidade de chave, acesso e substituição', async () => {
  const pagId = await novoPagamento('sup', obraA.id)
  const p = await pagamento(pagId)
  const docId = await anexar('sup', p, 'nota_fiscal')
  const chave = ('2926111234567800019055001' + Date.now() + '0000000000').slice(0, 44)
  const nota = { chave, numero: '1234', serie: '1', data_emissao: '2026-11-01', emitente_cnpj: '12.345.678/0001-90', emitente_nome: 'Concreteira', emitente_uf: 'BA', valor_total: 1500 }
  const itens = [{ numero_item: 1, descricao: 'Concreto FCK 30', descricao_normalizada: 'concreto fck 30', unidade: 'm3', quantidade: 3, valor_unitario: 500, valor_total: 1500 }]
  await rpcFalha('eng', 'registrar_nf', { p_documento_id: docId, p_nota: nota, p_itens: itens, p_origem: 'xml' })
  await rpc('sup', 'registrar_nf', { p_documento_id: docId, p_nota: nota, p_itens: itens, p_origem: 'xml' })

  const p2 = await pagamento(await novoPagamento('sup', obraA.id))
  const doc2 = await anexar('sup', p2, 'nota_fiscal')
  await rpcFalha('sup', 'registrar_nf', { p_documento_id: doc2, p_nota: nota, p_itens: itens, p_origem: 'xml' }, /já foi registrada/)

  const { data: vf } = await u.fin.client.from('compras_itens').select('*').eq('nota_id', (await admin.from('nf_notas').select('id').eq('chave', chave).single()).data.id)
  assert.equal(vf.length, 1)
  assert.equal(vf[0].cidade, 'Salvador')
  assert.equal(vf[0].unidade, 'M3')
  const { data: ve } = await u.eng.client.from('compras_itens').select('id')
  assert.equal(ve.length, 0)

  await anexar('sup', p, 'nota_fiscal', docId, 'NF cancelada e reemitida')
  const { data: inativa } = await admin.from('nf_notas').select('ativa').eq('chave', chave).single()
  assert.equal(inativa.ativa, false)
  // com a anterior inativa, a mesma chave pode ser registrada de novo
  await rpc('sup', 'registrar_nf', { p_documento_id: doc2, p_nota: nota, p_itens: itens, p_origem: 'xml' })
})

test('lembretes diários avisam o Financeiro e os assinantes uma vez por dia', async () => {
  const id = await novoPagamento('sup', obraA.id)
  await admin.rpc('gerar_lembretes_diarios')
  await admin.rpc('gerar_lembretes_diarios')
  const hoje = new Date().toISOString().slice(0, 10)
  const { data } = await u.eng.client.from('notificacoes').select('titulo, created_at').eq('titulo', 'Documentos aguardando sua assinatura')
  assert.equal(data.length, 1)
  await rpcFalha('fin', 'gerar_lembretes_diarios', {})
  assert.ok(id && hoje)
})

// -----------------------------------------------------------------------------
// Modelo oficial da OP: referência, desconto, início e salário por item
// -----------------------------------------------------------------------------
test('OP: desconto reduz o valor do pagamento; campos do modelo são gravados', async () => {
  const itens = [{ descricao: 'Cabo de turma', unidade: 'UNID.', quantidade: 1, valor_unitario: 1410.02, inicio: '2026-08-21', salario: 3525.04 }]
  const base = { p_id: null, p_obra_id: obraA.id, p_favorecido: 'João Teste', p_cpf_cnpj: null, p_descricao: 'Adiantamento de salário',
    p_vencimento: '2026-12-20', p_forma_pagamento: 'pix', p_dados_bancarios: 'PIX (71) 99999-0000', p_observacoes: null, p_itens: itens }
  await rpcFalha('eng', 'salvar_op', { ...base, p_desconto: 5000, p_referencia: 'OUTUBRO' }, /maior que o subtotal/)
  const id = await rpc('eng', 'salvar_op', { ...base, p_desconto: 10, p_referencia: 'OUTUBRO' })
  const pagId = await rpc('eng', 'enviar_op', { p_id: id })
  const p = await pagamento(pagId)
  assert.equal(Number(p.valor), 1400.02)
  const { data: op } = await admin.from('ordens_pagamento').select('referencia, desconto').eq('id', id).single()
  assert.equal(op.referencia, 'OUTUBRO')
  assert.equal(Number(op.desconto), 10)
  const { data: it } = await admin.from('ordem_itens').select('inicio, salario').eq('ordem_id', id)
  assert.equal(it[0].inicio, '2026-08-21')
  assert.equal(Number(it[0].salario), 3525.04)
})

// -----------------------------------------------------------------------------
// Administrador master
// -----------------------------------------------------------------------------
test('administrador master: vê e dá baixa em todas as obras, mas não cria obras', async () => {
  await criarUsuario('master', 'administrador_master', 'Master Teste')
  const { data: vis } = await u.master.client.from('obras').select('id').in('id', [obraA.id, obraB.id, obraC.id])
  assert.equal(vis.length, 3)
  const { error: eObra } = await u.master.client.from('obras').insert({ nome: 'X', cidade: 'X', uf: 'BA' })
  assert.ok(eObra)
  // obraC não é administrada pelo master: mesmo assim pode dar baixa
  const id = await novoPagamento('fin', obraC.id)
  await rpc('fin', 'registrar_baixa', { p_id: id, p_pago_em: '2026-12-01' }).catch(() => {})
  await pagamento(id).then((p) => assert.ok(p))
  const { data: pendentes } = await u.master.client.rpc('minhas_pendencias')
  assert.ok(Array.isArray(pendentes))
  const idPag = await novoPagamento('fin', obraC.id)
  await rpc('master', 'registrar_baixa', { p_id: idPag, p_pago_em: '2026-12-02' })
  assert.equal((await pagamento(idPag)).status, 'pago')
})

test('administrador master pode ser responsável pela obra', async () => {
  const { data, error } = await u.fin.client.from('obras').insert({
    nome: `Obra M ${sufixo}`, cidade: 'Salvador', uf: 'BA', fluxo: 'B', administrador_id: u.master.id,
  }).select().single()
  assert.equal(error, null)
  assert.ok(data.id)
})
