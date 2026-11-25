// Testes de integração das regras do banco (RLS, fluxos A/B/C, assinaturas,
// versões e auditoria) contra um Supabase real (local: `npx supabase start`).
//
// Uso: npm run test:integracao
// ATENÇÃO: cria usuários e dados de teste. Rode apenas no ambiente local.

import { test, before, describe } from 'node:test'
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

// Fundo fixo: comprovante assinado é obrigatório para o gasto contar
async function anexarGasto(chave, fundoId, gastoId, assinado) {
  const conteudo = Buffer.from(`%PDF-1.4 comprovante ${randomUUID()}`)
  const path = `fundos/${fundoId}/${randomUUID()}.pdf`
  const { error } = await u[chave].client.storage.from('documentos').upload(path, conteudo, { contentType: 'application/pdf' })
  if (error) throw new Error('upload: ' + error.message)
  return rpc(chave, 'registrar_anexo_gasto', {
    p_gasto_id: gastoId, p_storage_path: path, p_nome: 'comprovante.pdf', p_mime: 'application/pdf',
    p_sha256: createHash('sha256').update(conteudo).digest('hex'), p_assinado: assinado,
  })
}
async function dadosBancariosFundo(chave, fundoId) {
  await rpc(chave, 'informar_dados_bancarios_fundo', { p_fundo_id: fundoId, p_forma: 'pix', p_banco: 'Banco Teste', p_favorecido: 'Titular Teste', p_chave_pix: 'teste@exemplo.com' })
}
async function gastoFundo(chave, fundoId, descricao, data, valor, assinado = true) {
  await dadosBancariosFundo(chave, fundoId)
  const id = await rpc(chave, 'lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: descricao, p_data: data, p_valor: valor })
  if (assinado) await anexarGasto(chave, fundoId, id, true)
  return id
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
  // Regra atual: a Inteligência de Compras é aberta a todos (só leitura), mas o CNPJ do fornecedor só sai para quem alimenta o módulo
  const { data: ve } = await u.eng.client.from('compras_itens').select('fornecedor_nome, fornecedor_cnpj').eq('nota_id', vf[0].nota_id)
  assert.deepEqual(ve.map((x) => [x.fornecedor_nome, x.fornecedor_cnpj]), [['Concreteira', null]])

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
// -----------------------------------------------------------------------------
// Cadastro e edição de despesa numa única transação (auditoria A-05 e A-06)
// -----------------------------------------------------------------------------
test('regressão: despesa cadastrada/editada numa transação só: se algo for recusado, nada fica pela metade', async () => {
  const cat = await rpc('fin', 'criar_categoria', { p_nome: `Cat completo ${sufixo}` })
  const conta = await rpc('fin', 'criar_conta_bancaria', { p_nome: `Conta completo ${sufixo}`, p_banco: '237', p_agencia: '8', p_conta: String(Date.now()).slice(-8) })
  const { data: prov } = await u.fin.client.from('provisoes').insert({ obra_id: obraC.id, descricao: `Prov completo ${sufixo}`, vencimento: '2027-01-10', valor_estimado: 1000 }).select().single()
  const base = {
    p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: `Fornecedor completo ${sufixo}`, p_descricao: `Despesa completa ${sufixo}`, p_valor: 1000,
    p_vencimento: '2026-12-10', p_forma_pagamento: 'pix', p_categoria_id: cat, p_conta_id: conta, p_numero_documento: '', p_observacoes: '',
  }
  const contar = async (desc) => (await admin.from('pagamentos').select('id').eq('descricao', desc)).data.length
  // Recusada no meio (categoria que não existe): antes a despesa já tinha sido criada; agora nada é criado
  await rpcFalha('fin', 'criar_pagamento_completo', { ...base, p_descricao: `Rejeitada ${sufixo}`, p_categoria_id: randomUUID() })
  assert.equal(await contar(`Rejeitada ${sufixo}`), 0, 'nada foi criado')
  // Parcelas que não somam o valor também desfazem tudo
  await rpcFalha('fin', 'criar_pagamento_completo', { ...base, p_descricao: `Rejeitada ${sufixo}`, p_parcelas: [{ valor: 100, vencimento: '2026-12-10' }, { valor: 100, vencimento: '2027-01-10' }] })
  assert.equal(await contar(`Rejeitada ${sufixo}`), 0, 'parcelas inválidas também não deixam resíduo')
  // Caminho feliz: competência, categoria, conta, parcelas, repetições e provisão juntas
  const id = await rpc('fin', 'criar_pagamento_completo', { ...base, p_competencia: '2026-11-30', p_parcelas: [{ valor: 600, vencimento: '2026-12-10' }, { valor: 400, vencimento: '2027-01-10' }], p_repetir_intervalo: 1, p_repetir_vezes: 3, p_provisao_id: prov.id })
  const p = await pagamento(id)
  assert.deepEqual([p.categoria_id, p.conta_bancaria_id, p.data_competencia], [cat, conta, '2026-11-30'])
  assert.equal((await admin.from('pagamento_parcelas').select('id').eq('pagamento_id', id)).data.length, 2)
  assert.equal((await admin.from('provisoes').select('id').eq('pagamento_origem_id', id)).data.length, 2, 'duas repetições')
  const { data: pv } = await admin.from('provisoes').select('status, pagamento_id').eq('id', prov.id).single()
  assert.deepEqual([pv.status, pv.pagamento_id], ['convertida', id], 'provisão ligada')

  // Edição: recusada no meio, o valor NÃO pode ter mudado (antes o valor era gravado e só depois vinha o erro)
  const ed = await novoPagamento('fin', obraC.id, 500)
  await rpcFalha('fin', 'atualizar_pagamento_completo', { p_id: ed, p_fornecedor_id: null, p_favorecido: 'Concreteira Teste', p_descricao: 'Concreto usinado', p_valor: 777, p_vencimento: '2026-12-10', p_forma_pagamento: 'boleto', p_numero_documento: '', p_observacoes: '', p_motivo: 'teste', p_categoria_id: randomUUID() })
  assert.equal(Number((await pagamento(ed)).valor), 500, 'a edição recusada não alterou o valor')
  await rpc('fin', 'atualizar_pagamento_completo', { p_id: ed, p_fornecedor_id: null, p_favorecido: 'Concreteira Teste', p_descricao: 'Concreto usinado', p_valor: 777, p_vencimento: '2026-12-10', p_forma_pagamento: 'boleto', p_numero_documento: '', p_observacoes: '', p_motivo: 'teste', p_categoria_id: cat, p_conta_id: conta, p_competencia: '2026-11-15' })
  const e2 = await pagamento(ed)
  assert.deepEqual([Number(e2.valor), e2.categoria_id, e2.conta_bancaria_id, e2.data_competencia], [777, cat, conta, '2026-11-15'])
})

test('regressão: usuário novo = perfil + acessos numa transação só (se os acessos falharem, o perfil não fica)', async () => {
  const novoLogin = async () => {
    const { data, error } = await admin.auth.admin.createUser({ email: `novo-${randomUUID().slice(0, 8)}@teste.local`, password: SENHA, email_confirm: true })
    if (error) throw error
    return { id: data.user.id, email: data.user.email }
  }
  const ok = await novoLogin()
  await rpcFalha('sup', 'criar_perfil_completo', { p_id: ok.id, p_nome: 'Sem permissão', p_email: ok.email, p_telefone: '', p_perfil: 'engenheiro', p_obras: [] }, /Somente o Financeiro/)
  await rpc('fin', 'criar_perfil_completo', { p_id: ok.id, p_nome: 'Usuário Atômico', p_email: ok.email.toUpperCase(), p_telefone: '71988887777', p_perfil: 'suprimentos', p_obras: [obraA.id, obraB.id, obraA.id] })
  const { data: pf } = await admin.from('profiles').select('nome, email, perfil, troca_senha_pendente').eq('id', ok.id).single()
  assert.deepEqual([pf.nome, pf.email, pf.perfil, pf.troca_senha_pendente], ['Usuário Atômico', ok.email, 'suprimentos', true])
  assert.equal((await admin.from('obra_acessos').select('obra_id').eq('user_id', ok.id)).data.length, 2, 'dois acessos (o repetido é ignorado)')

  // Acesso a uma obra que não existe: o perfil NÃO pode ter ficado (antes o usuário ficava criado sem os acessos)
  const falha = await novoLogin()
  await rpcFalha('fin', 'criar_perfil_completo', { p_id: falha.id, p_nome: 'Não deve existir', p_email: falha.email, p_telefone: '', p_perfil: 'engenheiro', p_obras: [obraA.id, randomUUID()] })
  assert.equal((await admin.from('profiles').select('id').eq('id', falha.id)).data.length, 0, 'nenhum perfil ficou pela metade')
  await admin.auth.admin.deleteUser(falha.id)
})

test('regressão: duas séries de provisões com a mesma descrição e o mesmo total não se confundem (auditoria A-11)', async () => {
  const mes = (i) => `2027-${String(i).padStart(2, '0')}`
  const serie = async (sid) => {
    const linhas = [1, 2, 3].map((k) => ({ obra_id: obraC.id, descricao: `Aluguel igual ${sufixo} (${k}/3)`, mes_referencia: mes(k), vencimento: `${mes(k)}-10`, valor_estimado: 1000, serie_id: sid }))
    const { data, error } = await u.fin.client.from('provisoes').insert(linhas).select('id, descricao').order('descricao')
    if (error) throw error
    return data
  }
  const [s1, s2] = [randomUUID(), randomUUID()]
  const a = await serie(s1)
  const b = await serie(s2)
  // Estende só a série A (a partir da última parcela dela): +2 parcelas
  assert.equal(await rpc('fin', 'estender_serie_provisao', { p_provisao_id: a[2].id, p_quantidade: 2 }), 2)
  const { data: linhasA } = await admin.from('provisoes').select('descricao').eq('serie_id', s1)
  const { data: linhasB } = await admin.from('provisoes').select('descricao').eq('serie_id', s2)
  assert.equal(linhasA.length, 5, 'a série A ganhou 2 parcelas')
  assert.ok(linhasA.every((x) => /\(\d\/5\)$/.test(x.descricao)), 'a série A foi renumerada (k/5)')
  assert.equal(linhasB.length, 3, 'a série B não foi tocada')
  assert.ok(linhasB.every((x) => /\(\d\/3\)$/.test(x.descricao)), 'a série B continua (k/3)')
  // Repetição de despesa: cada chamada cria uma série própria (serie_id) para as suas provisões
  const pag = await novoPagamento('fin', obraC.id, 300)
  await rpc('fin', 'criar_repeticoes', { p_pagamento_id: pag, p_intervalo: 1, p_vezes: 3 })
  const { data: rep } = await admin.from('provisoes').select('serie_id').eq('pagamento_origem_id', pag)
  assert.equal(rep.length, 2)
  assert.ok(rep[0].serie_id && rep.every((x) => x.serie_id === rep[0].serie_id), 'as repetições da despesa compartilham um serie_id')
})

// -----------------------------------------------------------------------------
// Inteligência de Compras aberta a todos (só leitura), com o CPF/CNPJ do fornecedor mascarado
// -----------------------------------------------------------------------------
test('regressão: engenheiro e administrador comparam preços de TODAS as obras (só leitura) sem ver o CNPJ do fornecedor', async () => {
  // Nota registrada numa obra que engenheiro e administradores NÃO acompanham (obra C: sem responsáveis)
  const pagId = await novoPagamento('fin', obraC.id)
  const docId = await anexar('fin', await pagamento(pagId), 'nota_fiscal')
  const descricao = `Item compras para todos ${sufixo}`
  const nota = { chave: ('2926111234567800019055001' + Date.now() + '0000000000').slice(0, 44), numero: '777', serie: '1', data_emissao: '2026-11-02', emitente_cnpj: '12.345.678/0001-90', emitente_nome: 'Fornecedor Compras Todos', emitente_uf: 'BA', valor_total: 900 }
  await rpc('fin', 'registrar_nf', { p_documento_id: docId, p_nota: nota, p_itens: [{ numero_item: 1, descricao, descricao_normalizada: descricao.toLowerCase(), unidade: 'm3', quantidade: 3, valor_unitario: 300, valor_total: 900 }], p_origem: 'xml' })

  // Todos leem pela visão, inclusive a obra que não é deles; o CNPJ só aparece para quem alimenta o módulo e para o master
  for (const chave of ['eng', 'adm', 'adm2']) {
    const { data, error } = await u[chave].client.from('compras_itens').select('obra_nome, fornecedor_nome, fornecedor_cnpj, valor_unitario').eq('descricao', descricao)
    assert.ok(!error, error?.message)
    assert.equal(data.length, 1, `${chave}: vê o item da obra que não acompanha`)
    assert.deepEqual([data[0].fornecedor_nome, data[0].fornecedor_cnpj, Number(data[0].valor_unitario)], ['Fornecedor Compras Todos', null, 300], `${chave}: vê o nome e o preço, mas não o CNPJ`)
  }
  for (const chave of ['fin', 'sup', 'master']) {
    const { data } = await u[chave].client.from('compras_itens').select('fornecedor_cnpj').eq('descricao', descricao)
    assert.equal(data[0]?.fornecedor_cnpj, '12345678000190', `${chave}: vê o CNPJ`)
  }
  // As tabelas com o CNPJ e os dados fiscais completos não saem para engenheiro e administrador
  for (const chave of ['eng', 'adm']) {
    const { data: notas } = await u[chave].client.from('nf_notas').select('id, emitente_cnpj')
    const { data: itens } = await u[chave].client.from('nf_itens').select('id')
    assert.equal(notas.length + itens.length, 0, `${chave}: não lê nf_notas/nf_itens direto`)
    const { error: eIns } = await u[chave].client.from('nf_notas').insert({ obra_id: obraC.id, chave: 'x'.repeat(44), emitente_nome: 'x', emitente_cnpj: '1' })
    assert.ok(eIns, `${chave}: não grava notas`)
  }
})

test('regressão: notas sem leitura vêm de consulta exata (sem janela fixa) só para Financeiro/Suprimentos; arquivos órfãos só para o Financeiro', async () => {
  const nova = async () => anexar('sup', await pagamento(await novoPagamento('sup', obraA.id)), 'nota_fiscal')
  const [lida, pendente1, pendente2] = [await nova(), await nova(), await nova()]
  const chave = ('2926111234567800019055001' + Date.now() + '0000000001').slice(0, 44)
  await rpc('sup', 'registrar_nf', { p_documento_id: lida, p_nota: { chave, numero: '55', serie: '1', data_emissao: '2026-11-03', emitente_cnpj: '12.345.678/0001-90', emitente_nome: 'Fornecedor X', emitente_uf: 'BA', valor_total: 10 }, p_itens: [{ numero_item: 1, descricao: 'Item X', descricao_normalizada: 'item x', unidade: 'un', quantidade: 1, valor_unitario: 10, valor_total: 10 }], p_origem: 'xml' })
  for (const k of ['sup', 'fin']) {
    const pend = await rpc(k, 'notas_fiscais_pendentes', { p_limite: 500 })
    const ids = pend.map((x) => x.documento_id)
    assert.ok(ids.includes(pendente1) && ids.includes(pendente2) && !ids.includes(lida), `${k}: lista só as notas ainda sem leitura`)
    assert.ok((await rpc(k, 'notas_fiscais_pendentes_total')) >= 2)
    assert.equal((await rpc(k, 'notas_fiscais_pendentes', { p_limite: 1 })).length, 1, `${k}: respeita o limite`)
  }
  for (const k of ['eng', 'adm']) {
    assert.equal((await rpc(k, 'notas_fiscais_pendentes', { p_limite: 500 })).length, 0, `${k}: não vê a fila de leitura`)
    assert.equal(await rpc(k, 'notas_fiscais_pendentes_total'), 0)
  }
  // Arquivos órfãos: só o Financeiro enxerga a lista (nada é apagado automaticamente)
  assert.ok(Array.isArray(await rpc('fin', 'arquivos_orfaos', { p_dias: 2 })))
  for (const k of ['eng', 'adm', 'sup']) assert.equal((await rpc(k, 'arquivos_orfaos', { p_dias: 2 })).length, 0, `${k}: sem acesso à lista de órfãos`)
})

// -----------------------------------------------------------------------------
// Privacidade (auditoria A-01, A-02 e A-03): dados pessoais e bancários só saem para quem precisa
// -----------------------------------------------------------------------------
test('regressão: e-mail/telefone, dados fiscais e bancários de fornecedores e agência/conta da empresa não saem para qualquer usuário logado', async () => {
  const doc = String(Date.now()).padStart(14, '0').slice(-14)
  const { data: forn } = await admin.from('fornecedores').insert({ nome: `Forn Privado ${sufixo}`, cpf_cnpj: doc, email: 'forn@privado.com', telefone: '71999990000', chave_pix: `pix-${sufixo}@privado.com`, banco: 'Banco Privado', agencia: '4321', conta: '98765-4' }).select('id').single()
  const { data: cta } = await admin.from('contas_bancarias').insert({ nome: `Conta Privada ${sufixo}`, banco: '999', agencia: '7777', conta: String(Date.now()).slice(-8), created_by: u.fin.id }).select('id').single()
  const negado = (error) => { assert.ok(error, 'esperava erro de permissão'); assert.match(error.message, /permission denied/i) }

  for (const chave of ['eng', 'adm', 'sup']) {
    const c = u[chave].client
    // A-01: nomes continuam visíveis (aparecem nas telas); e-mail e telefone não
    const { data: nomes, error: e0 } = await c.from('profiles').select('id, nome, perfil, ativo')
    assert.ok(!e0 && nomes.length > 1, `${chave}: deve ver os nomes`)
    negado((await c.from('profiles').select('email')).error)
    negado((await c.from('profiles').select('telefone')).error)
    negado((await c.from('profiles').select('*')).error)
    const { data: proprio } = await c.from('profiles_completo').select('id, email')
    assert.deepEqual(proprio.map((x) => x.id), [u[chave].id], `${chave}: a visão completa só mostra o próprio perfil`)
    assert.ok(proprio[0].email, `${chave}: vê o próprio e-mail`)
  }
  const { data: todos } = await u.fin.client.from('profiles_completo').select('id, email, telefone')
  assert.ok(todos.length >= 5 && todos.every((x) => x.email), 'o Financeiro vê o e-mail de todos')

  // A-02: fornecedores
  for (const chave of ['eng', 'adm', 'adm2']) {
    const c = u[chave].client
    const { data: nome } = await c.from('fornecedores').select('id, nome, cidade, uf').eq('id', forn.id)
    assert.equal(nome.length, 1, `${chave}: vê o nome do fornecedor`)
    for (const col of ['cpf_cnpj', 'chave_pix', 'banco', 'agencia', 'conta', 'email', 'telefone']) negado((await c.from('fornecedores').select(col)).error)
    negado((await c.from('fornecedores').select('*')).error)
    const { data: v } = await c.from('fornecedores_dados').select('id').eq('id', forn.id)
    assert.equal(v.length, 0, `${chave}: a visão de dados do fornecedor vem vazia`)
  }
  for (const chave of ['fin', 'sup', 'master']) {
    const { data: v } = await u[chave].client.from('fornecedores_dados').select('cpf_cnpj, chave_pix, banco, agencia, conta').eq('id', forn.id)
    assert.deepEqual([v[0]?.cpf_cnpj, v[0]?.banco, v[0]?.agencia], [doc, 'Banco Privado', '4321'], `${chave}: vê os dados do fornecedor`)
  }

  // A-03: contas bancárias da empresa
  for (const chave of ['eng', 'adm', 'sup']) {
    const c = u[chave].client
    const { data: nome } = await c.from('contas_bancarias').select('id, nome').eq('id', cta.id)
    assert.equal(nome.length, 1, `${chave}: vê o nome da conta (lista de escolha)`)
    for (const col of ['banco', 'agencia', 'conta']) negado((await c.from('contas_bancarias').select(col)).error)
    const { data: v } = await c.from('contas_bancarias_dados').select('id').eq('id', cta.id)
    assert.equal(v.length, 0, `${chave}: a visão da conta vem vazia`)
  }
  for (const chave of ['fin', 'master']) {
    const { data: v } = await u[chave].client.from('contas_bancarias_dados').select('banco, agencia').eq('id', cta.id)
    assert.deepEqual([v[0]?.banco, v[0]?.agencia], ['999', '7777'], `${chave}: vê a agência e a conta`)
  }
})

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
// Excluir lançamento (escopo: atual / não vencidos / em aberto / todos)
// -----------------------------------------------------------------------------
test('excluir lançamento parcelado: parcela sai da despesa, total diminui, renumera; "não vencidos" poupa vencidas e pagas; "todos" estorna as pagas', async () => {
  const id = await novoPagamento('fin', obraC.id, 1000)
  await rpc('fin', 'definir_parcelas', { p_pagamento_id: id, p_parcelas: [
    { valor: 100, vencimento: '2020-01-10' }, { valor: 200, vencimento: '2020-02-10' },
    { valor: 300, vencimento: '2030-01-10' }, { valor: 400, vencimento: '2030-02-10' },
  ] })
  const parcs = async () => (await admin.from('pagamento_parcelas').select('id, numero, valor_base, status').eq('pagamento_id', id).order('numero')).data
  const [p1, p2, p3] = await parcs()
  await rpc('fin', 'registrar_baixa_parcela', { p_parcela_id: p2.id, p_pago_em: '2020-02-10' })
  await rpcFalha('eng', 'excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: p3.id, p_escopo: 'atual', p_motivo: 'teste' }, /não encontrado|permissão/)
  await rpcFalha('fin', 'excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: p3.id, p_escopo: 'xyz', p_motivo: 'teste' }, /Escolha/)
  await rpcFalha('fin', 'excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: p3.id, p_escopo: 'atual', p_motivo: '' }, /motivo/)
  // A partir da 3ª: sai ela e a 4ª (a vencer, sem baixa); a 1ª (vencida) e a 2ª (paga) ficam
  assert.deepEqual(await rpc('fin', 'excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: p3.id, p_escopo: 'nao_vencidos', p_motivo: 'duplicado' }), { pagamentos: 0, parcelas: 2, provisoes: 0 })
  assert.deepEqual((await parcs()).map((x) => [x.numero, Number(x.valor_base), x.status]), [[1, 100, 'a_pagar'], [2, 200, 'pago']])
  assert.equal(Number((await pagamento(id)).valor), 300, 'o total diminui')
  // Só a 1ª (em aberto): fica só a paga, renumerada como 1, e a despesa vira paga
  await rpc('fin', 'excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: p1.id, p_escopo: 'atual', p_motivo: 'duplicado' })
  assert.deepEqual((await parcs()).map((x) => [x.numero, Number(x.valor_base), x.status]), [[1, 200, 'pago']])
  const fim = await pagamento(id)
  assert.deepEqual([fim.status, Number(fim.valor), Number(fim.valor_pago)], ['pago', 200, 200])
  const { data: aud } = await admin.from('auditoria').select('acao').eq('pagamento_id', id).in('acao', ['excluiu', 'excluiu_parcela'])
  assert.equal(aud.length, 5, 'auditoria de cada parcela e de cada exclusão')
  // "Todos": a paga tem a baixa estornada e a despesa, sem parcelas, é cancelada
  await rpcFalha('sup', 'excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: p2.id, p_escopo: 'todos', p_motivo: 'teste' }, /não encontrado|permissão|estornam/)
  assert.deepEqual(await rpc('fin', 'excluir_lancamentos', { p_pagamento_id: id, p_parcela_id: p2.id, p_escopo: 'todos', p_motivo: 'errado' }), { pagamentos: 0, parcelas: 1, provisoes: 0 })
  assert.equal((await parcs()).length, 0)
  assert.equal((await pagamento(id)).status, 'cancelado')
})

test('excluir lançamento de repetição: "em aberto" cancela as despesas sem baixa e as provisões; "todos" estorna e cancela a paga; avulso: só ela', async () => {
  const raiz = await novoPagamento('fin', obraC.id, 900)
  assert.equal(await rpc('fin', 'criar_repeticoes', { p_pagamento_id: raiz, p_intervalo: 1, p_vezes: 3 }), 2)
  await rpc('fin', 'registrar_baixa', { p_id: raiz, p_pago_em: '2026-12-10' })
  const { data: provs } = await admin.from('provisoes').select('id').eq('pagamento_origem_id', raiz).order('vencimento')
  const lancada = await novoPagamento('fin', obraC.id, 905)
  await rpc('fin', 'lancar_provisao', { p_provisao_id: provs[0].id, p_pagamento_id: lancada })
  assert.deepEqual(await rpc('fin', 'excluir_lancamentos', { p_pagamento_id: lancada, p_parcela_id: null, p_escopo: 'em_aberto', p_motivo: 'contrato encerrado' }), { pagamentos: 1, parcelas: 0, provisoes: 1 })
  assert.equal((await pagamento(lancada)).status, 'cancelado')
  assert.equal((await pagamento(raiz)).status, 'pago', 'a paga fica')
  assert.equal((await admin.from('provisoes').select('status').eq('id', provs[1].id).single()).data.status, 'cancelada')
  assert.deepEqual(await rpc('fin', 'excluir_lancamentos', { p_pagamento_id: raiz, p_parcela_id: null, p_escopo: 'todos', p_motivo: 'contrato encerrado' }), { pagamentos: 1, parcelas: 0, provisoes: 0 })
  assert.equal((await pagamento(raiz)).status, 'cancelado')
  // Avulsa: "somente o atual"
  const avulsa = await novoPagamento('fin', obraC.id, 50)
  await rpc('fin', 'excluir_lancamentos', { p_pagamento_id: avulsa, p_parcela_id: null, p_escopo: 'atual', p_motivo: 'teste' })
  assert.equal((await pagamento(avulsa)).status, 'cancelado')
})

// -----------------------------------------------------------------------------
// Fundo fixo
// -----------------------------------------------------------------------------
test('fundo fixo no caixa: criar = desembolso; "repor" paga os gastos e abre novo fundo do mesmo valor; "encerrar" devolve o saldo (receita) ou reembolsa', async () => {
  const conta = await rpc('fin', 'criar_conta_bancaria', { p_nome: 'Conta fundo', p_banco: '237', p_agencia: '9', p_conta: String(Date.now()).slice(-8) })
  const fundo = await rpc('fin', 'criar_fundo_fixo', { p_obra_id: obraB.id, p_pessoa_id: u.sup.id, p_valor: 1000, p_conta_id: conta, p_vencimento: '2026-12-01' })
  const { data: f0 } = await admin.from('fundos_fixos').select('pagamento_inicial_id, conta_bancaria_id').eq('id', fundo).single()
  const ini = await pagamento(f0.pagamento_inicial_id)
  assert.deepEqual([Number(ini.valor), ini.status, ini.conta_bancaria_id, ini.vencimento], [1000, 'aguardando_pagamento', conta, '2026-12-01'])
  // Gastou 990 → "repor": paga 990 e abre novo fundo de 1000 (sem novo desembolso)
  const g = await gastoFundo('sup', fundo, 'Compras', '2026-12-05', 990)
  if ((await admin.from('fundo_gastos').select('status').eq('id', g).single()).data.status === 'pendente') await rpc('adm2', 'decidir_gasto_fundo', { p_gasto_id: g, p_aprovar: true }).catch(async () => rpc('fin', 'decidir_gasto_fundo', { p_gasto_id: g, p_aprovar: true }))
  const pagRep = await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: fundo, p_vencimento: '2026-12-06', p_modo: 'repor' })
  assert.equal(Number((await pagamento(pagRep)).valor), 990)
  const { data: novo } = await admin.from('fundos_fixos').select('id, valor, status, pagamento_inicial_id').eq('fundo_anterior_id', fundo).single()
  assert.deepEqual([Number(novo.valor), novo.status, novo.pagamento_inicial_id], [1000, 'em_andamento', null])
  // Novo fundo gasta 1200 → "repor": 1000 de reposição + 200 de reembolso = 1200
  for (const v of [700, 500]) {
    const x = await gastoFundo('sup', novo.id, 'Obra', '2026-12-10', v)
    if ((await admin.from('fundo_gastos').select('status').eq('id', x).single()).data.status === 'pendente') await rpc('adm2', 'decidir_gasto_fundo', { p_gasto_id: x, p_aprovar: true }).catch(async () => rpc('fin', 'decidir_gasto_fundo', { p_gasto_id: x, p_aprovar: true }))
  }
  const pag2 = await pagamento(await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: novo.id, p_vencimento: '2026-12-11', p_modo: 'repor' }))
  assert.equal(Number(pag2.valor), 1200); assert.match(pag2.descricao, /reposição de R\$ 1\.?000,00 \+ reembolso de R\$ 200,00/)
  const { data: terceiro } = await admin.from('fundos_fixos').select('id').eq('fundo_anterior_id', novo.id).single()
  // Fim da obra: gastou 300 → "encerrar": saldo de 700 vira receita em aberto (devolução)
  const y = await gastoFundo('sup', terceiro.id, 'Final', '2026-12-20', 300)
  if ((await admin.from('fundo_gastos').select('status').eq('id', y).single()).data.status === 'pendente') await rpc('adm2', 'decidir_gasto_fundo', { p_gasto_id: y, p_aprovar: true }).catch(async () => rpc('fin', 'decidir_gasto_fundo', { p_gasto_id: y, p_aprovar: true }))
  const semPag = await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: terceiro.id, p_vencimento: '2026-12-21', p_modo: 'encerrar' })
  assert.equal(semPag, null, 'sem reembolso não gera pagamento')
  const { data: fim } = await admin.from('fundos_fixos').select('status, recebimento_devolucao_id, saldo_repassado').eq('id', terceiro.id).single()
  const { data: dev } = await admin.from('recebimentos').select('valor, status, descricao').eq('id', fim.recebimento_devolucao_id).single()
  assert.deepEqual([fim.status, Number(fim.saldo_repassado), Number(dev.valor), dev.status], ['fechado', 700, 700, 'aberto'])
  assert.equal((await admin.from('fundos_fixos').select('id').eq('fundo_anterior_id', terceiro.id)).data.length, 0, 'encerrar não abre novo fundo')
  await rpcFalha('fin', 'fechar_fundo_fixo', { p_fundo_id: terceiro.id, p_vencimento: '2026-12-21', p_modo: 'xyz' }, /inválido|já fechado/)
})

test('fundo fixo: aprovação do administrador, status pelo saldo, avisos e fechamento', async () => {
  const fundo = await rpc('fin', 'criar_fundo_fixo', { p_obra_id: obraA.id, p_pessoa_id: u.eng.id, p_valor: 100 })
  await rpcFalha('fin', 'criar_fundo_fixo', { p_obra_id: obraA.id, p_pessoa_id: u.eng.id, p_valor: 50 }, /unique|duplicate|já/)
  const g1 = await gastoFundo('eng', fundo, 'Material de urgência', '2026-11-05', 60)
  let f = (await admin.from('fundos_fixos').select('status').eq('id', fundo).single()).data
  assert.equal(f.status, 'em_andamento')
  await rpcFalha('eng', 'decidir_gasto_fundo', { p_gasto_id: g1, p_aprovar: true }, /administrador/)
  await rpcFalha('adm', 'decidir_gasto_fundo', { p_gasto_id: g1, p_aprovar: false }, /motivo/)
  await rpc('adm', 'decidir_gasto_fundo', { p_gasto_id: g1, p_aprovar: true })
  const g2 = await gastoFundo('eng', fundo, 'Ferramenta', '2026-11-05', 35)
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
    const g = await gastoFundo('eng', fundo2, 'Compra', '2026-11-06', v)
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

test('regressão: gasto de fundo fixo sem comprovante assinado não conta nem pode ser aprovado (antes contava sem assinatura nenhuma)', async () => {
  // Obra com administrador: o assinado é exigido para aprovar
  const fundo = await rpc('fin', 'criar_fundo_fixo', { p_obra_id: obraA.id, p_pessoa_id: u.eng.id, p_valor: 500 })
  await dadosBancariosFundo('eng', fundo)
  const g = await rpc('eng', 'lancar_gasto_fundo', { p_fundo_id: fundo, p_descricao: 'Sem assinatura', p_data: '2026-11-05', p_valor: 40 })
  assert.equal((await admin.from('fundo_gastos').select('status').eq('id', g).single()).data.status, 'pendente')
  await rpcFalha('adm', 'decidir_gasto_fundo', { p_gasto_id: g, p_aprovar: true }, /comprovante assinado/)
  await anexarGasto('eng', fundo, g, false)
  await rpcFalha('adm', 'decidir_gasto_fundo', { p_gasto_id: g, p_aprovar: true }, /comprovante assinado/)
  await anexarGasto('eng', fundo, g, true)
  await rpc('adm', 'decidir_gasto_fundo', { p_gasto_id: g, p_aprovar: true })
  assert.equal((await admin.from('fundo_gastos').select('status').eq('id', g).single()).data.status, 'aprovado')
  await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: fundo, p_vencimento: '2026-11-20', p_modo: 'encerrar' })
  // Obra sem administrador: o gasto só passa a contar quando o comprovante assinado é anexado
  const fundoC = await rpc('fin', 'criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: u.sup.id, p_valor: 300 })
  await dadosBancariosFundo('sup', fundoC)
  const gc = await rpc('sup', 'lancar_gasto_fundo', { p_fundo_id: fundoC, p_descricao: 'Sem administrador', p_data: '2026-11-05', p_valor: 50 })
  assert.equal((await admin.from('fundo_gastos').select('status').eq('id', gc).single()).data.status, 'pendente', 'não conta sem comprovante')
  await anexarGasto('sup', fundoC, gc, false)
  assert.equal((await admin.from('fundo_gastos').select('status').eq('id', gc).single()).data.status, 'pendente', 'original sem assinatura não basta')
  await anexarGasto('sup', fundoC, gc, true)
  assert.equal((await admin.from('fundo_gastos').select('status').eq('id', gc).single()).data.status, 'aprovado')
  await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: fundoC, p_vencimento: '2026-11-20', p_modo: 'encerrar' })
})

test('regressão: fundo fixo não limita novos gastos (passa do valor vira reembolso); a pessoa solicita o fechamento, só o Financeiro fecha (antes bloqueava o gasto e só dava "pedir reposição")', async () => {
  const fundo = await rpc('fin', 'criar_fundo_fixo', { p_obra_id: obraA.id, p_pessoa_id: u.sup.id, p_valor: 100 })
  const g1 = await gastoFundo('sup', fundo, 'Um', '2026-11-06', 60)
  const g2 = await gastoFundo('sup', fundo, 'Dois (passa do valor)', '2026-11-06', 70)
  // Já cobriu o fundo, mas continua podendo lançar (sem limite)
  const g3 = await gastoFundo('sup', fundo, 'Três (depois de passar)', '2026-11-06', 30)
  assert.ok(g1 && g2 && g3)
  // Solicitar fechamento: só a pessoa do fundo, uma vez; avisa o Financeiro; quem não é do fundo não pede
  await rpcFalha('adm', 'solicitar_fechamento_fundo', { p_fundo_id: fundo }, /Somente a pessoa do fundo/)
  await rpcFalha('fin', 'solicitar_fechamento_fundo', { p_fundo_id: fundo }, /Somente a pessoa do fundo/)
  await rpc('sup', 'solicitar_fechamento_fundo', { p_fundo_id: fundo })
  await rpcFalha('sup', 'solicitar_fechamento_fundo', { p_fundo_id: fundo }, /já foi solicitado/)
  const { data: pedido } = await admin.from('notificacoes').select('mensagem').eq('user_id', u.fin.id).eq('titulo', 'Fechamento de fundo fixo solicitado')
  assert.ok(pedido.length >= 1, 'Financeiro avisado')
  const { data: marcado } = await admin.from('fundos_fixos').select('fechamento_solicitado_em').eq('id', fundo).single()
  assert.ok(marcado.fechamento_solicitado_em, 'pedido registrado no fundo')
  // Só o Financeiro fecha: a pessoa do fundo e o administrador não
  await rpcFalha('sup', 'fechar_fundo_fixo', { p_fundo_id: fundo, p_vencimento: '2026-11-20', p_modo: 'encerrar' }, /Financeiro/)
  await rpc('adm', 'decidir_gasto_fundo', { p_gasto_id: g1, p_aprovar: true })
  await rpc('adm', 'decidir_gasto_fundo', { p_gasto_id: g2, p_aprovar: true })
  await rpc('adm', 'decidir_gasto_fundo', { p_gasto_id: g3, p_aprovar: true })
  await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: fundo, p_vencimento: '2026-11-20', p_modo: 'encerrar' })
  const { data: f } = await admin.from('fundos_fixos').select('status, reembolso').eq('id', fundo).single()
  assert.equal(f.status, 'fechado')
  assert.equal(Number(f.reembolso), 60, 'gastos aprovados 160 num fundo de 100 = reembolso de 60')
  await rpcFalha('sup', 'solicitar_fechamento_fundo', { p_fundo_id: fundo }, /já foi fechado/)
})

