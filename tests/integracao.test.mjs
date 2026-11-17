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

  await anexar('eng', p, 'documento_assinado') // o engenheiro assina o documento antes de aprovar
  await rpc('eng', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado', p_ip: '10.0.0.1' })
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_administrador')

  await anexar('adm', p, 'documento_assinado')
  await rpc('adm', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado' })
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_pagamento')

  const { data: assin } = await u.fin.client.from('assinaturas').select('*').eq('pagamento_id', id).order('created_at')
  assert.equal(assin.length, 2)
  assert.match(assin[0].hash_integridade, /^[0-9a-f]{64}$/)
  // o conteúdo assinado inclui o documento original e a versão assinada pelo engenheiro
  assert.equal(assin[0].conteudo_assinado.documentos.length, 2)

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
  assert.deepEqual(tl.map((t) => t.acao), ['criou', 'anexou_documento', 'anexou_documento', 'assinou', 'anexou_documento', 'assinou', 'baixa', 'anexou_documento'])
})

test('substituir documento após assinatura gera nova versão e reinicia o fluxo', async () => {
  const id = await novoPagamento('sup', obraA.id)
  let p = await pagamento(id)
  const doc1 = await anexar('sup', p)
  await anexar('eng', p, 'documento_assinado')
  await rpc('eng', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado' })
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_administrador')

  await assert.rejects(() => anexar('sup', p, 'boleto', doc1, null), /motivo/)
  const doc2 = await anexar('sup', p, 'boleto', doc1, 'Boleto com valor errado')
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_engenheiro')
  assert.equal(p.versao, 2)

  const { data: docs } = await admin.from('documentos').select('*').eq('pagamento_id', id).eq('tipo', 'boleto').order('versao')
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
  await rpcFalha('adm', 'salvar_op', {
    p_id: null, p_obra_id: obraA.id, p_favorecido: 'X', p_cpf_cnpj: null, p_descricao: 'X', p_vencimento: null,
    p_forma_pagamento: 'pix', p_dados_bancarios: null, p_observacoes: null, p_itens: itensOP,
  }, /perfil/)
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
  const pagId = await enviarOPEng(id)
  await rpcFalha('eng', 'salvar_op', {
    p_id: id, p_obra_id: obraA.id, p_favorecido: 'X', p_cpf_cnpj: null, p_descricao: 'X', p_vencimento: null,
    p_forma_pagamento: 'pix', p_dados_bancarios: null, p_observacoes: null, p_itens: itensOP,
  }, /já foi enviada/)
  let p = await pagamento(pagId)
  assert.equal(p.status, 'aguardando_administrador') // o engenheiro criador assinou na solicitação; a etapa dele já está concluída
  assert.equal(Number(p.valor), 1502.5)
  assert.equal(p.created_by, u.eng.id)
  const op = async () => (await admin.from('ordens_pagamento').select('*').eq('id', id).single()).data
  assert.match((await op()).numero, /^OP-\d{4}-\d{5}$/)
  assert.equal(p.numero_documento, (await op()).numero)
  assert.equal((await op()).status, 'enviada')

  // o PDF da OP já foi registrado no envio; o engenheiro não anexa em outros pagamentos da obra
  const outro = await pagamento(await novoPagamento('sup', obraA.id))
  await assert.rejects(() => anexar('eng', outro, 'outro'), /permissão|upload/)

  await rpc('adm', 'marcar_op_em_analise', { p_pagamento_id: pagId })
  assert.equal((await op()).status, 'em_analise')
  // o PDF da OP também é assinado por quem aprova: o administrador assina antes de aprovar
  await anexar('adm', p, 'documento_assinado')
  await rpc('adm', 'decidir_aprovacao', { p_itens: [{ id: pagId, versao: 1 }], p_decisao: 'aprovado' })
  assert.equal((await op()).status, 'aprovada')
  const { data: n } = await u.eng.client.from('notificacoes').select('titulo').eq('pagamento_id', pagId)
  assert.ok(n.some((x) => /aprovada/.test(x.titulo)))
  await rpc('fin', 'registrar_baixa', { p_id: pagId, p_pago_em: '2026-12-14' })
  assert.equal((await op()).status, 'paga')
})

test('OP: administrador rejeita a OP enviada pelo engenheiro criador', async () => {
  const id = await salvarOP('eng', obraA.id)
  const pagId = await enviarOPEng(id)
  await rpc('adm', 'marcar_op_em_analise', { p_pagamento_id: pagId })
  await rpc('adm', 'decidir_aprovacao', { p_itens: [{ id: pagId, versao: 1 }], p_decisao: 'rejeitado', p_comentario: 'Sem medição' })
  const { data } = await admin.from('ordens_pagamento').select('status').eq('id', id).single()
  assert.equal(data.status, 'rejeitada')
})

test('OP: obra sem administrador segue ao Financeiro', async () => {
  const { data: obra } = await u.fin.client.from('obras').insert({ nome: `Obra E ${sufixo}`, cidade: 'Lauro de Freitas', uf: 'BA', fluxo: 'C' }).select().single()
  await u.fin.client.from('obra_acessos').insert({ obra_id: obra.id, user_id: u.eng.id })
  const id = await salvarOP('eng', obra.id)
  const pagId = await enviarOPEng(id)
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
  const pagId = await enviarOPEng(id)
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

// -----------------------------------------------------------------------------
// Alteração de pagamento liberado ou pago (sem nova aprovação, com motivo)
// -----------------------------------------------------------------------------
test('pagamento pago: Financeiro altera obra e valor com motivo, sem nova aprovação', async () => {
  const id = await novoPagamento('fin', obraC.id, 500) // fluxo C: já liberado para pagamento
  const antes = await pagamento(id)
  const base = { p_id: id, p_fornecedor_id: null, p_favorecido: antes.favorecido, p_descricao: antes.descricao,
    p_valor: 500, p_vencimento: antes.vencimento, p_forma_pagamento: antes.forma_pagamento, p_numero_documento: null, p_observacoes: null }
  await rpcFalha('fin', 'atualizar_pagamento', { ...base, p_valor: 520 }, /motivo/)
  await rpc('fin', 'atualizar_pagamento', { ...base, p_valor: 520, p_motivo: 'Reajuste acordado', p_obra_id: obraA.id })
  const depois = await pagamento(id)
  assert.equal(depois.status, 'aguardando_pagamento')
  assert.equal(depois.versao, antes.versao)
  assert.equal(depois.obra_id, obraA.id)
  assert.equal(Number(depois.valor), 520)
  await rpc('fin', 'registrar_baixa', { p_id: id, p_pago_em: '2026-12-03' })
  await rpcFalha('fin', 'atualizar_pagamento', { ...base, p_valor: 530 }, /motivo/)
  await rpc('fin', 'atualizar_pagamento', { ...base, p_valor: 530, p_motivo: 'Correção de valor' })
  const pago = await pagamento(id)
  assert.equal(pago.status, 'pago')
  assert.equal(Number(pago.valor), 530)
})

// -----------------------------------------------------------------------------
// Pagamento parcelado
// -----------------------------------------------------------------------------
test('parcelas: soma confere, multa/desconto exigem motivo, aprovação não muda', async () => {
  const id = await novoPagamento('fin', obraC.id, 900)
  const antes = await pagamento(id)
  const p = (valor, venc, extra = {}) => ({ valor, vencimento: venc, ...extra })
  await rpcFalha('fin', 'definir_parcelas', { p_pagamento_id: id, p_parcelas: [p(400, '2026-12-10'), p(200, '2026-12-20')] }, /não confere/)
  await rpcFalha('fin', 'definir_parcelas', { p_pagamento_id: id, p_parcelas: [p(400, '2026-12-10', { multa: 20 }), p(500, '2026-12-20')] }, /motivo/)
  await rpc('fin', 'definir_parcelas', { p_pagamento_id: id, p_parcelas: [
    p(400, '2026-12-10'),
    p(500, '2026-12-20', { juros: 15, motivo: 'Juros por atraso da parcela anterior' }),
  ] })
  const { data: par } = await admin.from('pagamento_parcelas').select('numero, valor_base, juros, vencimento').eq('pagamento_id', id).order('numero')
  assert.equal(par.length, 2)
  assert.equal(Number(par[1].juros), 15)
  assert.equal((await pagamento(id)).status, antes.status)
  assert.equal((await pagamento(id)).versao, antes.versao)
})

// -----------------------------------------------------------------------------
// Baixa por parcela
// -----------------------------------------------------------------------------
test('baixa por parcela: pagamento só fica pago quando todas as parcelas estiverem pagas', async () => {
  const id = await novoPagamento('fin', obraC.id, 1000)
  await rpc('fin', 'definir_parcelas', { p_pagamento_id: id, p_parcelas: [
    { valor: 600, vencimento: '2026-12-10' },
    { valor: 400, vencimento: '2026-12-20', multa: 10, motivo: 'Multa por atraso' },
  ] })
  const { data: par } = await admin.from('pagamento_parcelas').select('id, numero').eq('pagamento_id', id).order('numero')
  await rpcFalha('fin', 'registrar_baixa', { p_id: id, p_pago_em: '2026-12-10' }, /parcelado/)
  await rpc('fin', 'registrar_baixa_parcela', { p_parcela_id: par[0].id, p_pago_em: '2026-12-10' })
  assert.equal((await pagamento(id)).status, 'aguardando_pagamento')
  await rpcFalha('fin', 'registrar_baixa_parcela', { p_parcela_id: par[0].id, p_pago_em: '2026-12-10' }, /já foi paga/)
  await rpcFalha('fin', 'definir_parcelas', { p_pagamento_id: id, p_parcelas: [{ valor: 1000, vencimento: '2026-12-30' }, { valor: 0.01, vencimento: '2026-12-31' }] }, /pagas|parcelas/)
  await rpc('fin', 'registrar_baixa_parcela', { p_parcela_id: par[1].id, p_pago_em: '2026-12-21' })
  const fim = await pagamento(id)
  assert.equal(fim.status, 'pago')
  assert.equal(Number(fim.valor_pago), 1010)
})

// -----------------------------------------------------------------------------
// Fundo fixo
// -----------------------------------------------------------------------------
test('fundo fixo: aprovação do administrador, status pelo saldo, avisos e fechamento', async () => {
  const fundo = await rpc('fin', 'criar_fundo_fixo', { p_obra_id: obraA.id, p_pessoa_id: u.eng.id, p_valor: 100 })
  await rpcFalha('fin', 'criar_fundo_fixo', { p_obra_id: obraA.id, p_pessoa_id: u.eng.id, p_valor: 50 }, /unique|duplicate|já/)
  const g1 = await rpc('eng', 'lancar_gasto_fundo', { p_fundo_id: fundo, p_descricao: 'Material de urgência', p_data: '2026-11-05', p_valor: 60 })
  let f = (await admin.from('fundos_fixos').select('status').eq('id', fundo).single()).data
  assert.equal(f.status, 'em_andamento')
  await rpcFalha('eng', 'decidir_gasto_fundo', { p_gasto_id: g1, p_aprovar: true }, /administrador/)
  await rpcFalha('adm', 'decidir_gasto_fundo', { p_gasto_id: g1, p_aprovar: false }, /motivo/)
  await rpc('adm', 'decidir_gasto_fundo', { p_gasto_id: g1, p_aprovar: true })
  const g2 = await rpc('eng', 'lancar_gasto_fundo', { p_fundo_id: fundo, p_descricao: 'Ferramenta', p_data: '2026-11-05', p_valor: 35 })
  await rpc('adm', 'decidir_gasto_fundo', { p_gasto_id: g2, p_aprovar: true })
  f = (await admin.from('fundos_fixos').select('status').eq('id', fundo).single()).data
  assert.equal(f.status, 'acabando')
  const { data: avisos } = await admin.from('notificacoes').select('titulo').eq('user_id', u.fin.id).eq('titulo', 'Fundo fixo acabando')
  assert.ok(avisos.length >= 1)
  await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: fundo, p_vencimento: '2026-11-20' })
  const fechado = (await admin.from('fundos_fixos').select('status, reposicao, reembolso, saldo_repassado, pagamento_id').eq('id', fundo).single()).data
  assert.equal(fechado.status, 'fechado')
  assert.equal(Number(fechado.reposicao), 0)
  assert.equal(Number(fechado.saldo_repassado), 5)
  assert.equal(fechado.pagamento_id, null)

  // Segundo fundo: gasta mais que o valor, vira esgotado e gera um pagamento só
  const fundo2 = await rpc('fin', 'criar_fundo_fixo', { p_obra_id: obraA.id, p_pessoa_id: u.eng.id, p_valor: 100 })
  for (const v of [60, 60]) {
    const g = await rpc('eng', 'lancar_gasto_fundo', { p_fundo_id: fundo2, p_descricao: 'Compra', p_data: '2026-11-06', p_valor: v })
    await rpc('adm', 'decidir_gasto_fundo', { p_gasto_id: g, p_aprovar: true })
  }
  f = (await admin.from('fundos_fixos').select('status').eq('id', fundo2).single()).data
  assert.equal(f.status, 'esgotado')
  const pagId = await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: fundo2, p_vencimento: '2026-11-20' })
  const pag = await pagamento(pagId)
  assert.equal(Number(pag.valor), 120)
  assert.equal(pag.status, 'aguardando_pagamento')
  assert.equal(pag.fluxo, 'C')
  assert.match(pag.descricao, /reposição de R\$ 100,00 \+ reembolso de R\$ 20,00/)
  const fim = (await admin.from('fundos_fixos').select('reposicao, reembolso').eq('id', fundo2).single()).data
  assert.equal(Number(fim.reposicao), 100)
  assert.equal(Number(fim.reembolso), 20)
})

// Assinatura em cadeia: cada anexo tem a sua própria versão mais recente.
async function assinar(chave, pag, base) {
  const conteudo = Buffer.from(`%PDF-1.4 assinado ${randomUUID()}`)
  const path = `${pag.obra_id}/${pag.id}/${randomUUID()}.pdf`
  const { error } = await u[chave].client.storage.from('documentos').upload(path, conteudo, { contentType: 'application/pdf' })
  if (error) throw new Error('upload: ' + error.message)
  return rpc(chave, 'registrar_assinatura', {
    p_pagamento_id: pag.id, p_base_id: base, p_nome_arquivo: 'assinado.pdf', p_storage_path: path,
    p_mime_type: 'application/pdf', p_tamanho: conteudo.length,
    p_sha256: createHash('sha256').update(conteudo).digest('hex'),
  })
}

test('assinatura em cadeia: cada anexo tem a própria versão mais recente', async () => {
  const pag = await pagamento(await novoPagamento('fin', obraA.id))
  const boleto = await anexar('fin', pag, 'boleto')
  const nota = await anexar('fin', pag, 'nota_fiscal')
  // engenheiro assina os dois anexos
  const boletoEng = await assinar('eng', pag, boleto)
  const notaEng = await assinar('eng', pag, nota)
  // o engenheiro aprova a etapa dele; só então o administrador assina
  await rpc('eng', 'decidir_aprovacao', { p_itens: [{ id: pag.id, versao: pag.versao }], p_decisao: 'aprovado' })
  // administrador assina só o boleto, sobre a versão do engenheiro
  await assinar('adm', pag, boletoEng)
  // a versão já assinada pelo administrador não recebe nova assinatura, nem a versão antiga
  await assert.rejects(() => assinar('adm', pag, boletoEng), /versão mais recente|já recebeu|row-level security/)
  await assert.rejects(() => assinar('adm', pag, boleto), /versão mais recente|já recebeu|row-level security/)
  // a nota continua independente: o administrador ainda pode assinar a versão do engenheiro dela
  await assinar('adm', pag, notaEng)
  // o engenheiro não assina de novo a mesma cadeia
  await assert.rejects(() => assinar('eng', pag, notaEng), /versão mais recente|já recebeu|row-level security/)
})