test('regressão: fundo fixo exige os dados bancários antes do primeiro gasto; o pagamento do fechamento nasce com a forma e os dados', async () => {
  const fundo = await rpc('fin', 'criar_fundo_fixo', { p_obra_id: obraC.id, p_pessoa_id: u.eng.id, p_valor: 500 })
  const lancar = { p_fundo_id: fundo, p_descricao: 'Primeiro gasto', p_data: '2026-11-07', p_valor: 80 }
  await rpcFalha('eng', 'lancar_gasto_fundo', lancar, /dados bancários/)
  const dados = { p_fundo_id: fundo, p_forma: 'conta', p_banco: 'Banco Teste', p_favorecido: 'Eng Teste da Silva', p_agencia: '1234', p_conta: '56789-0' }
  await rpcFalha('sup', 'informar_dados_bancarios_fundo', dados, /Somente a pessoa do fundo/)
  await rpcFalha('eng', 'informar_dados_bancarios_fundo', { ...dados, p_forma: 'xyz' }, /conta bancária ou PIX/)
  await rpcFalha('eng', 'informar_dados_bancarios_fundo', { ...dados, p_banco: '' }, /instituição/)
  await rpcFalha('eng', 'informar_dados_bancarios_fundo', { ...dados, p_favorecido: ' ' }, /favorecido/)
  await rpcFalha('eng', 'informar_dados_bancarios_fundo', { ...dados, p_agencia: '' }, /agência e a conta/)
  await rpcFalha('eng', 'informar_dados_bancarios_fundo', { ...dados, p_forma: 'pix' }, /chave PIX/)
  await rpc('eng', 'informar_dados_bancarios_fundo', dados)
  const g = await rpc('eng', 'lancar_gasto_fundo', lancar)
  await anexarGasto('eng', fundo, g, true) // obra sem administrador: conta ao anexar o assinado
  const pag = await pagamento(await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: fundo, p_vencimento: '2026-11-20', p_modo: 'repor' }))
  assert.equal(Number(pag.valor), 80)
  assert.equal(pag.forma_pagamento, 'transferencia', 'conta bancária → transferência')
  assert.equal(pag.favorecido, 'Eng Teste da Silva', 'o favorecido informado vira o favorecido do pagamento')
  assert.match(pag.observacoes, /Banco Teste\nAgência: 1234\nConta: 56789-0/)
  // Troca para PIX: o próximo fundo (reposição) herda a forma pelo que a pessoa informar
  const { data: novo } = await admin.from('fundos_fixos').select('id, receb_informado_em').eq('fundo_anterior_id', fundo).single()
  assert.equal(novo.receb_informado_em, null, 'o novo fundo pede os dados de novo (a tela sugere os anteriores)')
  await rpc('eng', 'informar_dados_bancarios_fundo', { p_fundo_id: novo.id, p_forma: 'pix', p_banco: 'Banco Teste', p_favorecido: 'Eng Teste da Silva', p_chave_pix: 'eng@exemplo.com' })
  await rpc('fin', 'fechar_fundo_fixo', { p_fundo_id: novo.id, p_vencimento: '2026-11-21', p_modo: 'encerrar' })
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