test('suprimentos cria OP em qualquer obra, mesmo sem acesso liberado', async () => {
  const { data: obra } = await u.fin.client.from('obras').insert({ nome: `Obra sup ${sufixo}`, cidade: 'Feira de Santana', uf: 'BA', fluxo: 'C' }).select().single()
  const id = await salvarOP('sup', obra.id)
  assert.ok(id)
})

test('suprimentos anexa boleto e nota em qualquer obra; outros tipos continuam restritos', async () => {
  const { data: obra } = await u.fin.client.from('obras').insert({ nome: `Obra sup anexo ${sufixo}`, cidade: 'Feira de Santana', uf: 'BA', fluxo: 'C' }).select().single()
  const pag = await pagamento(await novoPagamento('fin', obra.id))
  await anexar('sup', pag, 'boleto')
  await anexar('sup', pag, 'nota_fiscal')
  await assert.rejects(() => anexar('sup', pag, 'outro'), /permissão|row-level security/)
})

// Envio da OP pelo engenheiro criador: ele assina na solicitação, a OP é enviada e a assinatura é concluída (como no servidor).
async function enviarOPEng(id) {
  await rpc('eng', 'registrar_assinatura_criador', { p_ordem_id: id, p_pos: { fx: 0.68, fy: 0.78, fw: 0.24 } })
  const pagId = await rpc('eng', 'enviar_op', { p_id: id })
  const pag = await pagamento(pagId)
  // PDF oficial da OP (sem assinatura), registrado como a server action faz no envio
  const oficial = Buffer.from(`%PDF-1.4 oficial ${randomUUID()}`)
  const pathOficial = `${pag.obra_id}/${pag.id}/${randomUUID()}.pdf`
  const up0 = await u.eng.client.storage.from('documentos').upload(pathOficial, oficial, { contentType: 'application/pdf' })
  if (up0.error) throw new Error('upload oficial: ' + up0.error.message)
  await rpc('eng', 'registrar_documento', {
    p_pagamento_id: pagId, p_tipo: 'ordem_pagamento', p_nome_arquivo: 'OP.pdf', p_storage_path: pathOficial,
    p_mime_type: 'application/pdf', p_tamanho: oficial.length, p_sha256: createHash('sha256').update(oficial).digest('hex'),
  })
  const conteudo = Buffer.from(`%PDF-1.4 assinado criador ${randomUUID()}`)
  const path = `${pag.obra_id}/${pag.id}/${randomUUID()}.pdf`
  const { error } = await u.eng.client.storage.from('documentos').upload(path, conteudo, { contentType: 'application/pdf' })
  if (error) throw new Error('upload: ' + error.message)
  await rpc('eng', 'concluir_criacao_assinada', {
    p_pagamento_id: pagId, p_storage_path: path, p_nome: 'OP assinada.pdf', p_mime: 'application/pdf',
    p_tamanho: conteudo.length, p_sha256: createHash('sha256').update(conteudo).digest('hex'),
  })
  return pagId
}

// ===== Rodada: categorias, competência, repetição, provisões de suprimentos, cheque =====
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())

test('categorias: só o financeiro cria/altera; nome repetido devolve a mesma; sem nomes duplicados', async () => {
  const nome = `Categoria ${sufixo}`
  const id1 = await rpc('fin', 'criar_categoria', { p_nome: nome })
  const id2 = await rpc('fin', 'criar_categoria', { p_nome: `  ${nome.toLowerCase()} ` })
  assert.equal(id1, id2)
  for (const chave of ['sup', 'eng', 'adm']) await rpcFalha(chave, 'criar_categoria', { p_nome: `Outra ${sufixo}` }, /Somente o Financeiro/)
  const id3 = await rpc('fin', 'criar_categoria', { p_nome: `Segunda ${sufixo}` })
  await rpcFalha('fin', 'atualizar_categoria', { p_id: id3, p_nome: nome, p_ativo: true }, /Já existe/)
  await rpcFalha('sup', 'atualizar_categoria', { p_id: id3, p_nome: `X ${sufixo}`, p_ativo: true }, /Somente o Financeiro/)
  const { error } = await u.fin.client.from('categorias').insert({ nome: `Direto ${sufixo}` })
  assert.ok(error, 'insert direto na tabela deveria ser recusado')
})