test('regressão: despesa lançada a partir da provisão marca a provisão como lançada (antes ficava "provisionada" ao lado da despesa)', async () => {
  const prov = async (chave, descricao, obra = obraA.id) => (await u[chave].client.from('provisoes').insert({ obra_id: obra, descricao, vencimento: '2027-04-10', valor_estimado: 200 }).select().single()).data
  const p1 = await prov('fin', 'Provisão lançar 1')
  const pag = await novoPagamento('fin', obraA.id, 210)
  await rpcFalha('eng', 'lancar_provisao', { p_provisao_id: p1.id, p_pagamento_id: pag }, /Somente o Financeiro/)
  const pagOutraObra = await novoPagamento('fin', obraC.id, 210)
  await rpcFalha('fin', 'lancar_provisao', { p_provisao_id: p1.id, p_pagamento_id: pagOutraObra }, /outro centro de custo/)
  await rpc('fin', 'lancar_provisao', { p_provisao_id: p1.id, p_pagamento_id: pag })
  const { data: d1 } = await admin.from('provisoes').select('status, pagamento_id').eq('id', p1.id).single()
  assert.deepEqual([d1.status, d1.pagamento_id], ['convertida', pag])
  await rpcFalha('fin', 'lancar_provisao', { p_provisao_id: p1.id, p_pagamento_id: pag }, /já foi lançada ou cancelada/)
  // Suprimentos: só a provisão que cadastrou
  const pf = await prov('fin', 'Provisão do financeiro 2')
  const pagSup = await novoPagamento('sup', obraA.id, 50)
  await rpcFalha('sup', 'lancar_provisao', { p_provisao_id: pf.id, p_pagamento_id: pagSup }, /Somente o Financeiro/)
  const ps = await prov('sup', 'Provisão do suprimentos 2')
  await rpc('sup', 'lancar_provisao', { p_provisao_id: ps.id, p_pagamento_id: pagSup })
  assert.equal((await admin.from('provisoes').select('status').eq('id', ps.id).single()).data.status, 'convertida')
  // OP: a provisão guardada no rascunho é lançada quando a OP é enviada
  const p3 = await prov('sup', 'Provisão via OP')
  const op = await salvarOP('sup', obraA.id)
  await rpcFalha('fin', 'definir_provisao_op', { p_ordem_id: op, p_provisao_id: p3.id }, /não encontrada/)
  const pOutra = await prov('fin', 'Provisão outra obra', obraC.id)
  await rpcFalha('sup', 'definir_provisao_op', { p_ordem_id: op, p_provisao_id: pOutra.id }, /não pode lançar|outro centro de custo/)
  await rpc('sup', 'definir_provisao_op', { p_ordem_id: op, p_provisao_id: p3.id })
  assert.equal((await admin.from('provisoes').select('status').eq('id', p3.id).single()).data.status, 'provisionada', 'rascunho não lança')
  const pagOp = await rpc('sup', 'enviar_op', { p_id: op })
  const { data: d3 } = await admin.from('provisoes').select('status, pagamento_id').eq('id', p3.id).single()
  assert.deepEqual([d3.status, d3.pagamento_id], ['convertida', pagOp])
  const { data: aud } = await admin.from('auditoria').select('acao').eq('entidade', 'provisao').eq('entidade_id', p3.id)
  assert.ok(aud.some((a) => a.acao === 'lancou'))
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

test('valor alterado depois da aprovação: quem assinou é avisado (também quando é o Financeiro que altera); sem nova aprovação', async () => {
  const aprovar = async (id) => {
    let p = await pagamento(id)
    await anexar('sup', p, 'boleto')
    await anexar('eng', p, 'documento_assinado')
    await rpc('eng', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado' })
    p = await pagamento(id)
    await anexar('adm', p, 'documento_assinado')
    await rpc('adm', 'decidir_aprovacao', { p_itens: [{ id, versao: p.versao }], p_decisao: 'aprovado' })
    p = await pagamento(id)
    assert.equal(p.status, 'aguardando_pagamento')
    return p
  }
  const avisos = async (chave, id) => {
    const { data } = await u[chave].client.from('notificacoes').select('titulo, mensagem').eq('pagamento_id', id).eq('titulo', 'Valor alterado após a sua aprovação')
    return data
  }
  const editar = (chave, p, valor, motivo, descricao = p.descricao) => rpc(chave, 'atualizar_pagamento', {
    p_id: p.id, p_fornecedor_id: null, p_favorecido: p.favorecido, p_descricao: descricao, p_valor: valor, p_vencimento: p.vencimento,
    p_forma_pagamento: p.forma_pagamento, p_numero_documento: p.numero_documento ?? '', p_observacoes: p.observacoes ?? '', p_motivo: motivo,
  })

  // 1) Financeiro aumenta o valor de um lançamento aprovado
  const id = await novoPagamento('sup', obraA.id, 1000)
  let p = await aprovar(id)
  await editar('fin', p, 1500, 'Boleto reemitido com encargos')
  p = await pagamento(id)
  assert.equal(p.status, 'aguardando_pagamento', 'não volta para aprovação')
  const [aEng, aAdm, aFin] = [await avisos('eng', id), await avisos('adm', id), await avisos('fin', id)]
  assert.equal(aEng.length, 1, 'engenheiro que aprovou é avisado')
  assert.equal(aAdm.length, 1, 'administrador que aprovou é avisado')
  assert.equal(aFin.length, 0, 'quem alterou não recebe o próprio aviso')
  assert.match(aEng[0].mensagem, /de R\$ 1\.000,00 para R\$ 1\.500,00 por Fin Teste\. Motivo: Boleto reemitido/)

  // 2) Mudança sem alterar o valor (só descrição) não gera aviso a quem aprovou
  await editar('fin', p, 1500, 'Ajuste de texto', 'Descrição corrigida')
  assert.equal((await avisos('eng', id)).length, 1)

  // 3) Suprimentos altera o valor: avisa quem aprovou e também o Financeiro (como antes)
  p = await pagamento(id)
  await editar('sup', p, 1400, 'Desconto negociado')
  assert.equal((await avisos('eng', id)).length, 2)
  const { data: aFinSup } = await u.fin.client.from('notificacoes').select('titulo').eq('pagamento_id', id).eq('titulo', 'Pagamento alterado após liberação')
  assert.ok(aFinSup.length >= 1)

  // 4) Parcelas: total muda depois da aprovação → quem aprovou é avisado
  const id2 = await novoPagamento('sup', obraA.id, 600)
  const p2 = await aprovar(id2)
  await rpc('sup', 'definir_parcelas', { p_pagamento_id: id2, p_parcelas: [{ vencimento: '2026-12-10', valor: 300 }, { vencimento: '2027-01-10', valor: 300 }] })
  const { data: pcs } = await admin.from('pagamento_parcelas').select('id').eq('pagamento_id', id2).order('numero')
  await rpc('fin', 'editar_parcelas', { p_pagamento_id: id2, p_parcelas: [{ id: pcs[1].id, vencimento: '2027-01-10', valor: 350 }], p_motivo: 'Reajuste da 2ª parcela' })
  assert.equal((await pagamento(id2)).status, 'aguardando_pagamento')
  const a2 = await avisos('adm', id2)
  assert.equal(a2.length, 1)
  assert.match(a2[0].mensagem, /total de R\$ 600,00 para R\$ 650,00/)
  // só o vencimento: sem aviso
  await rpc('fin', 'editar_parcelas', { p_pagamento_id: id2, p_parcelas: [{ id: pcs[1].id, vencimento: '2027-01-20', valor: 350 }] })
  assert.equal((await avisos('adm', id2)).length, 1)
  assert.equal(p2.id, id2)
})

// ---------------- Conciliação bancária ----------------
describe('conciliação bancária', () => {
  const contaNum = String(Date.now()).slice(-9) // conta única por execução
  const L = (data, valor, descricao, fitid = '') => ({ data, valor, tipo: valor < 0 ? 'DEBIT' : 'CREDIT', descricao, fitid, documento: '' })
  const importar = (chave, linhas, extra = {}) => rpc(chave, 'importar_extrato', {
    p_banco: '104', p_agencia: '0068', p_conta: '000' + contaNum, p_arquivo: 'teste.ofx', p_inicio: '2026-12-01', p_fim: '2026-12-31',
    p_saldo: 1000, p_saldo_em: '2026-12-20', p_linhas: linhas, ...extra,
  })
  const linhaPor = async (conta, descricao) => {
    const { data, error } = await admin.from('extrato_linhas').select('*').eq('conta_id', conta).eq('descricao', descricao).order('created_at')
    if (error) throw error
    return data
  }
  // Conta a pagar já liberada (fluxo C vai direto ao Financeiro)
  const liberada = async (valor, venc = '2026-12-10') => {
    const id = await rpc('fin', 'criar_pagamento', { p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: 'Fornecedor Conc', p_descricao: 'Conciliação', p_valor: valor, p_vencimento: venc, p_forma_pagamento: 'pix' })
    let p = await pagamento(id)
    if (p.status !== 'aguardando_pagamento') { await anexar('fin', p, 'boleto'); p = await pagamento(id) }
    assert.equal(p.status, 'aguardando_pagamento', 'conta liberada para o teste')
    return p
  }
  let conta, mst
  const falha = (k, fn, args, t) => rpcFalha(k, fn, args, new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  before(async () => {
    if (!u.master) await criarUsuario('master', 'administrador_master', 'Master Teste')
    mst = 'master'
  })

  test('só o Financeiro importa; master lê o extrato; Suprimentos/engenheiro/administrador não veem o extrato', async () => {
    for (const k of ['sup', 'eng', 'adm', mst]) await falha(k, 'importar_extrato', { p_banco: '104', p_agencia: '68', p_conta: contaNum, p_arquivo: 'x', p_inicio: null, p_fim: null, p_saldo: null, p_saldo_em: null, p_linhas: [L('2026-12-01', -1, 'X')] }, 'Somente o Financeiro')
    const r = await importar('fin', [L('2026-12-01', -100, 'PRIMEIRA', 'A1')])
    conta = r.conta_id
    assert.equal(r.novas, 1)
    const { data: c } = await admin.from('contas_bancarias').select('*').eq('id', conta).single()
    assert.equal(c.banco, '104'); assert.equal(c.agencia, '68'); assert.equal(c.conta, contaNum.replace(/^0+/, '')); assert.match(c.nome, /^Caixa · Ag\. 68 · C\/C/)
    const { data: vM } = await u.master.client.from('extrato_linhas').select('id').eq('conta_id', conta)
    const { data: vS } = await u.sup.client.from('extrato_linhas').select('id').eq('conta_id', conta)
    const { data: vE } = await u.eng.client.from('extrato_linhas').select('id').eq('conta_id', conta)
    const { data: nE } = await u.eng.client.from('contas_bancarias').select('id').eq('id', conta)
    assert.equal(vM.length, 1, 'master vê o extrato'); assert.equal(vS.length, 0, 'suprimentos não vê o extrato'); assert.equal(vE.length, 0, 'engenheiro não vê o extrato')
    assert.equal(nE.length, 1, 'mas vê o nome da conta (para escolher na despesa)')
    const { error } = await u.fin.client.from('extrato_linhas').update({ situacao: 'arquivada' }).eq('conta_id', conta)
    const [l] = await linhaPor(conta, 'PRIMEIRA'); assert.equal(l.situacao, 'pendente', 'escrita direta na tabela não passa (só pelas funções)')
    void error
  })

  test('regressão: pago por conciliação (com ✓) e baixa manual se distinguem, para quem vê o pagamento', async () => {
    const conciliada = await liberada(321.45)
    const manual = await liberada(123.4)
    await importar('fin', [L('2026-12-11', -321.45, 'PAGTO CONCILIADO MARCA', 'M1')])
    const [l] = await linhaPor(conta, 'PAGTO CONCILIADO MARCA')
    await rpc('fin', 'conciliar_linha', { p_linha_id: l.id, p_itens: [{ tipo: 'pagamento', id: conciliada.id }] })
    await rpc('fin', 'registrar_baixa', { p_id: manual.id, p_pago_em: '2026-12-11' })
    const ids = [conciliada.id, manual.id]
    for (const k of ['fin', mst, 'sup']) {
      const r = await rpc(k, 'conciliados_dos_pagamentos', { p_ids: ids })
      assert.deepEqual(r.map((x) => x.pagamento_id), [conciliada.id], `${k}: só a conciliada (a baixa manual não entra)`)
    }
    // Quem não vê a obra não recebe nada (nem o fato de estar conciliada)
    for (const k of ['eng', 'adm']) assert.equal((await rpc(k, 'conciliados_dos_pagamentos', { p_ids: ids })).length, 0, `${k}: sem acesso à obra`)
    // Desfeita a conciliação, volta a ser baixa manual
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: l.id, p_voltar_aberto: false, p_motivo: 'teste' })
    assert.equal((await rpc('fin', 'conciliados_dos_pagamentos', { p_ids: ids })).length, 0)
  })

  test('reimportar não duplica; linhas idênticas legítimas entram na quantidade certa; outra agência = outra conta', async () => {
    let r = await importar('fin', [L('2026-12-01', -100, 'PRIMEIRA', 'A1'), L('2026-12-02', -9.5, 'TAR PIX', 'B2'), L('2026-12-02', -9.5, 'TAR PIX', 'B2')])
    assert.deepEqual([r.novas, r.repetidas], [2, 1])
    r = await importar('fin', [L('2026-12-02', -9.5, 'TAR PIX', 'B2'), L('2026-12-02', -9.5, 'TAR PIX', 'B2'), L('2026-12-02', -9.5, 'TAR PIX', 'B2')])
    assert.deepEqual([r.novas, r.repetidas], [1, 2], 'terceira linha idêntica entra')
    assert.equal((await linhaPor(conta, 'TAR PIX')).length, 3)
    const outra = await importar('fin', [L('2026-12-01', -100, 'PRIMEIRA', 'A1')], { p_agencia: '06353' })
    assert.notEqual(outra.conta_id, conta, 'mesma conta com agência diferente é outra conta (Caixa Matriz × Parceria)')
    // saldo: só substitui por extrato mais recente
    await importar('fin', [L('2026-12-03', -1, 'S1', 'S1')], { p_saldo: 50, p_saldo_em: '2026-11-30' })
    const { data: c } = await admin.from('contas_bancarias').select('saldo, saldo_em').eq('id', conta).single()
    assert.deepEqual([Number(c.saldo), c.saldo_em], [1000, '2026-12-20'])
    await falha('fin', 'importar_extrato', { p_banco: '', p_agencia: '', p_conta: '', p_arquivo: 'x', p_inicio: null, p_fim: null, p_saldo: null, p_saldo_em: null, p_linhas: [] }, 'não informa o banco')
    // Regressão: código do banco com 4 dígitos ("0104" da Caixa) é gravado como "104", não "010"
    const r4 = await rpc('fin', 'importar_extrato', { p_banco: '0104', p_agencia: '0099', p_conta: '000' + contaNum, p_arquivo: 'x.ofx', p_inicio: null, p_fim: null, p_saldo: null, p_saldo_em: null, p_linhas: [L('2026-12-01', -1, 'B4', 'B4')] })
    const { data: c4 } = await admin.from('contas_bancarias').select('banco, nome').eq('id', r4.conta_id).single()
    assert.deepEqual([c4.banco, c4.nome.startsWith('Caixa')], ['104', true])
  })

  test('conciliar conta liberada em aberto: dá a baixa com data e valor do banco; não concilia duas vezes', async () => {
    const p = await liberada(2420)
    await importar('fin', [L('2026-12-04', -2420, 'DEB PIX CHAVE 2420', 'C1')])
    const [l] = await linhaPor(conta, 'DEB PIX CHAVE 2420')
    await falha('sup', 'conciliar_linha', { p_linha_id: l.id, p_itens: [{ tipo: 'pagamento', id: p.id }] }, 'Somente o Financeiro')
    await falha(mst, 'conciliar_linha', { p_linha_id: l.id, p_itens: [{ tipo: 'pagamento', id: p.id }] }, 'Somente o Financeiro')
    await rpc('fin', 'conciliar_linha', { p_linha_id: l.id, p_itens: [{ tipo: 'pagamento', id: p.id }] })
    const d = await pagamento(p.id)
    assert.deepEqual([d.status, d.pago_em, Number(d.valor_pago)], ['pago', '2026-12-04', 2420])
    const [l2] = await linhaPor(conta, 'DEB PIX CHAVE 2420'); assert.equal(l2.situacao, 'conciliada')
    const { data: it } = await admin.from('conciliacao_itens').select('*').eq('linha_id', l.id)
    assert.equal(it.length, 1); assert.equal(it[0].baixou, true)
    const { data: aud } = await admin.from('auditoria').select('acao, descricao').eq('pagamento_id', p.id).eq('acao', 'conciliou')
    assert.equal(aud.length, 1); assert.match(aud[0].descricao, /baixa registrada pela conciliação/)
    await importar('fin', [L('2026-12-05', -2420, 'OUTRA 2420', 'C2')])
    const [o] = await linhaPor(conta, 'OUTRA 2420')
    await falha('fin', 'conciliar_linha', { p_linha_id: o.id, p_itens: [{ tipo: 'pagamento', id: p.id }] }, 'já está conciliado')
    await falha('fin', 'conciliar_linha', { p_linha_id: l.id, p_itens: [{ tipo: 'pagamento', id: p.id }] }, 'já foi conciliado ou arquivado')
  })

  test('conta já baixada (com comprovante): só liga se o valor for o mesmo; em aprovação não concilia; entrada não concilia', async () => {
    const p = await liberada(700)
    await rpc('fin', 'registrar_baixa', { p_id: p.id, p_pago_em: '2026-12-06' })
    await importar('fin', [L('2026-12-06', -701, 'PIX 701', 'D1'), L('2026-12-06', -700, 'PIX 700', 'D2'), L('2026-12-06', 700, 'CRED 700', 'D3')])
    const [l701] = await linhaPor(conta, 'PIX 701'); const [l700] = await linhaPor(conta, 'PIX 700'); const [cred] = await linhaPor(conta, 'CRED 700')
    await falha('fin', 'conciliar_linha', { p_linha_id: l701.id, p_itens: [{ tipo: 'pagamento', id: p.id }] }, 'foi baixado com R$ 700,00, diferente do banco (R$ 701,00)')
    await falha('fin', 'conciliar_linha', { p_linha_id: cred.id, p_itens: [{ tipo: 'pagamento', id: p.id }] }, 'Entradas no banco')
    await rpc('fin', 'conciliar_linha', { p_linha_id: l700.id, p_itens: [{ tipo: 'pagamento', id: p.id }] })
    const { data: it } = await admin.from('conciliacao_itens').select('baixou').eq('linha_id', l700.id)
    assert.equal(it[0].baixou, false, 'não refez a baixa')
    const emAprov = await novoPagamento('sup', obraA.id, 333)
    await importar('fin', [L('2026-12-07', -333, 'PIX 333', 'E1')])
    const [l333] = await linhaPor(conta, 'PIX 333')
    await falha('fin', 'conciliar_linha', { p_linha_id: l333.id, p_itens: [{ tipo: 'pagamento', id: emAprov }] }, 'ainda não está liberado')
    assert.notEqual((await pagamento(emAprov)).status, 'pago')
  })

  test('uma saída para várias contas: soma tem de bater (senão nada muda); juros, desconto e pagamento parcial', async () => {
    const a = await liberada(100), b = await liberada(250)
    await importar('fin', [L('2026-12-08', -350, 'LOTE 350', 'F1'), L('2026-12-08', -349, 'LOTE 349', 'F2')])
    const [l349] = await linhaPor(conta, 'LOTE 349'); const [l350] = await linhaPor(conta, 'LOTE 350')
    await falha('fin', 'conciliar_linha', { p_linha_id: l349.id, p_itens: [{ tipo: 'pagamento', id: a.id }, { tipo: 'pagamento', id: b.id }] }, 'soma das contas')
    assert.equal((await pagamento(a.id)).status, 'aguardando_pagamento', 'nada foi baixado')
    await rpc('fin', 'conciliar_linha', { p_linha_id: l350.id, p_itens: [{ tipo: 'pagamento', id: a.id }, { tipo: 'pagamento', id: b.id }] })
    assert.deepEqual([(await pagamento(a.id)).status, (await pagamento(b.id)).status], ['pago', 'pago'])
    // Fatura do cartão: banco pagou mais que a soma das compras → só com confirmação de encargos (fica registrado)
    const c1 = await liberada(120), c2 = await liberada(80)
    await importar('fin', [L('2026-12-08', -207.5, 'FATURA CARTAO', 'F3')])
    const [lf] = await linhaPor(conta, 'FATURA CARTAO')
    await falha('fin', 'conciliar_linha', { p_linha_id: lf.id, p_itens: [{ tipo: 'pagamento', id: c1.id }, { tipo: 'pagamento', id: c2.id }] }, 'confirme que são encargos')
    assert.equal((await pagamento(c1.id)).status, 'aguardando_pagamento')
    await rpc('fin', 'conciliar_linha', { p_linha_id: lf.id, p_itens: [{ tipo: 'pagamento', id: c1.id }, { tipo: 'pagamento', id: c2.id }], p_diferenca: 'encargos' })
    const [lf2] = await linhaPor(conta, 'FATURA CARTAO')
    assert.deepEqual([lf2.situacao, Number(lf2.encargos), Number((await pagamento(c1.id)).valor_pago), Number((await pagamento(c2.id)).valor_pago)], ['conciliada', 7.5, 120, 80], 'cada compra paga pelo seu valor; diferença registrada')
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: lf.id, p_voltar_aberto: true, p_motivo: 'teste encargos' })
    const [lf3] = await linhaPor(conta, 'FATURA CARTAO')
    assert.deepEqual([lf3.situacao, lf3.encargos, (await pagamento(c1.id)).status], ['pendente', null, 'aguardando_pagamento'])

    const j = await liberada(1000)
    await importar('fin', [L('2026-12-09', -1012.5, 'BOLETO COM JUROS', 'G1')])
    const [lj] = await linhaPor(conta, 'BOLETO COM JUROS')
    await falha('fin', 'conciliar_linha', { p_linha_id: lj.id, p_itens: [{ tipo: 'pagamento', id: j.id }] }, 'confirme que a diferença é juros/multa')
    assert.equal((await pagamento(j.id)).status, 'aguardando_pagamento', 'sem confirmar, nada muda')
    await rpc('fin', 'conciliar_linha', { p_linha_id: lj.id, p_itens: [{ tipo: 'pagamento', id: j.id }], p_diferenca: 'juros' })
    assert.equal(Number((await pagamento(j.id)).valor_pago), 1012.5, 'juros: pago o valor do banco')

    const dsc = await liberada(500), par = await liberada(800)
    await importar('fin', [L('2026-12-10', -480, 'COM DESCONTO', 'H1'), L('2026-12-10', -300, 'PARCIAL', 'H2')])
    const [ld] = await linhaPor(conta, 'COM DESCONTO'); const [lp] = await linhaPor(conta, 'PARCIAL')
    await falha('fin', 'conciliar_linha', { p_linha_id: ld.id, p_itens: [{ tipo: 'pagamento', id: dsc.id }] }, 'desconto ou pagamento parcial')
    await rpc('fin', 'conciliar_linha', { p_linha_id: ld.id, p_itens: [{ tipo: 'pagamento', id: dsc.id }], p_diferenca: 'desconto' })
    const d = await pagamento(dsc.id); assert.deepEqual([d.status, Number(d.valor_pago)], ['pago', 480])
    await rpc('fin', 'conciliar_linha', { p_linha_id: lp.id, p_itens: [{ tipo: 'pagamento', id: par.id }], p_diferenca: 'saldo' })
    const { data: pcs } = await admin.from('pagamento_parcelas').select('id, numero, status, valor_base').eq('pagamento_id', par.id).order('numero')
    assert.deepEqual(pcs.map((x) => [x.numero, x.status, Number(x.valor_base)]), [[1, 'pago', 300], [2, 'a_pagar', 500]])
    assert.equal((await pagamento(par.id)).status, 'aguardando_pagamento', 'o resto continua a pagar')
    const { data: it } = await admin.from('conciliacao_itens').select('parcela_id').eq('linha_id', lp.id)
    assert.equal(it[0].parcela_id, pcs[0].id, 'conciliação fica na parcela paga')
    // a parcela 2 pode ser conciliada depois com outra saída
    await importar('fin', [L('2026-12-15', -500, 'RESTO 500', 'H3')])
    const [lr] = await linhaPor(conta, 'RESTO 500')
    await rpc('fin', 'conciliar_linha', { p_linha_id: lr.id, p_itens: [{ tipo: 'parcela', id: pcs[1].id }] })
    assert.equal((await pagamento(par.id)).status, 'pago')
  })

  test('desfazer: "apenas desfazer" mantém pago; "estornar" volta para em aberto; estorno pelas Ações solta a conciliação', async () => {
    const p1 = await liberada(91), p2 = await liberada(92), p3 = await liberada(93)
    await importar('fin', [L('2026-12-11', -91, 'D91', 'I1'), L('2026-12-11', -92, 'D92', 'I2'), L('2026-12-11', -93, 'D93', 'I3')])
    const [l1] = await linhaPor(conta, 'D91'); const [l2] = await linhaPor(conta, 'D92'); const [l3] = await linhaPor(conta, 'D93')
    for (const [l, p] of [[l1, p1], [l2, p2], [l3, p3]]) await rpc('fin', 'conciliar_linha', { p_linha_id: l.id, p_itens: [{ tipo: 'pagamento', id: p.id }] })
    await falha('fin', 'desfazer_conciliacao', { p_linha_id: l1.id, p_voltar_aberto: false, p_motivo: '' }, 'motivo')
    await falha(mst, 'desfazer_conciliacao', { p_linha_id: l1.id, p_voltar_aberto: false, p_motivo: 'teste' }, 'Somente o Financeiro')
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: l1.id, p_voltar_aberto: false, p_motivo: 'linha errada' })
    assert.equal((await pagamento(p1.id)).status, 'pago'); assert.equal((await linhaPor(conta, 'D91'))[0].situacao, 'pendente')
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: l2.id, p_voltar_aberto: true, p_motivo: 'pagamento não era este' })
    assert.equal((await pagamento(p2.id)).status, 'aguardando_pagamento'); assert.equal((await linhaPor(conta, 'D92'))[0].situacao, 'pendente')
    await rpc('fin', 'estornar_baixa', { p_id: p3.id, p_motivo: 'estorno pelas Ações' })
    assert.equal((await linhaPor(conta, 'D93'))[0].situacao, 'pendente', 'linha voltou para as pendentes')
    const { data: it } = await admin.from('conciliacao_itens').select('id').eq('linha_id', l3.id)
    assert.equal(it.length, 0)
  })

  test('contas bancárias: todos veem o nome (para escolher na despesa), só Financeiro/master veem o saldo; cadastro manual só Financeiro', async () => {
    const { data: nomes, error: e1 } = await u.eng.client.from('contas_bancarias').select('id, nome').eq('id', conta)
    assert.ifError(e1); assert.equal(nomes.length, 1, 'engenheiro vê o nome')
    const { error: e2 } = await u.eng.client.from('contas_bancarias').select('saldo').eq('id', conta)
    assert.ok(e2, 'engenheiro não lê o saldo')
    const { error: e3 } = await u.fin.client.from('contas_bancarias').select('saldo').eq('id', conta)
    assert.ok(e3, 'nem pela tabela: o saldo só sai pela função')
    const sEng = await rpc('eng', 'saldos_contas_bancarias', {}); const sFin = await rpc('fin', 'saldos_contas_bancarias', {}); const sMst = await rpc(mst, 'saldos_contas_bancarias', {})
    assert.equal(sEng.length, 0); assert.ok(sFin.some((x) => x.id === conta && Number(x.saldo) === 1000)); assert.ok(sMst.some((x) => x.id === conta))
    await falha('sup', 'criar_conta_bancaria', { p_nome: 'X', p_banco: '001', p_agencia: '1', p_conta: '1' }, 'Somente o Financeiro')
    const contaBB = String(Date.now()).slice(-6)
    const manual = await rpc('fin', 'criar_conta_bancaria', { p_nome: 'BB Teste', p_banco: '001', p_agencia: '4321', p_conta: `${contaBB}-X` })
    await falha('fin', 'criar_conta_bancaria', { p_nome: 'Repetida', p_banco: '1', p_agencia: '04321', p_conta: `${contaBB}X` }, 'já está cadastrada')
    // Extrato do BB não traz agência: cai na conta cadastrada à mão (banco + conta)
    const r = await rpc('fin', 'importar_extrato', { p_banco: '001', p_agencia: '', p_conta: `${contaBB}-X `, p_arquivo: 'bb.ofx', p_inicio: null, p_fim: null, p_saldo: null, p_saldo_em: null, p_linhas: [L('2026-12-01', -10, 'BB X', 'BB1')] })
    assert.equal(r.conta_id, manual, 'extrato do BB reconhecido pela conta cadastrada')
  })

  test('conta bancária da despesa: quem cadastrou define/troca até pagar; depois só o Financeiro; OP leva a conta para o pagamento; conciliação ajusta', async () => {
    const outra = await rpc('fin', 'criar_conta_bancaria', { p_nome: 'Outra conta', p_banco: '237', p_agencia: '1', p_conta: String(Date.now()).slice(-7) })
    const id = await novoPagamento('sup', obraA.id, 640)
    await rpc('sup', 'definir_conta_bancaria', { p_pagamento_id: id, p_conta_id: outra })
    assert.equal((await pagamento(id)).conta_bancaria_id, outra)
    await rpc('sup', 'definir_conta_bancaria', { p_pagamento_id: id, p_conta_id: outra }) // sem mudança: ok
    await rpc('sup', 'definir_conta_bancaria', { p_pagamento_id: id, p_conta_id: conta })
    const { data: aud } = await admin.from('auditoria').select('descricao').eq('pagamento_id', id).ilike('descricao', 'Conta bancária alterada%')
    assert.equal(aud.length, 1, 'troca registrada no histórico')
    await falha('eng', 'definir_conta_bancaria', { p_pagamento_id: id, p_conta_id: outra }, 'Sem permissão')
    await falha('sup', 'definir_conta_bancaria', { p_pagamento_id: id, p_conta_id: null }, 'Escolha a conta bancária')
    // Já paga: só o Financeiro troca
    const p = await liberada(55); await rpc('fin', 'definir_conta_bancaria', { p_pagamento_id: p.id, p_conta_id: outra })
    await rpc('fin', 'registrar_baixa', { p_id: p.id, p_pago_em: '2026-12-13' })
    await rpc('fin', 'definir_conta_bancaria', { p_pagamento_id: p.id, p_conta_id: conta })
    assert.equal((await pagamento(p.id)).conta_bancaria_id, conta)
    // Regressão: salvar uma despesa já paga sem trocar a conta não pode dar erro para quem não é Financeiro
    const pSup = await novoPagamento('sup', obraA.id, 66); await rpc('sup', 'definir_conta_bancaria', { p_pagamento_id: pSup, p_conta_id: conta })
    await admin.from('pagamentos').update({ status: 'pago', pago_em: '2026-12-13', valor_pago: 66 }).eq('id', pSup)
    await rpc('sup', 'definir_conta_bancaria', { p_pagamento_id: pSup, p_conta_id: conta })
    await falha('sup', 'definir_conta_bancaria', { p_pagamento_id: pSup, p_conta_id: outra }, 'só o Financeiro troca a conta')
    // OP: a conta escolhida no rascunho vai para o pagamento
    const op = await salvarOP('sup', obraA.id)
    await rpc('sup', 'definir_conta_bancaria_op', { p_ordem_id: op, p_conta_id: outra })
    await falha('fin', 'definir_conta_bancaria_op', { p_ordem_id: op, p_conta_id: conta }, 'não encontrada')
    const pagOp = await rpc('sup', 'enviar_op', { p_id: op })
    assert.equal((await pagamento(pagOp)).conta_bancaria_id, outra, 'pagamento da OP herdou a conta')
    // Conciliação: lançada em "outra", saiu desta conta → passa para esta
    const q = await liberada(321); await rpc('fin', 'definir_conta_bancaria', { p_pagamento_id: q.id, p_conta_id: outra })
    await importar('fin', [L('2026-12-14', -321, 'PIX 321', 'K1')]); const [lq] = await linhaPor(conta, 'PIX 321')
    await rpc('fin', 'conciliar_linha', { p_linha_id: lq.id, p_itens: [{ tipo: 'pagamento', id: q.id }] })
    assert.equal((await pagamento(q.id)).conta_bancaria_id, conta, 'conta ajustada pela conciliação')
    const { data: aud2 } = await admin.from('auditoria').select('descricao').eq('pagamento_id', q.id).ilike('descricao', 'Conta bancária ajustada pela conciliação%')
    assert.equal(aud2.length, 1)
  })

  test('novo lançamento pela conciliação: despesa já paga, sem aprovação, marcada, aviso a quem aprova; valores conferem; desfazer cancela', async () => {
    const cat = (await admin.from('categorias').select('id').eq('ativo', true).limit(1).single()).data.id
    await importar('fin', [L('2026-12-16', -3000, 'SAQUE DIN ATM 16/12 10:16 SOP-FULANA', 'N1'), L('2026-12-16', 500, 'CRED NL', 'N2'), L('2026-12-16', -1012, 'BOLETO NL', 'N3')])
    const [ls] = await linhaPor(conta, 'SAQUE DIN ATM 16/12 10:16 SOP-FULANA'); const [lc] = await linhaPor(conta, 'CRED NL'); const [lj] = await linhaPor(conta, 'BOLETO NL')
    const args = { p_linha_id: ls.id, p_obra_id: obraA.id, p_categoria_id: cat, p_descricao: 'Saque para diárias' }
    for (const k of ['sup', 'eng', mst]) await falha(k, 'criar_lancamento_conciliacao', args, 'Somente o Financeiro')
    await falha('fin', 'criar_lancamento_conciliacao', { ...args, p_obra_id: null }, 'centro de custo')
    await falha('fin', 'criar_lancamento_conciliacao', { ...args, p_categoria_id: null }, 'categoria')
    await falha('fin', 'criar_lancamento_conciliacao', { ...args, p_linha_id: lc.id }, 'Entradas no banco não viram despesa')
    const id = await rpc('fin', 'criar_lancamento_conciliacao', args)
    const p = await pagamento(id)
    assert.deepEqual([p.status, p.pago_em, Number(p.valor), Number(p.valor_pago), p.lancado_conciliacao, p.conta_bancaria_id, p.obra_id], ['pago', '2026-12-16', 3000, 3000, true, conta, obraA.id])
    const { count: assin } = await admin.from('assinaturas').select('id', { count: 'exact', head: true }).eq('pagamento_id', id)
    assert.equal(assin, 0, 'não passou por aprovação')
    assert.equal((await linhaPor(conta, 'SAQUE DIN ATM 16/12 10:16 SOP-FULANA'))[0].situacao, 'conciliada')
    const avisos = async (k) => (await u[k].client.from('notificacoes').select('titulo').eq('pagamento_id', id).eq('titulo', 'Despesa lançada pela conciliação')).data.length
    assert.deepEqual([await avisos('eng'), await avisos('adm'), await avisos('fin')], [1, 1, 0], 'engenheiro e administrador do centro de custo avisados')
    const { data: aud } = await admin.from('auditoria').select('descricao').eq('pagamento_id', id).ilike('descricao', 'Lançado pela conciliação%')
    assert.equal(aud.length, 1)
    // juros/multa/desconto: valor + juros + multa − desconto = banco
    await falha('fin', 'criar_lancamento_conciliacao', { p_linha_id: lj.id, p_obra_id: obraC.id, p_categoria_id: cat, p_descricao: 'X', p_valor: 1000, p_juros: 5 }, 'precisa dar o valor que saiu do banco')
    const id2 = await rpc('fin', 'criar_lancamento_conciliacao', { p_linha_id: lj.id, p_obra_id: obraC.id, p_categoria_id: cat, p_descricao: 'Boleto com juros', p_valor: 1000, p_juros: 7, p_multa: 5 })
    const p2 = await pagamento(id2); assert.deepEqual([Number(p2.valor), Number(p2.valor_pago)], [1000, 1012]); assert.match(p2.observacoes, /Juros: R\$ 7,00/)
    // desfazer "voltar para em aberto" num lançamento criado pela conciliação = cancelar
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: ls.id, p_voltar_aberto: true, p_motivo: 'lançado errado' })
    assert.equal((await pagamento(id)).status, 'cancelado')
    assert.equal((await linhaPor(conta, 'SAQUE DIN ATM 16/12 10:16 SOP-FULANA'))[0].situacao, 'pendente')
  })

  test('nova transferência: da origem ou do destino; a outra ponta concilia com a transferência; validações; desfazer solta e apaga quando ninguém ficou', async () => {
    const outra = await rpc('fin', 'criar_conta_bancaria', { p_nome: 'Conta destino', p_banco: '341', p_agencia: '1', p_conta: String(Date.now()).slice(-8) })
    await importar('fin', [L('2026-12-17', -2700, 'ENVIO TRANSF TEV', 'T1')])
    const [ls] = await linhaPor(conta, 'ENVIO TRANSF TEV')
    await falha('sup', 'criar_transferencia', { p_linha_id: ls.id, p_outra_conta: outra }, 'Somente o Financeiro')
    await falha('fin', 'criar_transferencia', { p_linha_id: ls.id, p_outra_conta: conta }, 'outra conta')
    const t = await rpc('fin', 'criar_transferencia', { p_linha_id: ls.id, p_outra_conta: outra, p_descricao: 'Reforço de caixa' })
    const { data: tr } = await admin.from('transferencias').select('*').eq('id', t).single()
    assert.deepEqual([tr.conta_origem, tr.conta_destino, Number(tr.valor), tr.linha_origem, tr.linha_destino], [conta, outra, 2700, ls.id, null])
    assert.equal((await linhaPor(conta, 'ENVIO TRANSF TEV'))[0].situacao, 'conciliada')
    const { count: despesas } = await admin.from('pagamentos').select('id', { count: 'exact', head: true }).eq('descricao', 'Reforço de caixa')
    assert.equal(despesas, 0, 'transferência não vira despesa')
    // Extrato da conta destino: a entrada concilia com a transferência
    const r = await rpc('fin', 'importar_extrato', { p_banco: '341', p_agencia: '1', p_conta: tr.conta_destino ? (await admin.from('contas_bancarias').select('conta').eq('id', outra).single()).data.conta : '', p_arquivo: 'dest.ofx', p_inicio: null, p_fim: null, p_saldo: null, p_saldo_em: null, p_linhas: [L('2026-12-18', 2700, 'CRED TRANSF', 'D1'), L('2026-12-18', 999, 'CRED OUTRA', 'D2')] })
    assert.equal(r.conta_id, outra)
    const [le] = await linhaPor(outra, 'CRED TRANSF'); const [lo] = await linhaPor(outra, 'CRED OUTRA')
    await falha('fin', 'conciliar_transferencia', { p_linha_id: lo.id, p_transferencia_id: t }, 'diferente da transferência')
    await falha('fin', 'conciliar_transferencia', { p_linha_id: ls.id, p_transferencia_id: t }, 'já foi conciliado')
    await rpc('fin', 'conciliar_transferencia', { p_linha_id: le.id, p_transferencia_id: t })
    assert.equal((await admin.from('transferencias').select('linha_destino').eq('id', t).single()).data.linha_destino, le.id)
    await falha('fin', 'conciliar_transferencia', { p_linha_id: lo.id, p_transferencia_id: t }, 'diferente')
    // Desfazer numa ponta: solta só ela; desfazer a outra: transferência apagada
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: le.id, p_voltar_aberto: false, p_motivo: 'teste' })
    assert.equal((await admin.from('transferencias').select('linha_destino, linha_origem').eq('id', t).single()).data.linha_destino, null)
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: ls.id, p_voltar_aberto: false, p_motivo: 'teste' })
    assert.equal((await admin.from('transferencias').select('id').eq('id', t)).data.length, 0, 'sem pontas ligadas: transferência apagada')
    // Começando pelo destino: entrada registrada como vinda de outra conta
    const t2 = await rpc('fin', 'criar_transferencia', { p_linha_id: lo.id, p_outra_conta: conta })
    const { data: tr2 } = await admin.from('transferencias').select('conta_origem, conta_destino, linha_destino').eq('id', t2).single()
    assert.deepEqual([tr2.conta_origem, tr2.conta_destino, tr2.linha_destino], [conta, outra, lo.id])
  })

  test('estorno em pares: saída pendente + estorno conciliam juntos; saída já conciliada com conta paga reabre a conta e avisa; validações; desfazer separa', async () => {
    await importar('fin', [L('2026-12-20', -480, 'PIX ENVIADO EST A', 'E1'), L('2026-12-21', 480, 'PIX DEVOLVIDO EST A', 'E2'), L('2026-12-21', 481, 'PIX DEVOLVIDO EST X', 'E3'), L('2026-12-19', 480, 'CRED ANTES', 'E4')])
    const [sa] = await linhaPor(conta, 'PIX ENVIADO EST A'); const [ea] = await linhaPor(conta, 'PIX DEVOLVIDO EST A'); const [ex] = await linhaPor(conta, 'PIX DEVOLVIDO EST X'); const [eb] = await linhaPor(conta, 'CRED ANTES')
    for (const k of ['sup', 'eng', mst]) await falha(k, 'conciliar_estorno', { p_credito: ea.id, p_debito: sa.id }, 'Somente o Financeiro')
    await falha('fin', 'conciliar_estorno', { p_credito: ex.id, p_debito: sa.id }, 'diferente da saída')
    await falha('fin', 'conciliar_estorno', { p_credito: sa.id, p_debito: ea.id }, 'precisa ser uma entrada')
    await falha('fin', 'conciliar_estorno', { p_credito: eb.id, p_debito: sa.id }, 'anterior ao estorno')
    await rpc('fin', 'conciliar_estorno', { p_credito: ea.id, p_debito: sa.id })
    const [sa2] = await linhaPor(conta, 'PIX ENVIADO EST A'); const [ea2] = await linhaPor(conta, 'PIX DEVOLVIDO EST A')
    assert.deepEqual([sa2.situacao, ea2.situacao, sa2.estorno_linha, ea2.estorno_linha], ['conciliada', 'conciliada', ea.id, sa.id])
    await falha('fin', 'conciliar_estorno', { p_credito: ea.id, p_debito: sa.id }, 'já foi conciliado')
    // Desfazer em qualquer ponta separa as duas
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: sa.id, p_voltar_aberto: false, p_motivo: 'teste' })
    assert.deepEqual([(await linhaPor(conta, 'PIX ENVIADO EST A'))[0].situacao, (await linhaPor(conta, 'PIX DEVOLVIDO EST A'))[0].situacao], ['pendente', 'pendente'])

    // Saída conciliada com conta liberada (baixa pela conciliação): o estorno reabre a conta e avisa
    const p = await liberada(1350, '2026-12-22')
    await importar('fin', [L('2026-12-22', -1350, 'PIX ENVIADO EST B', 'E5'), L('2026-12-23', 1350, 'ESTORNO PIX EST B', 'E6')])
    const [sb] = await linhaPor(conta, 'PIX ENVIADO EST B'); const [eb2] = await linhaPor(conta, 'ESTORNO PIX EST B')
    await rpc('fin', 'conciliar_linha', { p_linha_id: sb.id, p_itens: [{ tipo: 'pagamento', id: p.id }] })
    assert.equal((await pagamento(p.id)).status, 'pago')
    await rpc('fin', 'conciliar_estorno', { p_credito: eb2.id, p_debito: sb.id })
    const pr = await pagamento(p.id)
    assert.equal(pr.status, 'aguardando_pagamento', 'a conta volta para em aberto')
    assert.equal((await admin.from('conciliacao_itens').select('id').eq('linha_id', sb.id)).data.length, 0)
    assert.equal((await linhaPor(conta, 'PIX ENVIADO EST B'))[0].estorno_linha, eb2.id)
    const { data: aud } = await admin.from('auditoria').select('descricao').eq('pagamento_id', p.id).eq('acao', 'desconciliou')
    assert.ok(aud.some((a) => /Estorno do banco em 23\/12\/2026/.test(a.descricao)), 'auditoria registra o motivo')
    // Desfazer o par: a conta reaberta continua em aberto
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: eb2.id, p_voltar_aberto: false, p_motivo: 'teste' })
    assert.equal((await pagamento(p.id)).status, 'aguardando_pagamento')

    // Conta baixada à mão e depois conciliada (baixou = false): o estorno também reabre
    const p3 = await liberada(777, '2026-12-24')
    await rpc('fin', 'conciliar_linha', { p_linha_id: (await importar('fin', [L('2026-12-24', -777, 'PIX ENVIADO EST C', 'E7')]), (await linhaPor(conta, 'PIX ENVIADO EST C'))[0].id), p_itens: [{ tipo: 'pagamento', id: p3.id }] })
    const [sc] = await linhaPor(conta, 'PIX ENVIADO EST C')
    await admin.from('conciliacao_itens').update({ baixou: false }).eq('linha_id', sc.id) // como se a baixa tivesse sido manual
    await importar('fin', [L('2026-12-26', 777, 'DEVOLUCAO PIX EST C', 'E8')])
    const [ec] = await linhaPor(conta, 'DEVOLUCAO PIX EST C')
    await rpc('fin', 'conciliar_estorno', { p_credito: ec.id, p_debito: sc.id })
    assert.equal((await pagamento(p3.id)).status, 'aguardando_pagamento')

    // Lançamento criado pela conciliação (obra com engenheiro e administrador): o estorno cancela e avisa os dois
    const cat = (await admin.from('categorias').select('id').eq('ativo', true).limit(1).single()).data.id
    await importar('fin', [L('2026-12-27', -260, 'PIX ENVIADO EST D', 'E9'), L('2026-12-28', 260, 'PIX DEVOLVIDO EST D', 'E10')])
    const [sd] = await linhaPor(conta, 'PIX ENVIADO EST D'); const [ed] = await linhaPor(conta, 'PIX DEVOLVIDO EST D')
    const pd = await rpc('fin', 'criar_lancamento_conciliacao', { p_linha_id: sd.id, p_obra_id: obraA.id, p_categoria_id: cat, p_descricao: 'Diária' })
    await rpc('fin', 'conciliar_estorno', { p_credito: ed.id, p_debito: sd.id })
    assert.equal((await pagamento(pd)).status, 'cancelado')
    const avisos = async (k) => (await u[k].client.from('notificacoes').select('titulo, mensagem').eq('pagamento_id', pd).eq('titulo', 'Pagamento estornado pelo banco')).data
    const [ae, aa, af] = [await avisos('eng'), await avisos('adm'), await avisos('fin')]
    assert.deepEqual([ae.length, aa.length, af.length], [1, 1, 0], 'engenheiro e administrador avisados')
    assert.match(ae[0].mensagem, /R\$ 260,00 .* voltou em 28\/12\/2026\. O lançamento criado pela conciliação foi cancelado/)
  })

  test('conta de investimento (Rende Fácil): só Financeiro cadastra, sem agência/conta; aplicação/resgate como transferência; saldo pelas transferências; não paga despesa', async () => {
    const nome = 'BB Rende Fácil ' + contaNum
    for (const k of ['sup', 'eng', mst]) await falha(k, 'criar_conta_investimento', { p_nome: nome, p_banco: '001' }, 'Somente o Financeiro')
    const inv = await rpc('fin', 'criar_conta_investimento', { p_nome: nome, p_banco: '001' })
    await falha('fin', 'criar_conta_investimento', { p_nome: nome.toUpperCase() }, 'Já existe')
    const inv2 = await rpc('fin', 'criar_conta_investimento', { p_nome: 'Poupança ' + contaNum, p_banco: '001' })
    assert.notEqual(inv, inv2, 'duas contas de investimento do mesmo banco (sem número) convivem')
    const { data: c } = await admin.from('contas_bancarias').select('tipo, agencia, conta').eq('id', inv).single()
    assert.deepEqual([c.tipo, c.agencia, c.conta], ['investimento', '', ''])
    await importar('fin', [L('2026-12-27', -4814.71, 'BB RENDE FACIL APL', 'R1'), L('2026-12-28', 1000, 'BB RENDE FACIL RES', 'R2')])
    const [ap] = await linhaPor(conta, 'BB RENDE FACIL APL'); const [rs] = await linhaPor(conta, 'BB RENDE FACIL RES')
    await rpc('fin', 'criar_transferencia', { p_linha_id: ap.id, p_outra_conta: inv })
    await rpc('fin', 'criar_transferencia', { p_linha_id: rs.id, p_outra_conta: inv })
    const saldo = async (k) => (await u[k].client.rpc('saldos_contas_bancarias')).data.find((x) => x.id === inv)
    const s = await saldo('fin')
    assert.deepEqual([Number(s.saldo), s.saldo_em], [3814.71, '2026-12-28'], 'aplicado − resgatado')
    assert.equal(await saldo('eng'), undefined, 'engenheiro não vê saldo')
    // Extrato importado com conta vazia/igual não cai na conta de investimento
    const r = await importar('fin', [L('2026-12-29', -1, 'Z1', 'Z1')])
    assert.equal(r.conta_id, conta)
  })

  test('Rende Fácil na própria conta: aplicação e resgate conciliados sem despesa/receita; valor aplicado; só Financeiro; desfazer volta para pendente', async () => {
    await importar('fin', [L('2026-12-27', -4000, 'BB RENDE FACIL AP2', 'RF1'), L('2026-12-28', 1500, 'BB RENDE FACIL RS2', 'RF2')])
    const [ap] = await linhaPor(conta, 'BB RENDE FACIL AP2'); const [rs] = await linhaPor(conta, 'BB RENDE FACIL RS2')
    for (const k of ['sup', 'eng', mst]) await falha(k, 'conciliar_aplicacao', { p_ids: [ap.id] }, 'Somente o Financeiro')
    const antes = (await admin.from('pagamentos').select('id', { count: 'exact', head: true })).count
    assert.equal(await rpc('fin', 'conciliar_aplicacao', { p_ids: [ap.id, rs.id] }), 2)
    assert.equal(await rpc('fin', 'conciliar_aplicacao', { p_ids: [ap.id] }), 0, 'já conciliada não conta de novo')
    const [ap2] = await linhaPor(conta, 'BB RENDE FACIL AP2')
    assert.deepEqual([ap2.situacao, ap2.classificacao, ap2.transferencia_id], ['conciliada', 'aplicacao', null])
    assert.equal((await admin.from('pagamentos').select('id', { count: 'exact', head: true })).count, antes, 'não vira despesa')
    const aplicado = async (k) => (await u[k].client.rpc('aplicado_nas_contas')).data.find((x) => x.conta_id === conta)
    assert.equal(Number((await aplicado('fin')).aplicado), 2500, 'aplicado − resgatado')
    assert.equal(await aplicado('eng'), undefined, 'engenheiro não vê')
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: rs.id, p_voltar_aberto: false, p_motivo: 'teste' })
    const [rs2] = await linhaPor(conta, 'BB RENDE FACIL RS2')
    assert.deepEqual([rs2.situacao, rs2.classificacao], ['pendente', null])
    assert.equal(Number((await aplicado(mst)).aplicado), 4000)
  })

  test('contas a receber: entrada vira recebimento já recebido (só Financeiro); categoria de receita; todos veem as obras que podem ver; Financeiro/master editam e anexam nota; desfazer cancela', async () => {
    const catRec = await rpc('fin', 'criar_categoria_receita', { p_nome: 'Medição ' + contaNum })
    const catDesp = (await admin.from('categorias').select('id').eq('tipo', 'despesa').eq('ativo', true).limit(1).single()).data.id
    await falha('sup', 'criar_categoria_receita', { p_nome: 'X' }, 'Somente o Financeiro')
    assert.equal(await rpc(mst, 'criar_categoria_receita', { p_nome: 'Medição ' + contaNum }), catRec, 'mesmo nome devolve a existente')
    assert.notEqual(await rpc('fin', 'criar_categoria', { p_nome: 'Medição ' + contaNum }), catRec, 'despesa e receita com o mesmo nome convivem')
    await importar('fin', [L('2026-12-14', 15000, 'TED RECEBIDA CLIENTE REC', 'RC1'), L('2026-12-14', -50, 'SAIDA REC', 'RC2')])
    const [le] = await linhaPor(conta, 'TED RECEBIDA CLIENTE REC'); const [ls] = await linhaPor(conta, 'SAIDA REC')
    const args = { p_linha_id: le.id, p_obra_id: obraA.id, p_categoria_id: catRec, p_cliente: 'Cliente Rec', p_descricao: '1ª medição' }
    for (const k of ['sup', 'eng', 'adm', mst]) await falha(k, 'criar_recebimento_conciliacao', args, 'Somente o Financeiro')
    await falha('fin', 'criar_recebimento_conciliacao', { ...args, p_categoria_id: catDesp }, 'categoria de receita')
    await falha('fin', 'criar_recebimento_conciliacao', { ...args, p_cliente: ' ' }, 'cliente')
    await falha('fin', 'criar_recebimento_conciliacao', { ...args, p_linha_id: ls.id }, 'Saídas do banco não viram recebimento')
    const id = await rpc('fin', 'criar_recebimento_conciliacao', args)
    const { data: r } = await admin.from('recebimentos').select('*').eq('id', id).single()
    assert.deepEqual([r.status, r.recebido_em, Number(r.valor), Number(r.valor_recebido), r.vencimento, r.conta_bancaria_id, r.lancado_conciliacao], ['recebido', '2026-12-14', 15000, 15000, '2026-12-14', conta, true])
    const [le2] = await linhaPor(conta, 'TED RECEBIDA CLIENTE REC'); assert.deepEqual([le2.situacao, le2.recebimento_id], ['conciliada', id])
    await falha('fin', 'criar_recebimento_conciliacao', args, 'já foi conciliado')
    // Visibilidade: engenheiro e administrador da obra A veem; quem não atua nela não
    const ve = async (k) => (await u[k].client.from('recebimentos').select('id').eq('id', id)).data.length
    assert.deepEqual([await ve('eng'), await ve('adm'), await ve('fin'), await ve(mst), await ve('sup')], [1, 1, 1, 1, 1])
    await importar('fin', [L('2026-12-15', 900, 'PIX RECEBIDO OBRA C REC', 'RC3')])
    const idC = await rpc('fin', 'criar_recebimento_conciliacao', { ...args, p_linha_id: (await linhaPor(conta, 'PIX RECEBIDO OBRA C REC'))[0].id, p_obra_id: obraC.id })
    assert.equal((await u.eng.client.from('recebimentos').select('id').eq('id', idC)).data.length, 0, 'engenheiro não vê recebimento de obra em que não atua')
    // Escrita direta recusada
    await u.fin.client.from('recebimentos').update({ valor: 1 }).eq('id', id)
    assert.equal(Number((await admin.from('recebimentos').select('valor').eq('id', id).single()).data.valor), 15000)
    // Editar: Financeiro e master; não engenheiro
    await falha('eng', 'editar_recebimento', { p_id: id, p_obra_id: obraA.id, p_categoria_id: catRec, p_cliente: 'X', p_descricao: 'X', p_competencia: null, p_observacoes: null }, 'Somente o Financeiro e o administrador master')
    await rpc(mst, 'editar_recebimento', { p_id: id, p_obra_id: obraA.id, p_categoria_id: catRec, p_cliente: 'Cliente Rec SA', p_descricao: '1ª medição de dezembro', p_competencia: '2026-11-30', p_observacoes: 'ok' })
    const { data: r2 } = await admin.from('recebimentos').select('cliente, descricao, data_competencia, valor').eq('id', id).single()
    assert.deepEqual([r2.cliente, r2.descricao, r2.data_competencia, Number(r2.valor)], ['Cliente Rec SA', '1ª medição de dezembro', '2026-11-30', 15000])
    await falha('fin', 'editar_recebimento', { p_id: id, p_obra_id: obraA.id, p_categoria_id: catDesp, p_cliente: 'X', p_descricao: 'X', p_competencia: null, p_observacoes: null }, 'categoria de receita')
    // Nota de medição: só do mesmo centro de custo, uma por recebimento
    const nota = (obra) => admin.from('notas_medicao').insert({ obra_id: obra, storage_path: `${obra}/medicoes/${randomUUID()}.pdf`, nome_arquivo: 'med.pdf', sha256: 'a'.repeat(64), valor: 16000, valor_liquido: 15000, criada_por: u.fin.id }).select('id').single()
    const nA = (await nota(obraA.id)).data.id; const nB = (await nota(obraB.id)).data.id
    await falha('fin', 'vincular_nota_medicao', { p_recebimento_id: id, p_nota_id: nB }, 'outro centro de custo')
    await falha('eng', 'vincular_nota_medicao', { p_recebimento_id: id, p_nota_id: nA }, 'Somente o Financeiro')
    await rpc(mst, 'vincular_nota_medicao', { p_recebimento_id: id, p_nota_id: nA })
    assert.equal((await admin.from('recebimentos').select('nota_medicao_id').eq('id', id).single()).data.nota_medicao_id, nA)
    const { data: vn } = await u.eng.client.from('notas_medicao').select('id').eq('id', nA)
    assert.equal(vn.length, 1, 'engenheiro vê a nota anexada ao recebimento da obra dele')
    await falha('fin', 'editar_recebimento', { p_id: id, p_obra_id: obraB.id, p_categoria_id: catRec, p_cliente: 'X', p_descricao: 'X', p_competencia: null, p_observacoes: null }, 'retire a nota')
    // Categoria de receita não entra em despesa
    const pag = await rpc('fin', 'criar_pagamento', { p_obra_id: obraC.id, p_fornecedor_id: null, p_favorecido: 'F', p_descricao: 'Cat', p_valor: 10, p_vencimento: '2026-12-30', p_forma_pagamento: 'pix' })
    await falha('fin', 'definir_categoria', { p_pagamento_id: pag, p_categoria_id: catRec }, 'Categoria de receita não pode ser usada em despesa')
    // Desfazer: "apenas" mantém o recebimento; "cancelar" cancela
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: le.id, p_voltar_aberto: false, p_motivo: 'teste' })
    assert.equal((await admin.from('recebimentos').select('status').eq('id', id).single()).data.status, 'recebido')
    assert.deepEqual([(await linhaPor(conta, 'TED RECEBIDA CLIENTE REC'))[0].situacao, (await linhaPor(conta, 'TED RECEBIDA CLIENTE REC'))[0].recebimento_id], ['pendente', null])
    const id2 = await rpc('fin', 'criar_recebimento_conciliacao', { ...args, p_descricao: 'de novo' })
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: le.id, p_voltar_aberto: true, p_motivo: 'lançado errado' })
    assert.equal((await admin.from('recebimentos').select('status').eq('id', id2).single()).data.status, 'cancelado')
    const { data: aud } = await admin.from('auditoria').select('acao').eq('entidade', 'recebimento').eq('entidade_id', id)
    assert.ok(['criou', 'editou', 'anexou_nota', 'desconciliou'].every((a) => aud.some((x) => x.acao === a)), 'auditoria completa')
  })

  test('receita manual e medição: receita total + imposto retido (a pagar) + devido (pago na baixa manual); entrada líquida concilia receita − retido; desfazer volta a aberto; cancelar', async () => {
    const catRec = await rpc('fin', 'criar_categoria_receita', { p_nome: 'Medição int ' + contaNum })
    const catImp = await rpc('fin', 'criar_categoria', { p_nome: 'Impostos int ' + contaNum })
    // Receita manual
    const base = { p_obra_id: obraA.id, p_categoria_id: catRec, p_cliente: 'Cliente Manual', p_descricao: 'Aporte', p_valor: 5000, p_vencimento: '2026-12-20' }
    for (const k of ['sup', 'eng']) await falha(k, 'criar_recebimento', base, 'Somente o Financeiro e o administrador master')
    const rm = await rpc(mst, 'criar_recebimento', base)
    assert.equal((await admin.from('recebimentos').select('status').eq('id', rm).single()).data.status, 'aberto')
    await falha('fin', 'cancelar_recebimento', { p_id: rm, p_motivo: '' }, 'motivo')
    await rpc('fin', 'cancelar_recebimento', { p_id: rm, p_motivo: 'lançada errado' })
    assert.equal((await admin.from('recebimentos').select('status').eq('id', rm).single()).data.status, 'cancelado')
    // Medição: total 10.000, líquido 9.400 → retido 600; devido 14% = 1.400 − 600 = 800
    const { data: nota } = await admin.from('notas_medicao').insert({ obra_id: obraA.id, storage_path: `${obraA.id}/medicoes/${randomUUID()}.pdf`, nome_arquivo: 'med.pdf', numero: '12', sha256: 'd'.repeat(64), valor: 10000, valor_liquido: 9400, criada_por: u.fin.id }).select('id').single()
    const args = { p_nota_id: nota.id, p_vencimento: '2026-12-22', p_conta_id: conta, p_cliente: '', p_categoria_receita: catRec, p_categoria_imposto: catImp, p_aliquota: 14 }
    await falha('eng', 'lancar_medicao', args, 'Somente o Financeiro')
    const rec = await rpc('fin', 'lancar_medicao', args)
    const { data: r } = await admin.from('recebimentos').select('valor, status, nota_medicao_id, cliente').eq('id', rec).single()
    assert.deepEqual([Number(r.valor), r.status, r.nota_medicao_id], [10000, 'aberto', nota.id])
    const { data: imp } = await admin.from('pagamentos').select('id, imposto_medicao, valor, status, conta_bancaria_id, pago_em').eq('recebimento_id', rec).order('imposto_medicao')
    const ret = imp.find((i) => i.imposto_medicao === 'retido'); const dev = imp.find((i) => i.imposto_medicao === 'devido')
    assert.deepEqual([Number(ret.valor), ret.status, ret.conta_bancaria_id], [600, 'aguardando_pagamento', conta])
    const manual = (await admin.from('contas_bancarias').select('id').eq('tipo', 'manual').single()).data.id
    assert.deepEqual([Number(dev.valor), dev.status, dev.conta_bancaria_id], [800, 'pago', manual])
    assert.equal((await admin.from('assinaturas').select('id', { count: 'exact', head: true }).in('pagamento_id', [ret.id, dev.id])).count, 0, 'sem aprovação')
    const aviso = (await u.eng.client.from('notificacoes').select('titulo').eq('titulo', 'Medição lançada com impostos')).data.length
    assert.ok(aviso >= 1, 'engenheiro avisado')
    await falha('fin', 'lancar_medicao', args, 'já foi lançada')
    // Valores editáveis: o Financeiro corrige o retido e o devido calculados
    const { data: nota2 } = await admin.from('notas_medicao').insert({ obra_id: obraA.id, storage_path: `${obraA.id}/medicoes/${randomUUID()}.pdf`, nome_arquivo: 'med2.pdf', numero: '13', sha256: 'f'.repeat(64), valor: 20000, valor_liquido: 18800, criada_por: u.fin.id }).select('id').single()
    const rec2 = await rpc('fin', 'lancar_medicao', { ...args, p_nota_id: nota2.id, p_retido: 1150, p_devido: 1630.5 })
    const { data: imp2b } = await admin.from('pagamentos').select('imposto_medicao, valor').eq('recebimento_id', rec2)
    assert.deepEqual(imp2b.map((i) => `${i.imposto_medicao}:${Number(i.valor)}`).sort(), ['devido:1630.5', 'retido:1150'])
    // A nota guarda o que foi de fato lançado (alíquota e valores editados): o resumo da tela não usa mais só 14% fixos
    const { data: gravada } = await admin.from('notas_medicao').select('aliquota_aplicada, retido_lancado, devido_lancado, impostos_lancados_em').eq('id', nota2.id).single()
    assert.deepEqual([Number(gravada.aliquota_aplicada), Number(gravada.retido_lancado), Number(gravada.devido_lancado)], [14, 1150, 1630.5])
    assert.ok(gravada.impostos_lancados_em, 'data do lançamento dos impostos')
    const { data: gravada1 } = await admin.from('notas_medicao').select('retido_lancado, devido_lancado').eq('id', nota.id).single()
    assert.deepEqual([Number(gravada1.retido_lancado), Number(gravada1.devido_lancado)], [600, 800], 'sem edição: guarda o calculado')
    await falha('fin', 'lancar_medicao', { ...args, p_nota_id: (await admin.from('notas_medicao').insert({ obra_id: obraA.id, storage_path: `${obraA.id}/medicoes/${randomUUID()}.pdf`, nome_arquivo: 'm3.pdf', sha256: '1'.repeat(64), valor: 100, valor_liquido: 90, criada_por: u.fin.id }).select('id').single()).data.id, p_retido: 100 }, 'Imposto retido inválido')
    // Conciliação: entra o líquido (9.400)
    await importar('fin', [L('2026-12-22', 9400, 'TED RECEBIDA MEDICAO 12', 'MD1'), L('2026-12-22', 9999, 'TED OUTRA', 'MD2')])
    const [lm] = await linhaPor(conta, 'TED RECEBIDA MEDICAO 12'); const [lo] = await linhaPor(conta, 'TED OUTRA')
    await falha('fin', 'conciliar_recebimento', { p_linha_id: lo.id, p_recebimento_id: rec }, 'não bate')
    await falha(mst, 'conciliar_recebimento', { p_linha_id: lm.id, p_recebimento_id: rec }, 'Somente o Financeiro')
    await rpc('fin', 'conciliar_recebimento', { p_linha_id: lm.id, p_recebimento_id: rec })
    const { data: r2 } = await admin.from('recebimentos').select('status, recebido_em, valor_recebido').eq('id', rec).single()
    assert.deepEqual([r2.status, r2.recebido_em, Number(r2.valor_recebido)], ['recebido', '2026-12-22', 10000])
    const { data: ret2 } = await admin.from('pagamentos').select('status, pago_em').eq('id', ret.id).single()
    assert.deepEqual([ret2.status, ret2.pago_em], ['pago', '2026-12-22'], 'retido baixado junto')
    // Desfazer voltando a aberto: receita em aberto e retido a pagar de novo
    await rpc('fin', 'desfazer_conciliacao', { p_linha_id: lm.id, p_voltar_aberto: true, p_motivo: 'teste' })
    assert.equal((await admin.from('recebimentos').select('status').eq('id', rec).single()).data.status, 'aberto')
    assert.equal((await admin.from('pagamentos').select('status').eq('id', ret.id).single()).data.status, 'aguardando_pagamento')
    // Cancelar a receita cancela o retido em aberto (o devido já pago fica)
    await rpc('fin', 'cancelar_recebimento', { p_id: rec, p_motivo: 'teste' })
    const { data: imp2 } = await admin.from('pagamentos').select('imposto_medicao, status').eq('recebimento_id', rec)
    assert.deepEqual(imp2.map((i) => `${i.imposto_medicao}:${i.status}`).sort(), ['devido:pago', 'retido:cancelado'])
  })

  test('arquivar com tipo, não mexe em conciliadas, restaurar; tipo inválido recusado', async () => {
    await importar('fin', [L('2026-12-12', -8.5, 'TAR X', 'J1'), L('2026-12-12', 1000, 'CRED X', 'J2')])
    const [t] = await linhaPor(conta, 'TAR X'); const [c] = await linhaPor(conta, 'CRED X'); const [conc] = await linhaPor(conta, 'DEB PIX CHAVE 2420')
    await falha('fin', 'arquivar_linhas', { p_ids: [t.id], p_classificacao: 'xyz' }, 'classificação')
    await falha('sup', 'arquivar_linhas', { p_ids: [t.id], p_classificacao: 'tarifa' }, 'Somente o Financeiro')
    assert.equal(await rpc('fin', 'arquivar_linhas', { p_ids: [t.id, conc.id], p_classificacao: 'tarifa' }), 1, 'conciliada não é arquivada')
    await rpc('fin', 'arquivar_linhas', { p_ids: [c.id], p_classificacao: 'entrada', p_observacao: 'cliente X' })
    const [t2] = await linhaPor(conta, 'TAR X'); const [c2] = await linhaPor(conta, 'CRED X')
    assert.deepEqual([t2.situacao, t2.classificacao, c2.classificacao, c2.observacao], ['arquivada', 'tarifa', 'entrada', 'cliente X'])
    await rpc('fin', 'restaurar_linha', { p_id: t.id })
    assert.equal((await linhaPor(conta, 'TAR X'))[0].situacao, 'pendente')
    await falha('fin', 'restaurar_linha', { p_id: t.id }, 'não está arquivado')
    await rpc('fin', 'renomear_conta_bancaria', { p_id: conta, p_nome: 'Caixa Parceria 4' })
    const { data: cb } = await admin.from('contas_bancarias').select('nome').eq('id', conta).single(); assert.equal(cb.nome, 'Caixa Parceria 4')
    await falha('sup', 'renomear_conta_bancaria', { p_id: conta, p_nome: 'X' }, 'Somente o Financeiro')
  })

  test('regressão: fila de avisos — duas reservas não pegam o mesmo aviso; falha volta para a fila com espera e vira "falhou" na 4ª; só o serviço executa', async () => {
    const mk = async (titulo) => (await admin.from('notificacoes').insert({ user_id: u.fin.id, titulo, mensagem: 'x', email_status: 'pendente', whatsapp_status: 'pendente' }).select('id').single()).data.id
    const ids = [await mk(`Fila A ${sufixo}`), await mk(`Fila B ${sufixo}`)]
    // Quem não é o serviço não reserva nem registra resultado
    const semAcesso = await u.fin.client.rpc('reservar_avisos', { p_canal: 'email', p_limite: 5 })
    assert.ok(semAcesso.error, 'usuário comum reservou avisos')
    const [r1, r2] = await Promise.all([admin.rpc('reservar_avisos', { p_canal: 'email', p_limite: 1000 }), admin.rpc('reservar_avisos', { p_canal: 'email', p_limite: 1000 })])
    assert.ifError(r1.error); assert.ifError(r2.error)
    const a = new Set(r1.data), b = new Set(r2.data)
    for (const id of ids) assert.equal([a.has(id), b.has(id)].filter(Boolean).length, 1, 'o mesmo aviso foi reservado duas vezes (ou nenhuma)')
    const { data: est } = await admin.from('notificacoes').select('email_status').eq('id', ids[0]).single()
    assert.equal(est.email_status, 'processando')
    // Falhas: 1ª a 3ª voltam para "pendente" com espera; a 4ª vira "falhou"
    for (let n = 1; n <= 4; n++) {
      await admin.from('notificacoes').update({ email_status: 'processando', email_proxima_em: null }).eq('id', ids[0])
      const { data: res, error } = await admin.rpc('registrar_resultado_aviso', { p_canal: 'email', p_id: ids[0], p_ok: false, p_erro: 'provedor fora do ar' })
      assert.ifError(error)
      assert.equal(res, n < 4 ? 'pendente' : 'falhou', `tentativa ${n}`)
      const { data: x } = await admin.from('notificacoes').select('email_status, email_tentativas, email_proxima_em').eq('id', ids[0]).single()
      assert.equal(x.email_tentativas, n)
      if (n < 4) assert.ok(new Date(x.email_proxima_em) > new Date(), 'sem espera antes da nova tentativa')
    }
    // Aviso com espera ainda não é reservado; sucesso marca enviado
    await admin.from('notificacoes').update({ email_status: 'pendente', email_proxima_em: new Date(Date.now() + 3600e3).toISOString() }).eq('id', ids[1])
    const r3 = await admin.rpc('reservar_avisos', { p_canal: 'email', p_limite: 1000 })
    assert.ok(!r3.data.includes(ids[1]), 'reservou aviso que ainda está em espera')
    await admin.from('notificacoes').update({ email_proxima_em: null }).eq('id', ids[1])
    const r4 = await admin.rpc('reservar_avisos', { p_canal: 'email', p_limite: 1000 })
    assert.ok(r4.data.includes(ids[1]))
    await admin.rpc('registrar_resultado_aviso', { p_canal: 'email', p_id: ids[1], p_ok: true })
    const { data: ok } = await admin.from('notificacoes').select('email_status, email_enviado_em').eq('id', ids[1]).single()
    assert.equal(ok.email_status, 'enviado'); assert.ok(ok.email_enviado_em)
    // Reserva esquecida há mais de 15 minutos volta para a fila (execução que caiu no meio)
    await admin.from('notificacoes').update({ whatsapp_status: 'processando', whatsapp_reservado_em: new Date(Date.now() - 20 * 60e3).toISOString() }).eq('id', ids[0])
    const w = await admin.rpc('reservar_avisos', { p_canal: 'whatsapp', p_limite: 1000 })
    assert.ok(w.data.includes(ids[0]), 'reserva esquecida não voltou para a fila')
  })

  test('regressão: fornecedor não aceita autor forjado (created_by = quem cadastrou) e função interna de receita não é chamável sem login', async () => {
    const { data, error } = await u.sup.client.from('fornecedores').insert({ nome: `Forn autor ${sufixo}`, created_by: u.fin.id }).select('id, created_by').single()
    assert.ifError(error)
    assert.equal(data.created_by, u.sup.id, 'o autor foi forjado')
    const anon = createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } })
    const r = await anon.rpc('_validar_receita', { p_obra_id: randomUUID(), p_categoria_id: randomUUID(), p_cliente: 'x', p_descricao: 'x', p_valor: 1, p_vencimento: '2026-12-01' })
    assert.ok(r.error, 'anônimo conseguiu chamar a função interna')
  })
})