test('categoria no pagamento: em aberto ok; desativada, quem não atua e pagamento finalizado são recusados', async () => {
  const cat = await rpc('fin', 'criar_categoria', { p_nome: `Cat pag ${sufixo}` })
  const inativa = await rpc('fin', 'criar_categoria', { p_nome: `Inativa ${sufixo}` })
  await rpc('fin', 'atualizar_categoria', { p_id: inativa, p_nome: `Inativa ${sufixo}`, p_ativo: false })
  const pagId = await novoPagamento('fin', obraA.id)
  await rpc('fin', 'definir_categoria', { p_pagamento_id: pagId, p_categoria_id: cat })
  assert.equal((await pagamento(pagId)).categoria_id, cat)
  await rpcFalha('fin', 'definir_categoria', { p_pagamento_id: pagId, p_categoria_id: inativa }, /Categoria inválida/)
  await rpcFalha('eng', 'definir_categoria', { p_pagamento_id: pagId, p_categoria_id: cat }, /Sem permissão|não encontrado/)
  await rpc('fin', 'cancelar_pagamento', { p_id: pagId, p_motivo: 'teste' })
  await rpcFalha('fin', 'definir_categoria', { p_pagamento_id: pagId, p_categoria_id: cat }, /finalizado/)
})

test('competência: padrão = data do cadastro; altera em aberto; OP passa competência e categoria ao pagamento', async () => {
  const pagId = await novoPagamento('fin', obraA.id)
  assert.equal((await pagamento(pagId)).data_competencia, hojeSP())
  await rpc('fin', 'definir_competencia', { p_pagamento_id: pagId, p_data: '2026-09-01' })
  assert.equal((await pagamento(pagId)).data_competencia, '2026-09-01')
  await rpcFalha('eng', 'definir_competencia', { p_pagamento_id: pagId, p_data: '2026-10-01' }, /Sem permissão|não encontrado/)

  const cat = await rpc('fin', 'criar_categoria', { p_nome: `Cat OP ${sufixo}` })
  const opId = await salvarOP('eng', obraA.id)
  await rpc('eng', 'definir_competencia_op', { p_ordem_id: opId, p_data: '2026-08-15' })
  await rpc('eng', 'definir_categoria_op', { p_ordem_id: opId, p_categoria_id: cat })
  await rpcFalha('fin', 'definir_competencia_op', { p_ordem_id: opId, p_data: '2026-08-01' }, /Solicitação não encontrada/)
  const pagOP = await pagamento(await enviarOPEng(opId))
  assert.equal(pagOP.data_competencia, '2026-08-15')
  assert.equal(pagOP.categoria_id, cat)
  await rpcFalha('eng', 'definir_competencia_op', { p_ordem_id: opId, p_data: '2026-08-20' }, /já foi enviada/)
})

test('repetição: só quem cadastrou; cria N-1 provisões com datas e categoria; não duplica; limites validados', async () => {
  const cat = await rpc('fin', 'criar_categoria', { p_nome: `Cat rep ${sufixo}` })
  const pagId = await novoPagamento('fin', obraA.id, 900)
  await rpc('fin', 'definir_categoria', { p_pagamento_id: pagId, p_categoria_id: cat })
  await rpcFalha('sup', 'criar_repeticoes', { p_pagamento_id: pagId, p_intervalo: 1, p_vezes: 3 }, /Pagamento não encontrado/)
  await rpcFalha('fin', 'criar_repeticoes', { p_pagamento_id: pagId, p_intervalo: 0, p_vezes: 3 }, /inválida/)
  await rpcFalha('fin', 'criar_repeticoes', { p_pagamento_id: pagId, p_intervalo: 1, p_vezes: 61 }, /inválida/)
  assert.equal(await rpc('fin', 'criar_repeticoes', { p_pagamento_id: pagId, p_intervalo: 1, p_vezes: 3 }), 2)
  assert.equal(await rpc('fin', 'criar_repeticoes', { p_pagamento_id: pagId, p_intervalo: 1, p_vezes: 3 }), 0)
  const { data: prov } = await admin.from('provisoes').select('vencimento, valor_estimado, categoria_id, status').eq('pagamento_origem_id', pagId).order('vencimento')
  assert.deepEqual(prov.map((p) => p.vencimento), ['2027-01-10', '2027-02-10'])
  assert.ok(prov.every((p) => Number(p.valor_estimado) === 900 && p.categoria_id === cat && p.status === 'provisionada'))

  const opId = await salvarOP('eng', obraA.id)
  await rpcFalha('eng', 'definir_repeticao_op', { p_ordem_id: opId, p_intervalo: 1, p_vezes: null }, /Informe o intervalo/)
  await rpc('eng', 'definir_repeticao_op', { p_ordem_id: opId, p_intervalo: 2, p_vezes: 4 })
  const { data: op } = await admin.from('ordens_pagamento').select('repetir_intervalo, repetir_vezes').eq('id', opId).single()
  assert.deepEqual([op.repetir_intervalo, op.repetir_vezes], [2, 4])
})

test('provisões: suprimentos cria em obra sem acesso; altera só as que criou; não exclui', async () => {
  const { data: obra } = await u.fin.client.from('obras').insert({ nome: `Obra prov ${sufixo}`, cidade: 'Salvador', uf: 'BA', fluxo: 'C' }).select().single()
  const { data: minha, error: e1 } = await u.sup.client.from('provisoes').insert({ obra_id: obra.id, descricao: 'Provisão do suprimentos', vencimento: '2027-03-10', valor_estimado: 300 }).select().single()
  assert.ifError(e1)
  const { data: dafin, error: e2 } = await u.fin.client.from('provisoes').insert({ obra_id: obra.id, descricao: 'Provisão do financeiro', vencimento: '2027-03-10', valor_estimado: 500 }).select().single()
  assert.ifError(e2)
  const { data: alteradaFin } = await u.sup.client.from('provisoes').update({ status: 'cancelada' }).eq('id', dafin.id).select('id')
  assert.equal(alteradaFin.length, 0, 'suprimentos não altera provisão do financeiro')
  const { data: alteradaMinha } = await u.sup.client.from('provisoes').update({ status: 'convertida' }).eq('id', minha.id).select('id')
  assert.equal(alteradaMinha.length, 1)
  const { data: excluida, error: eDel } = await u.sup.client.from('provisoes').delete().eq('id', minha.id).select('id')
  assert.ok(eDel || excluida.length === 0, 'suprimentos não exclui provisão')
  const { data: aindaExiste } = await admin.from('provisoes').select('id').eq('id', minha.id)
  assert.equal(aindaExiste.length, 1)
  const { error: e3 } = await u.eng.client.from('provisoes').insert({ obra_id: obra.id, descricao: 'Engenheiro', vencimento: '2027-03-10' })
  assert.ok(e3, 'engenheiro não cria provisão direto')
})

test('forma de pagamento cheque é aceita', async () => {
  const id = await rpc('fin', 'criar_pagamento', {
    p_obra_id: obraA.id, p_fornecedor_id: null, p_favorecido: 'Cheque Teste', p_descricao: 'Pagamento em cheque',
    p_valor: 120, p_vencimento: '2026-12-10', p_forma_pagamento: 'cheque',
  })
  assert.equal((await pagamento(id)).forma_pagamento, 'cheque')
})

test('engenheiro não cadastra pagamento direto (boleto); competência de pagamento pago não muda', async () => {
  await rpcFalha('eng', 'criar_pagamento', {
    p_obra_id: obraA.id, p_fornecedor_id: null, p_favorecido: 'Eng boleto', p_descricao: 'Tentativa',
    p_valor: 50, p_vencimento: '2026-12-10', p_forma_pagamento: 'boleto',
  })
  const pagId = await novoPagamento('fin', obraC.id, 77)
  const p = await pagamento(pagId)
  assert.equal(p.status, 'aguardando_pagamento') // obra sem administrador: vai direto ao Financeiro
  await rpc('fin', 'registrar_baixa', { p_id: pagId, p_pago_em: '2026-12-14' })
  await rpcFalha('fin', 'definir_competencia', { p_pagamento_id: pagId, p_data: '2026-01-01' }, /finalizado/)
})

test('baixa a menor: "saldo" gera parcela paga + saldo em aberto; "desconto" quita', async () => {
  const saldo = await novoPagamento('fin', obraC.id, 1000)
  await rpc('fin', 'registrar_baixa', { p_id: saldo, p_pago_em: '2026-12-14', p_valor_pago: 400, p_diferenca: 'saldo' })
  assert.equal((await pagamento(saldo)).status, 'aguardando_pagamento')
  const { data: pcs } = await admin.from('pagamento_parcelas').select('numero, valor_base, status').eq('pagamento_id', saldo).order('numero')
  assert.deepEqual(pcs.map((p) => [p.numero, Number(p.valor_base), p.status]), [[1, 400, 'pago'], [2, 600, 'a_pagar']])
  const desc = await novoPagamento('fin', obraC.id, 1000)
  await rpc('fin', 'registrar_baixa', { p_id: desc, p_pago_em: '2026-12-14', p_valor_pago: 900, p_diferenca: 'desconto' })
  const p = await pagamento(desc)
  assert.deepEqual([p.status, Number(p.valor_pago)], ['pago', 900])
  await rpcFalha('fin', 'registrar_baixa', { p_id: await novoPagamento('fin', obraC.id), p_pago_em: '2026-12-14', p_valor_pago: 10, p_diferenca: 'outro' })
})

test('estorno: financeiro e master estornam com motivo; suprimentos e engenheiro não; parcela estornada reabre o pagamento', async () => {
  const id = await novoPagamento('fin', obraC.id)
  await rpcFalha('fin', 'estornar_baixa', { p_id: id, p_motivo: 'não pago ainda' }, /pago/)
  await rpc('fin', 'registrar_baixa', { p_id: id, p_pago_em: '2026-12-14' })
  await rpcFalha('sup', 'estornar_baixa', { p_id: id, p_motivo: 'tentativa' })
  await rpcFalha('eng', 'estornar_baixa', { p_id: id, p_motivo: 'tentativa' })
  await rpcFalha('fin', 'estornar_baixa', { p_id: id, p_motivo: ' ' }, /motivo/)
  await rpc('master', 'estornar_baixa', { p_id: id, p_motivo: 'Devolvido pelo banco' })
  const p = await pagamento(id)
  assert.deepEqual([p.status, p.pago_em, p.valor_pago], ['aguardando_pagamento', null, null])
  const { data: au } = await admin.from('auditoria').select('acao').eq('pagamento_id', id).eq('acao', 'estorno')
  assert.equal(au.length, 1)
  const parc = await novoPagamento('fin', obraC.id, 1000)
  await rpc('fin', 'registrar_baixa', { p_id: parc, p_pago_em: '2026-12-14', p_valor_pago: 300 })
  const { data: [pc1] } = await admin.from('pagamento_parcelas').select('id').eq('pagamento_id', parc).eq('numero', 1)
  await rpc('fin', 'estornar_baixa_parcela', { p_parcela_id: pc1.id, p_motivo: 'Erro' })
  const { data: st } = await admin.from('pagamento_parcelas').select('status').eq('pagamento_id', parc).order('numero')
  assert.deepEqual(st.map((x) => x.status), ['a_pagar', 'a_pagar'])
})

test('série: cancelar tudo ou a partir de uma data; reajustar; só criador ou financeiro', async () => {
  const id = await novoPagamento('sup', obraA.id, 500)
  assert.equal(await rpc('sup', 'criar_repeticoes', { p_pagamento_id: id, p_intervalo: 1, p_vezes: 5 }), 4)
  assert.equal(await rpc('sup', 'reajustar_serie', { p_pagamento_id: id, p_valor: 650 }), 4)
  await rpcFalha('eng', 'reajustar_serie', { p_pagamento_id: id, p_valor: 1 })
  await rpcFalha('eng', 'cancelar_serie', { p_pagamento_id: id })
  const { data: provs } = await admin.from('provisoes').select('vencimento, valor_estimado').eq('pagamento_origem_id', id).order('vencimento')
  assert.ok(provs.every((x) => Number(x.valor_estimado) === 650))
  assert.equal(await rpc('fin', 'cancelar_serie', { p_pagamento_id: id, p_a_partir: provs[2].vencimento }), 2)
  assert.equal(await rpc('sup', 'cancelar_serie', { p_pagamento_id: id }), 2)
  const { data: fim } = await admin.from('provisoes').select('status').eq('pagamento_origem_id', id)
  assert.ok(fim.every((x) => x.status === 'cancelada'))
})

test('duplicidade: acha pelo mesmo arquivo ou por favorecido+valor+vencimento, ignora cancelados e respeita a visibilidade', async () => {
  const id = await rpc('fin', 'criar_pagamento', {
    p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: `Dup ${sufixo}`, p_descricao: 'Dup', p_valor: 321.45, p_vencimento: '2026-12-20', p_forma_pagamento: 'boleto',
  })
  const docId = await anexar('fin', await pagamento(id))
  const { data: doc } = await admin.from('documentos').select('sha256').eq('id', docId).single()
  const porArquivo = await rpc('fin', 'verificar_duplicidade', { p_hashes: [doc.sha256], p_favorecido: null, p_valor: null, p_vencimento: null })
  assert.ok(porArquivo.some((r) => r.pagamento_id === id && /arquivo/.test(r.motivo)))
  const porDados = await rpc('fin', 'verificar_duplicidade', { p_hashes: [], p_favorecido: `dup ${sufixo}`, p_valor: 321.45, p_vencimento: '2026-12-20' })
  assert.ok(porDados.some((r) => r.pagamento_id === id))
  const outroValor = await rpc('fin', 'verificar_duplicidade', { p_hashes: [], p_favorecido: `Dup ${sufixo}`, p_valor: 321.46, p_vencimento: '2026-12-20' })
  assert.ok(!outroValor.some((r) => r.pagamento_id === id))
  const semAcesso = await rpc('eng2', 'verificar_duplicidade', { p_hashes: [doc.sha256], p_favorecido: `Dup ${sufixo}`, p_valor: 321.45, p_vencimento: '2026-12-20' })
  assert.equal(semAcesso.length, 0)
  await rpc('fin', 'cancelar_pagamento', { p_id: id, p_motivo: 'teste' })
  const cancelado = await rpc('fin', 'verificar_duplicidade', { p_hashes: [doc.sha256], p_favorecido: null, p_valor: null, p_vencimento: null })
  assert.ok(!cancelado.some((r) => r.pagamento_id === id))
})

test('última parcela: estender série de provisões renumera, mantém intervalo/valor/categoria; só financeiro ou quem cadastrou', async () => {
  // Série de repetição (pagamento a cada 2 meses, 3 vezes → 2 provisões)
  const pag = await novoPagamento('sup', obraA.id, 800)
  await rpc('sup', 'criar_repeticoes', { p_pagamento_id: pag, p_intervalo: 2, p_vezes: 3 })
  const { data: antes } = await admin.from('provisoes').select('id, descricao, vencimento').eq('pagamento_origem_id', pag).order('vencimento')
  const ultima = antes.at(-1)
  assert.match(ultima.descricao, /\(3\/3\)$/)
  await rpcFalha('eng', 'estender_serie_provisao', { p_provisao_id: ultima.id, p_quantidade: 2 })
  await rpcFalha('sup', 'estender_serie_provisao', { p_provisao_id: ultima.id, p_quantidade: 0 })
  assert.equal(await rpc('sup', 'estender_serie_provisao', { p_provisao_id: ultima.id, p_quantidade: 2 }), 2)
  const { data: depois } = await admin.from('provisoes').select('descricao, vencimento, valor_estimado, created_by').eq('pagamento_origem_id', pag).order('vencimento')
  assert.deepEqual(depois.map((p) => p.descricao.match(/\((\d+\/\d+)\)$/)[1]), ['2/5', '3/5', '4/5', '5/5'])
  const mes = (d) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7))
  assert.equal(mes(depois[2].vencimento) - mes(depois[1].vencimento), 2, 'mantém o intervalo de 2 meses')
  assert.equal(mes(depois[3].vencimento) - mes(depois[2].vencimento), 2)
  assert.ok(depois.every((p) => Number(p.valor_estimado) === 800 && p.created_by === u.sup.id))
  // Série manual de 2 meses do financeiro: suprimentos não estende; financeiro estende mensalmente
  const { data: obraP } = await u.fin.client.from('obras').insert({ nome: `Obra serie ${sufixo}`, cidade: 'Salvador', uf: 'BA', fluxo: 'C' }).select().single()
  const { data: manual } = await u.fin.client.from('provisoes').insert([1, 2].map((k) => ({ obra_id: obraP.id, descricao: `Aluguel ${sufixo} (${k}/2)`, vencimento: `2027-0${k}-31`.replace('02-31', '02-28'), valor_estimado: 100 }))).select().order('vencimento')
  await rpcFalha('sup', 'estender_serie_provisao', { p_provisao_id: manual[1].id, p_quantidade: 1 })
  await rpc('fin', 'estender_serie_provisao', { p_provisao_id: manual[1].id, p_quantidade: 2 })
  const { data: m2 } = await admin.from('provisoes').select('descricao, vencimento').like('descricao', `Aluguel ${sufixo} (%`).order('vencimento')
  assert.deepEqual(m2.map((p) => [p.descricao.slice(-5), p.vencimento]), [['(1/4)', '2027-01-31'], ['(2/4)', '2027-02-28'], ['(3/4)', '2027-03-31'], ['(4/4)', '2027-04-30']])
  // Provisão avulsa (sem série) não estende
  const { data: avulsa } = await u.fin.client.from('provisoes').insert({ obra_id: obraP.id, descricao: 'Avulsa', vencimento: '2027-01-10' }).select().single()
  await rpcFalha('fin', 'estender_serie_provisao', { p_provisao_id: avulsa.id, p_quantidade: 1 }, /série/)
})
