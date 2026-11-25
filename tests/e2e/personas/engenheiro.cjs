// Persona: "Carlos, engenheiro de obra" (engenheiro@demo.local). Ele SABE as regras do projeto: vê só as obras dele,
// solicita OP, assina a própria OP e cada anexo, aprova a etapa dele, lança gasto de fundo fixo, consulta Compras
// (CNPJ mascarado) e vê Contas a pagar das obras dele. Também tenta o que NÃO pode (tela e API direta) e confere que o
// servidor bloqueia. Dados fictícios, sempre com `marca()`. Rodar: node tests/e2e/personas/engenheiro.cjs
const { rodar, admin, um, hoje, somarDias, marca, confere, cliente, ir, BASE, DIR } = require('./_util.cjs');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createClient } = require('@supabase/supabase-js');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const ASSINATURA = path.join(__dirname, '..', '..', '..', 'public', 'logo-empresa.jpg');
const SENHA = 'Demo-1234';
const ITENS = [
  { descricao: 'Cimento CP-II 50kg', unidade: 'SC', quantidade: 10, valor_unitario: 35.5 },
  { descricao: 'Areia média', unidade: 'm³', quantidade: 2.5, valor_unitario: 120.1 },
];
const SUBTOTAL = 10 * 35.5 + Math.round(2.5 * 120.1 * 100) / 100; // 355,00 + 300,25 = 655,25
const reais = (v) => Number(v).toFixed(2);
const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\s/g, ' ');

async function pdfBytes(texto) {
  const doc = await PDFDocument.create();
  const pg = doc.addPage([595, 842]);
  pg.drawText(texto.slice(0, 80), { x: 50, y: 780, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await doc.save());
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const falha = async (q, re, msg) => {
  const { error } = await q;
  confere(error, msg ?? 'o servidor deveria recusar');
  if (re) confere(re.test(error.message), `mensagem inesperada: "${error.message}"`);
  return error.message;
};
/** Escrita direta (insert/update/delete) é recusada de duas formas: erro, ou 0 linhas afetadas. */
const semEfeito = async (q, msg) => {
  const { data, error } = await q.select();
  confere(error || !data || data.length === 0, `${msg}: o servidor aceitou a escrita direta (${JSON.stringify(data).slice(0, 120)})`);
};

rodar('Persona Engenheiro (Carlos)', async ({ b, passo, entrar }) => {
  // ---------- dados e clientes ----------
  const eng = await cliente('engenheiro');
  const fin = await cliente('financeiro');
  const adm = await cliente('administrador'); // administrador da obra do engenheiro (Ana)
  const sup = await cliente('suprimentos');
  const euId = (await eng.auth.getUser()).data.user.id;
  /** Quem é "dele": a verdade vem do banco (service role), não do que a API devolve ao engenheiro. Outros testes criam obras ligadas a ele. */
  async function vinculos() {
    const todas = await um(admin.from('obras').select('id, nome, status, fluxo, engenheiro_id, administrador_id'));
    const acessos = await um(admin.from('obra_acessos').select('obra_id').eq('user_id', euId));
    const minhas = todas.filter((o) => o.engenheiro_id === euId || o.administrador_id === euId || acessos.some((a) => a.obra_id === o.id));
    return { todas, minhas, outras: todas.filter((o) => !minhas.some((m) => m.id === o.id)) };
  }
  const v0 = await vinculos();
  const obra = v0.minhas.find((o) => o.nome === 'Galpão Logístico Camaçari') ?? v0.minhas.find((o) => o.status === 'ativa' && o.fluxo === 'A' && o.engenheiro_id === euId && o.administrador_id);
  confere(obra, 'o engenheiro demo precisa ter uma obra ativa com administrador');
  const outras = v0.outras.filter((o) => o.id !== obra.id).sort((a, b) => (a.nome === 'Piso Industrial Feira' ? -1 : 0) - (b.nome === 'Piso Industrial Feira' ? -1 : 0));
  confere(outras.length >= 1, 'precisa existir ao menos uma obra de outro vínculo');
  const categoria = (await um(admin.from('categorias').select('id').eq('ativo', true).limit(1)))[0].id;
  const contas = await um(admin.from('contas_bancarias').select('id, nome').eq('ativa', true).eq('tipo', 'corrente').order('nome'));
  const conta = (contas.find((c) => c.nome === 'Banco do Brasil (demo)') ?? contas[0]).id;
  const admId = (await adm.auth.getUser()).data.user.id;
  const pdfUI = path.join(DIR, 'engenheiro-anexo.pdf');
  fs.writeFileSync(pdfUI, await pdfBytes('anexo de teste do engenheiro'));
  const pagDoBanco = (id) => um(admin.from('pagamentos').select('*').eq('id', id).single());
  const opDoBanco = (id) => um(admin.from('ordens_pagamento').select('*').eq('id', id).single());

  // ---------- auxiliares de OP (equivalem ao que a tela faz) ----------
  async function rascunho(c, o = {}) {
    const id = await um(c.rpc('salvar_op', {
      p_id: o.id ?? null, p_obra_id: o.obra ?? obra.id, p_favorecido: o.favorecido ?? marca('Forn'), p_cpf_cnpj: o.cpf ?? '',
      p_descricao: o.descricao ?? marca('Desp'), p_vencimento: o.venc === undefined ? somarDias(hoje, 10) : o.venc,
      p_forma_pagamento: o.forma ?? 'pix', p_dados_bancarios: 'BANCO: Banco Teste\nCHAVE PIX: teste@exemplo.com', p_observacoes: '',
      p_itens: o.itens ?? ITENS, p_desconto: o.desconto ?? 0, p_numero_nf: o.nf ?? '',
    }));
    if (o.semDados) return id;
    await um(c.rpc('definir_categoria_op', { p_ordem_id: id, p_categoria_id: categoria }));
    await um(c.rpc('definir_conta_bancaria_op', { p_ordem_id: id, p_conta_id: conta }));
    await um(c.rpc('definir_competencia_op', { p_ordem_id: id, p_data: hoje }));
    if (o.parcelas) await um(c.rpc('definir_parcelas_op', { p_id: id, p_parcelas: o.parcelas }));
    return id;
  }
  const assinarCriador = (c, id) => c.rpc('registrar_assinatura_criador', { p_ordem_id: id, p_pos: { fx: 0.68, fy: 0.78, fw: 0.24 } });
  const enviarRpc = (c, id) => c.rpc('enviar_op', { p_id: id });
  async function subir(c, obraId, pagId, texto) {
    const bytes = await pdfBytes(texto);
    const caminho = `${obraId}/${pagId}/${randomUUID()}.pdf`;
    const up = await c.storage.from('documentos').upload(caminho, bytes, { contentType: 'application/pdf' });
    if (up.error) throw new Error('upload: ' + up.error.message);
    return { caminho, bytes };
  }
  /** Faz como a tela: gera o PDF oficial, anexa e conclui a assinatura do engenheiro (OP segue ao administrador). */
  async function enviarCompleto(c, id) {
    await um(assinarCriador(c, id));
    const pagId = await um(enviarRpc(c, id));
    const op = await opDoBanco(id);
    const oficial = await subir(c, op.obra_id, pagId, `OP ${op.numero}`);
    await um(c.rpc('registrar_documento', { p_pagamento_id: pagId, p_tipo: 'ordem_pagamento', p_nome_arquivo: `${op.numero}.pdf`, p_storage_path: oficial.caminho, p_mime_type: 'application/pdf', p_tamanho: oficial.bytes.length, p_sha256: sha(oficial.bytes) }));
    const ass = await subir(c, op.obra_id, pagId, `OP ${op.numero} assinada`);
    await um(c.rpc('concluir_criacao_assinada', { p_pagamento_id: pagId, p_storage_path: ass.caminho, p_nome: `${op.numero}-assinado.pdf`, p_mime: 'application/pdf', p_tamanho: ass.bytes.length, p_sha256: sha(ass.bytes) }));
    return pagId;
  }
  /** O assinante registra a própria versão assinada do documento (equivale a posicionar a assinatura na tela). */
  async function assinarDoc(c, pagId) {
    const p = await pagDoBanco(pagId);
    const { caminho, bytes } = await subir(c, p.obra_id, pagId, `assinado ${pagId}`);
    await um(c.rpc('registrar_documento', { p_pagamento_id: pagId, p_tipo: 'documento_assinado', p_nome_arquivo: 'assinado.pdf', p_storage_path: caminho, p_mime_type: 'application/pdf', p_tamanho: bytes.length, p_sha256: sha(bytes) }));
  }
  const decidir = (c, pagId, versao, decisao, comentario) => c.rpc('decidir_aprovacao', { p_itens: [{ id: pagId, versao }], p_decisao: decisao, p_comentario: comentario ?? null });
  /** Despesa de outro perfil (financeiro) na obra do engenheiro, aguardando a assinatura dele. */
  async function despesaParaEngenheiro(rotulo, valor = 777.77) {
    const id = await um(fin.rpc('criar_pagamento', { p_obra_id: obra.id, p_fornecedor_id: null, p_favorecido: marca('Fornecedor'), p_descricao: rotulo, p_valor: valor, p_vencimento: somarDias(hoje, 12), p_forma_pagamento: 'boleto' }));
    const p = await pagDoBanco(id);
    const { caminho, bytes } = await subir(fin, p.obra_id, id, `boleto ${rotulo}`);
    await um(fin.rpc('registrar_documento', { p_pagamento_id: id, p_tipo: 'boleto', p_nome_arquivo: 'boleto.pdf', p_storage_path: caminho, p_mime_type: 'application/pdf', p_tamanho: bytes.length, p_sha256: sha(bytes) }));
    return id;
  }

  // ---------- telas: navegação do engenheiro ----------
  const p = await entrar('engenheiro');
  p.on('dialog', (d) => d.accept());
  const menu = () => p.getByRole('navigation', { name: 'Menu principal' }).locator('a').allInnerTexts();

  await passo('Minha assinatura: Carlos envia a imagem da assinatura e ela fica guardada', async () => {
    await ir(p, '/perfil');
    await p.setInputFiles('input[type=file]', ASSINATURA);
    await p.getByRole('button', { name: 'Salvar assinatura' }).click();
    await p.getByText(/Assinatura salva/).waitFor({ timeout: 30000 });
    const ass = (await um(admin.from('profiles').select('assinatura_path').eq('id', euId).single())).assinatura_path;
    confere(ass && ass.startsWith(euId + '/'), `assinatura_path: ${ass}`);
  });

  await passo('Menu do engenheiro: tem o que usa e NÃO tem Usuários, Contas bancárias, Fornecedores, Categorias, Notas, Histórico', async () => {
    await ir(p, '/');
    const itens = (await menu()).map((t) => t.replace(/\d+$/, '').trim());
    for (const quer of ['Painel', 'Agenda de pagamentos', 'Contas a pagar', 'Contas a receber', 'Aprovações e assinaturas', 'Minha assinatura', 'Centros de custo', 'Fundos fixos', 'Relatórios', 'Inteligência de Compras']) {
      confere(itens.some((i) => i.startsWith(quer)), `falta "${quer}" no menu: ${itens.join(' | ')}`);
    }
    for (const nao of ['Usuários e permissões', 'Contas bancárias', 'Fornecedores', 'Categorias', 'Notas de medição', 'Notas para contabilidade', 'Histórico de atividades']) {
      confere(!itens.some((i) => i.startsWith(nao)), `"${nao}" aparece no menu do engenheiro`);
    }
  });

  await passo('Centros de custo: lista só a obra dele (nenhuma de outro vínculo)', async () => {
    await ir(p, '/obras');
    const txt = await p.locator('main').innerText();
    const v = await vinculos();
    confere(txt.includes(obra.nome), 'a obra dele não aparece');
    for (const o of v.outras) confere(!txt.includes(o.nome), `aparece a obra de outro vínculo: ${o.nome}`);
    const naApi = await um(eng.from('obras').select('id'));
    confere(naApi.length >= v.minhas.length - 1 && naApi.every((o) => v.minhas.some((m) => m.id === o.id)), 'API devolve obra que não é dele');
  });

  await passo('Rotas proibidas pela tela: Usuários, Contas bancárias, Conciliação, Fornecedores, Categorias, Notas, Histórico, Baixar → voltam ao início', async () => {
    for (const rota of ['/usuarios', '/usuarios/novo', '/contas-bancarias', '/conciliacao', '/fornecedores', '/fornecedores/novo', '/categorias', '/notas-medicao', '/notas-contabeis', '/auditoria', '/pagamentos/baixar', '/obras/nova', '/compras/ler-notas']) {
      await p.goto(BASE + rota); await p.waitForLoadState('networkidle');
      const u = new URL(p.url());
      confere(u.pathname === '/', `${rota} não redirecionou (ficou em ${u.pathname})`);
    }
  });

  await passo('Contas a pagar pela tela: só mostra pagamentos da obra dele; nenhum botão de baixa/lote/conciliar', async () => {
    await ir(p, '/pagamentos?periodo=todos');
    const links = await p.locator('main a[href^="/pagamentos/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href').match(/^\/pagamentos\/([0-9a-f-]{36})/)?.[1]).filter(Boolean))]);
    if (links.length) {
      const donos = await um(admin.from('pagamentos').select('id, obra_id').in('id', links));
      const meus = new Set((await vinculos()).minhas.map((o) => o.id));
      confere(donos.every((x) => meus.has(x.obra_id)), 'a lista tem pagamento de outra obra');
    }
    const txt = await p.locator('main').innerText();
    confere(!/Baixar selecionad|Dar baixa|Conciliar/.test(txt), 'a tela mostra ação de baixa/conciliação ao engenheiro');
  });

  await passo('Contas a pagar pela API: todos os pagamentos visíveis ao engenheiro são das obras dele', async () => {
    const vis = await um(eng.from('pagamentos').select('id, obra_id'));
    const meus = new Set((await vinculos()).minhas.map((o) => o.id));
    confere(vis.length > 0 && vis.every((x) => meus.has(x.obra_id)), 'vazou pagamento de outra obra');
    const total = (await um(admin.from('pagamentos').select('id', { count: 'exact' }).in('obra_id', outras.map((o) => o.id)))).length;
    confere(total > 0, 'sem pagamentos de outras obras para provar o isolamento');
  });

  // ---------- OP: rascunho, valores, assinatura, envio (API) ----------
  let opBase = '';
  await passo('OP (rascunho): total = soma dos itens − desconto, com centavos; engenheiro vê o próprio rascunho, outros não', async () => {
    opBase = await rascunho(eng, { desconto: 5.25, favorecido: marca('Carlos-OP') });
    const itens = await um(admin.from('ordem_itens').select('total').eq('ordem_id', opBase));
    const soma = itens.reduce((s, i) => s + Number(i.total), 0);
    confere(Math.abs(soma - SUBTOTAL) < 0.005, `subtotal ${soma} ≠ ${SUBTOTAL}`);
    const op = await opDoBanco(opBase);
    confere(op.status === 'em_elaboracao' && Number(op.desconto) === 5.25 && op.solicitante_id === euId, 'rascunho inesperado');
    confere((await um(eng.from('ordens_pagamento').select('id').eq('id', opBase))).length === 1, 'o dono não vê o próprio rascunho');
    for (const [nome, c] of [['financeiro', fin], ['suprimentos', sup], ['administrador', adm]]) {
      confere((await um(c.from('ordens_pagamento').select('id').eq('id', opBase))).length === 0, `${nome} vê o rascunho do engenheiro`);
    }
  });

  await passo('OP (valores): desconto negativo, maior que o subtotal, quantidade 0, item sem descrição e sem itens são recusados', async () => {
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: obra.id, p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: -1, p_numero_nf: '' }), /desconto/i, 'desconto negativo');
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: obra.id, p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: SUBTOTAL + 0.01, p_numero_nf: '' }), /desconto/i, 'desconto > subtotal');
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: obra.id, p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: [], p_desconto: 0, p_numero_nf: '' }), /item/i, 'sem itens');
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: obra.id, p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: [{ descricao: 'Item zero', unidade: 'UN', quantidade: 0, valor_unitario: 10 }], p_desconto: 0, p_numero_nf: '' }), null, 'quantidade 0');
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: obra.id, p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: [{ descricao: '  ', unidade: 'UN', quantidade: 1, valor_unitario: 10 }], p_desconto: 0, p_numero_nf: '' }), null, 'item sem descrição');
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: obra.id, p_favorecido: marca('X'), p_cpf_cnpj: '12345', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: 0, p_numero_nf: '' }), /CPF|CNPJ/, 'CPF/CNPJ com tamanho errado');
  });

  await passo('OP (obra de outro vínculo): salvar_op e rascunho em obra alheia são recusados', async () => {
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: outras[0].id, p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: 0, p_numero_nf: '' }), /vinculado/, 'OP em obra alheia');
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: randomUUID(), p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: 0, p_numero_nf: '' }), null, 'obra inexistente');
  });

  await passo('OP (enviar sem assinar): recusado "Assine a OP antes de enviar"; sem vencimento recusado; total zero recusado', async () => {
    await falha(enviarRpc(eng, opBase), /Assine a OP/, 'envio sem assinatura');
    const semVenc = await rascunho(eng, { venc: null });
    await falha(enviarRpc(eng, semVenc), /vencimento/i, 'sem vencimento');
    const zerada = await rascunho(eng, { desconto: SUBTOTAL, itens: ITENS });
    await falha(enviarRpc(eng, zerada), /maior que zero/, 'total zero');
    confere((await opDoBanco(opBase)).status === 'em_elaboracao', 'a OP saiu de rascunho sem assinatura');
  });

  await passo('OP (assinatura invalida ao alterar): alterar item, desconto, vencimento ou parcelas depois de assinar exige assinar de novo', async () => {
    const id = await rascunho(eng);
    await um(assinarCriador(eng, id));
    const hash0 = (await opDoBanco(id)).assinatura_criador_hash;
    confere(hash0, 'hash da assinatura não gravado');
    const alteracoes = [
      ['item', { itens: [...ITENS, { descricao: 'Brita 1', unidade: 'm³', quantidade: 1, valor_unitario: 90 }] }],
      ['desconto', { desconto: 1 }],
      ['vencimento', { venc: somarDias(hoje, 20) }],
    ];
    for (const [nome, o] of alteracoes) {
      await rascunho(eng, { id, semDados: true, ...o });
      await falha(enviarRpc(eng, id), /alterada depois da sua assinatura/, `alterou ${nome}`);
      await um(assinarCriador(eng, id)); // reassina o novo conteúdo
      confere((await opDoBanco(id)).assinatura_criador_hash !== null, 'reassinatura não gravou o hash');
    }
    // parcelas
    await um(eng.rpc('definir_parcelas_op', { p_id: id, p_parcelas: [{ vencimento: somarDias(hoje, 20), valor: 300 }, { vencimento: somarDias(hoje, 50), valor: Math.round((SUBTOTAL - 300) * 100) / 100 }] }));
    await falha(enviarRpc(eng, id), /alterada depois da sua assinatura/, 'alterou parcelas');
    await um(eng.rpc('excluir_op', { p_id: id }));
  });

  await passo('OP (parcelas): soma diferente do total é recusada; soma igual passa; vencimentos viram parcelas do pagamento', async () => {
    const id = await rascunho(eng, { itens: [{ descricao: 'Serviço parcelado', unidade: 'UN', quantidade: 1, valor_unitario: 1000 }] });
    const v1 = somarDias(hoje, 15), v2 = somarDias(hoje, 45), v3 = somarDias(hoje, 75);
    await falha(eng.rpc('definir_parcelas_op', { p_id: id, p_parcelas: [{ vencimento: v1, valor: 500 }, { vencimento: v2, valor: 400 }] }), /soma|total/i, 'soma menor que o total');
    await falha(eng.rpc('definir_parcelas_op', { p_id: id, p_parcelas: [{ vencimento: v1, valor: 600 }, { vencimento: v2, valor: 600 }] }), /soma|total/i, 'soma maior que o total');
    await um(eng.rpc('definir_parcelas_op', { p_id: id, p_parcelas: [{ vencimento: v1, valor: 333.34 }, { vencimento: v2, valor: 333.33 }, { vencimento: v3, valor: 333.33 }] }));
    const pagId = await enviarCompleto(eng, id);
    const parcelas = await um(admin.from('pagamento_parcelas').select('numero, valor_base, vencimento').eq('pagamento_id', pagId).order('numero'));
    confere(parcelas.length === 3, `parcelas do pagamento: ${parcelas.length}`);
    confere(parcelas.map((x) => x.vencimento).join() === [v1, v2, v3].join(), 'vencimentos diferentes');
    confere(Math.abs(parcelas.reduce((s, x) => s + Number(x.valor_base), 0) - 1000) < 0.005, 'a soma das parcelas não bate com o total');
  });

  let pagOP = '', numeroOP = '';
  await passo('OP (envio completo): pagamento nasce no fluxo A, valor = itens − desconto, PDF oficial e assinatura do engenheiro, vai ao administrador', async () => {
    pagOP = await enviarCompleto(eng, opBase);
    const pg = await pagDoBanco(pagOP);
    const op = await opDoBanco(opBase);
    numeroOP = op.numero;
    confere(op.status === 'enviada' && /^OP-\d{4}-\d{5}$/.test(op.numero), `OP: ${op.status} ${op.numero}`);
    confere(pg.fluxo === 'A' && pg.status === 'aguardando_administrador', `pagamento: ${pg.fluxo} ${pg.status}`);
    confere(Math.abs(Number(pg.valor) - (SUBTOTAL - 5.25)) < 0.005, `valor ${pg.valor} ≠ ${SUBTOTAL - 5.25}`);
    confere(pg.ordem_id === opBase && pg.created_by === euId, 'vínculo OP↔pagamento');
    const docs = await um(admin.from('documentos').select('tipo, ativo').eq('pagamento_id', pagOP));
    confere(docs.some((d) => d.tipo === 'ordem_pagamento') && docs.some((d) => d.tipo === 'documento_assinado'), `documentos: ${docs.map((d) => d.tipo)}`);
    const ass = await um(admin.from('assinaturas').select('etapa, decisao, user_id, hash_integridade').eq('pagamento_id', pagOP));
    confere(ass.length === 1 && ass[0].etapa === 'engenheiro' && ass[0].user_id === euId && /^[0-9a-f]{64}$/.test(ass[0].hash_integridade), 'assinatura do engenheiro');
    const criou = await um(admin.from('auditoria').select('descricao').eq('pagamento_id', pagOP).eq('acao', 'criou'));
    confere(criou.length === 1 && !/sem administrador/.test(criou[0].descricao), `a linha do tempo diz "${criou[0]?.descricao}" mas a obra tem administrador e a OP foi ao administrador`);
  });

  await passo('OP (repetição mensal): provisões nascem uma vez (vencimentos mensais), repetir a chamada não duplica; intervalo/vezes inválidos recusados', async () => {
    const id = await rascunho(eng, { favorecido: marca('Rep-OP'), venc: '2027-01-31' });
    await falha(eng.rpc('definir_repeticao_op', { p_ordem_id: id, p_intervalo: 13, p_vezes: 3 }), null, 'intervalo 13');
    await um(eng.rpc('definir_repeticao_op', { p_ordem_id: id, p_intervalo: 1, p_vezes: 3 }));
    const pag = await enviarCompleto(eng, id);
    await falha(eng.rpc('criar_repeticoes', { p_pagamento_id: pag, p_intervalo: 1, p_vezes: 1 }), /Repetição inválida/, 'uma vez só');
    const n = await um(eng.rpc('criar_repeticoes', { p_pagamento_id: pag, p_intervalo: 1, p_vezes: 3 }));
    confere(n === 2, `criou ${n} provisões (esperado 2)`);
    confere((await um(eng.rpc('criar_repeticoes', { p_pagamento_id: pag, p_intervalo: 1, p_vezes: 3 }))) === 0, 'a segunda chamada duplicou as provisões');
    const pr = await um(admin.from('provisoes').select('vencimento, valor_estimado').eq('pagamento_origem_id', pag).order('vencimento'));
    confere(pr.length === 2 && pr[0].vencimento === '2027-02-28' && pr[1].vencimento === '2027-03-31', `vencimentos: ${pr.map((x) => x.vencimento)}`);
    await falha(fin.rpc('criar_repeticoes', { p_pagamento_id: pag, p_intervalo: 1, p_vezes: 3 }), /não encontrado/, 'repetir OP de outra pessoa');
  });

  await passo('OP (repetição): enviar de novo, editar, assinar, anexar, excluir e remover anexo depois do envio são recusados', async () => {
    await falha(enviarRpc(eng, opBase), /já foi enviada/, 'reenviar');
    await falha(eng.rpc('salvar_op', { p_id: opBase, p_obra_id: obra.id, p_favorecido: 'Alterado', p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: 0, p_numero_nf: '' }), /já foi enviada/, 'editar');
    await falha(eng.rpc('registrar_assinatura_criador', { p_ordem_id: opBase, p_pos: { fx: 0.1, fy: 0.1, fw: 0.2 } }), /já foi enviada/, 'assinar de novo');
    await falha(eng.rpc('excluir_op', { p_id: opBase }), /rascunhos/, 'excluir enviada');
    await falha(eng.rpc('definir_parcelas_op', { p_id: opBase, p_parcelas: [] }), null, 'mudar parcelas de OP enviada');
    const op = await opDoBanco(opBase);
    confere(op.status === 'enviada' && op.numero === numeroOP, 'a OP mudou');
    confere((await um(admin.from('pagamentos').select('id').eq('ordem_id', opBase))).length === 1, 'gerou mais de um pagamento');
  });

  await passo('OP (clique duplo): dois envios simultâneos geram um só pagamento', async () => {
    const id = await rascunho(eng);
    await um(assinarCriador(eng, id));
    const [r1, r2] = await Promise.all([enviarRpc(eng, id), enviarRpc(eng, id)]);
    confere([r1, r2].filter((r) => !r.error).length === 1, `esperava 1 sucesso e 1 recusa: ${JSON.stringify([r1.error?.message, r2.error?.message])}`);
    confere((await um(admin.from('pagamentos').select('id').eq('ordem_id', id))).length === 1, 'duplicou o pagamento');
  });

  await passo('OP (permissão cruzada): Carlos não mexe no rascunho do Financeiro; Financeiro não assina como engenheiro', async () => {
    const daFin = await rascunho(fin, { favorecido: marca('Rasc-fin') });
    confere((await um(eng.from('ordens_pagamento').select('id').eq('id', daFin))).length === 0, 'engenheiro enxerga rascunho do Financeiro');
    await falha(eng.rpc('salvar_op', { p_id: daFin, p_obra_id: obra.id, p_favorecido: 'Invasor', p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: 0, p_numero_nf: '' }), /não encontrada/, 'salvar rascunho alheio');
    await falha(enviarRpc(eng, daFin), /não encontrada/, 'enviar rascunho alheio');
    await falha(eng.rpc('excluir_op', { p_id: daFin }), /rascunhos/, 'excluir rascunho alheio');
    await falha(eng.rpc('registrar_assinatura_criador', { p_ordem_id: daFin, p_pos: { fx: 0.1, fy: 0.1, fw: 0.2 } }), /não encontrada/, 'assinar rascunho alheio');
    await falha(fin.rpc('registrar_assinatura_criador', { p_ordem_id: daFin, p_pos: { fx: 0.1, fy: 0.1, fw: 0.2 } }), /engenheiro/i, 'Financeiro assinando como engenheiro');
    confere((await opDoBanco(daFin)).favorecido.startsWith('Rasc-fin'), 'o rascunho do Financeiro foi alterado');
  });

  // ---------- OP pela tela ----------
  const nomeUI = marca('Tela-OP');
  let opUI = '';
  await passo('OP pela tela: categoria e conta faltando barram no navegador (sem criar rascunho); PIX sem banco/chave mostra mensagem clara', async () => {
    await ir(p, '/pagamentos/novo');
    const formas = await p.locator('select[aria-label="Forma de pagamento"] option').allInnerTexts();
    confere(!formas.includes('Boleto') && formas.includes('PIX'), `formas oferecidas ao engenheiro: ${formas}`);
    await p.selectOption('select[name=obra_id]', obra.id);
    await p.fill('input[name=vencimento]', somarDias(hoje, 9));
    await p.fill('input[name=favorecido]', nomeUI);
    await p.fill('input[name=descricao]', `Compra de cimento ${nomeUI}`);
    await p.getByLabel('Descrição do item 1').fill('Cimento CP-II');
    await p.getByLabel('Valor unitário do item 1').fill('35,50');
    await p.getByLabel('Quantidade do item 1').fill('10');
    // o formulário lembra a última conta usada: limpa para testar o campo obrigatório
    await p.locator('select[name=conta_bancaria_id]').selectOption('');
    await p.getByRole('button', { name: 'Salvar e enviar' }).click();
    await p.waitForTimeout(800);
    const invalidos = await p.evaluate(() => [...document.querySelectorAll(':invalid')].length);
    confere(invalidos > 0, `sem categoria/conta o formulário foi enviado: url=${p.url()} conta=${await p.locator('select[name=conta_bancaria_id]').inputValue()} texto=${(await p.locator('main').innerText()).replace(/\s+/g,' ').slice(0,300)}`);
    confere((await um(admin.from('ordens_pagamento').select('id').eq('favorecido', nomeUI))).length === 0, 'criou rascunho com campos obrigatórios faltando');
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await p.locator('select[name=conta_bancaria_id]').selectOption(conta);
    await p.getByRole('button', { name: 'Salvar e enviar' }).click();
    await p.getByText(/informe o banco e a chave PIX/).waitFor({ timeout: 15000 });
    await p.fill('input[name=banco]', 'Banco Teste');
    await p.getByRole('button', { name: 'Salvar e enviar' }).click();
    await p.getByText(/informe o banco e a chave PIX/).waitFor({ timeout: 15000 });
    await p.fill('input[name=chave_pix]', 'carlos@exemplo.com');
    confere((await um(admin.from('ordens_pagamento').select('id').eq('favorecido', nomeUI))).length === 0, 'criou rascunho antes dos dados de pagamento');
  });

  await passo('OP pela tela: desconto maior que o total é barrado e o total da tela acompanha itens − desconto', async () => {
    await p.getByLabel('Desconto').fill('9999,00');
    await p.getByText(/O desconto deve estar entre zero e o total dos itens/).waitFor({ timeout: 5000 });
    await p.getByLabel('Desconto').fill('5,00');
    const total = await p.locator('tfoot tr', { hasText: 'Total da OP' }).innerText();
    confere(/350,00/.test(total), `total na tela: ${total}`); // 10 × 35,50 − 5,00
    await p.getByLabel('Desconto').fill('');
  });

  await passo('OP pela tela: "Salvar e enviar" sem assinar mostra "Assine a OP antes de enviar" e não cria pagamento', async () => {
    await p.getByRole('button', { name: 'Salvar rascunho para anexar' }).click();
    await p.getByRole('button', { name: 'Assinar OP' }).waitFor({ timeout: 20000 });
    await p.getByRole('button', { name: 'Salvar e enviar' }).click();
    await p.getByText(/Assine a OP antes de enviar/).waitFor({ timeout: 20000 });
    const ops = await um(admin.from('ordens_pagamento').select('id, status').eq('favorecido', nomeUI));
    confere(ops.length === 1 && ops[0].status === 'em_elaboracao', `OPs: ${JSON.stringify(ops)}`);
    opUI = ops[0].id;
    confere((await um(admin.from('pagamentos').select('id').eq('ordem_id', opUI))).length === 0, 'criou pagamento sem assinatura');
  });

  await passo('OP pela tela: Carlos assina a OP (janela), anexa um arquivo e assina o anexo (janela)', async () => {
    await p.getByRole('button', { name: 'Assinar OP' }).click();
    await p.getByAltText('Última página da OP').waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: 'Confirmar assinatura' }).click();
    await p.getByText(/OP assinada por você/).waitFor({ timeout: 30000 });
    confere((await opDoBanco(opUI)).assinatura_criador_hash, 'assinatura do criador não gravada');
    await p.locator('label:has-text("Anexar comprovante") input[type=file]').setInputFiles(pdfUI);
    await p.getByText('Posicione sua assinatura').waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: 'Confirmar assinatura' }).click();
    await p.getByText(/Arquivo assinado e anexado/).waitFor({ timeout: 60000 });
    const an = await um(admin.from('ordem_anexos').select('assinado').eq('ordem_id', opUI));
    confere(an.length === 1 && an[0].assinado === true, 'anexo não ficou assinado');
  });

  await passo('OP pela tela: anexar tipo inválido (.txt) é recusado; remover o anexo funciona; anexar de novo', async () => {
    const txt = path.join(DIR, 'engenheiro-invalido.txt');
    fs.writeFileSync(txt, 'não é pdf');
    await p.locator('label:has-text("Anexar comprovante") input[type=file]').setInputFiles(txt);
    await p.getByText(/Envie um PDF, PNG ou JPG/).waitFor({ timeout: 10000 });
    await p.getByRole('button', { name: 'Remover', exact: true }).click(); // confirma pelo diálogo nativo
    await p.getByText(/Anexo removido/).waitFor({ timeout: 20000 });
    confere((await um(admin.from('ordem_anexos').select('id').eq('ordem_id', opUI))).length === 0, 'anexo não foi removido');
    await p.locator('label:has-text("Anexar comprovante") input[type=file]').setInputFiles(pdfUI);
    await p.getByText('Posicione sua assinatura').waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: 'Confirmar assinatura' }).click();
    await p.getByText(/Arquivo assinado e anexado/).waitFor({ timeout: 60000 });
  });

  let pagUI = '';
  await passo('OP pela tela: alterar depois de assinar invalida; reassina; "Salvar e enviar" gera pagamento com PDF assinado, anexo como comprovante', async () => {
    await p.getByLabel('Desconto').fill('10,00');
    await p.getByRole('button', { name: 'Salvar e enviar' }).click();
    await p.getByText(/alterada depois da sua assinatura/).waitFor({ timeout: 30000 });
    await p.goto(BASE + `/ops/${opUI}/editar`); await p.waitForLoadState('networkidle');
    await p.getByText(/foi alterada depois da sua assinatura/).first().waitFor({ timeout: 15000 });
    await p.getByRole('button', { name: 'Assinar OP' }).click();
    await p.getByAltText('Última página da OP').waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: 'Confirmar assinatura' }).click();
    await p.getByText(/OP assinada por você/).waitFor({ timeout: 30000 });
    await Promise.all([p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 120000 }), p.getByRole('button', { name: 'Salvar e enviar' }).click()]);
    pagUI = p.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const pg = await pagDoBanco(pagUI);
    confere(pg.status === 'aguardando_administrador' && Math.abs(Number(pg.valor) - 345) < 0.005, `pagamento: ${pg.status} ${pg.valor}`); // 355 − 10
    const docs = await um(admin.from('documentos').select('tipo').eq('pagamento_id', pagUI));
    confere(docs.some((d) => d.tipo === 'ordem_pagamento') && docs.some((d) => d.tipo === 'documento_assinado') && docs.some((d) => d.tipo === 'comprovante'), `documentos: ${docs.map((d) => d.tipo)}`);
  });

  await passo('OP pela tela: rascunho enviado por engano com erro não deixa rascunhos duplicados ao corrigir e reenviar', async () => {
    const nome = marca('Dup-OP');
    await ir(p, '/pagamentos/novo');
    await p.selectOption('select[name=obra_id]', obra.id);
    await p.fill('input[name=favorecido]', nome);
    await p.fill('input[name=descricao]', `Desp ${nome}`);
    await p.fill('input[name=banco]', 'Banco Teste'); await p.fill('input[name=chave_pix]', 'x@y.z');
    await p.getByLabel('Descrição do item 1').fill('Item'); await p.getByLabel('Valor unitário do item 1').fill('10,00');
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await p.locator('select[name=conta_bancaria_id]').selectOption(conta);
    // sem vencimento: o servidor grava o rascunho e recusa o envio
    await p.getByRole('button', { name: 'Salvar e enviar' }).click();
    await p.getByText(/vencimento/i).first().waitFor({ timeout: 20000 });
    await p.fill('input[name=vencimento]', somarDias(hoje, 7));
    await p.getByRole('button', { name: 'Salvar e enviar' }).click();
    await p.getByText(/Assine a OP antes de enviar/).waitFor({ timeout: 20000 });
    const n = (await um(admin.from('ordens_pagamento').select('id').eq('favorecido', nome))).length;
    confere(n === 1, `${n} rascunhos criados para a mesma solicitação (esperado 1)`);
  });

  await passo('OP pela tela: rascunho aparece em "Contas a pagar" como aviso, abre, e "Excluir rascunho" remove', async () => {
    const id = await rascunho(eng, { favorecido: marca('Excluir-OP') });
    await ir(p, `/ops/${id}`);
    await p.getByText('Solicitação (rascunho)').first().waitFor();
    await Promise.all([p.waitForURL(/\/pagamentos\?excluida=1/), p.getByRole('button', { name: 'Excluir rascunho' }).click()]);
    confere((await admin.from('ordens_pagamento').select('id').eq('id', id)).data.length === 0, 'rascunho continua no banco');
  });

  await passo('OP pela tela: transferência exige banco, agência e conta; dinheiro não pede dados bancários', async () => {
    await ir(p, '/pagamentos/novo');
    await p.selectOption('select[aria-label="Forma de pagamento"]', 'transferencia');
    await p.selectOption('select[name=obra_id]', obra.id);
    await p.fill('input[name=vencimento]', somarDias(hoje, 9));
    await p.fill('input[name=favorecido]', marca('Transf'));
    await p.fill('input[name=descricao]', 'Pagamento por transferência');
    await p.getByLabel('Descrição do item 1').fill('Serviço'); await p.getByLabel('Valor unitário do item 1').fill('50,00');
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await p.locator('select[name=conta_bancaria_id]').selectOption(conta);
    await p.fill('input[name=banco]', 'Banco Teste'); await p.fill('input[name=conta]', '1234-5');
    await p.getByRole('button', { name: 'Salvar e enviar' }).click();
    await p.getByText(/informe banco, agência e conta/).waitFor({ timeout: 15000 });
    await p.selectOption('select[aria-label="Forma de pagamento"]', 'dinheiro');
    await p.getByText(/não precisa de dados bancários/).waitFor({ timeout: 5000 });
    confere(!(await p.locator('input[name=banco]').count()), 'dinheiro pede banco');
  });

  await passo('OP pela tela: CPF/CNPJ inválido é recusado; com máscara grava só dígitos; 3 parcelas mensais (31/01→28/02→31/03); soma errada avisa e é recusada; "Dividir igualmente" corrige', async () => {
    const nome = marca('Parc-OP');
    await ir(p, '/pagamentos/novo');
    await p.selectOption('select[name=obra_id]', obra.id);
    await p.fill('input[name=vencimento]', '2027-01-31');
    await p.fill('input[name=favorecido]', nome);
    await p.fill('input[name=descricao]', `Parcelado ${nome}`);
    await p.fill('input[name=cpf_cnpj]', '123');
    await p.fill('input[name=banco]', 'Banco Teste'); await p.fill('input[name=chave_pix]', 'p@x.com');
    await p.getByLabel('Descrição do item 1').fill('Serviço parcelado'); await p.getByLabel('Valor unitário do item 1').fill('1000,00');
    await p.click('button[aria-label="Categoria"]'); await p.locator('[role=option]').first().click();
    await p.locator('select[name=conta_bancaria_id]').selectOption(conta);
    await p.fill('input[name=parcelas]', '3');
    const datas = [await p.getByLabel('Vencimento da parcela 2').inputValue(), await p.getByLabel('Vencimento da parcela 3').inputValue()];
    confere(datas.join() === '2027-02-28,2027-03-31', `vencimentos sugeridos: ${datas}`);
    const valores = [1, 2, 3].map((n) => p.getByLabel(`Valor da parcela ${n}`).inputValue());
    confere((await Promise.all(valores)).join() === '333,33,333,33,333,34', `valores: ${await Promise.all(valores)}`);
    const rasc = () => p.getByRole('button', { name: 'Salvar rascunho', exact: true });
    await rasc().click();
    await p.getByText(/CPF deve ter 11 dígitos e CNPJ 14 dígitos/).waitFor({ timeout: 15000 });
    confere((await um(admin.from('ordens_pagamento').select('id').eq('favorecido', nome))).length === 0, 'criou OP com CPF/CNPJ inválido');
    await p.fill('input[name=cpf_cnpj]', '11.222.333/0001-81');
    await p.getByLabel('Valor da parcela 2').fill('400,00');
    await p.getByText(/A soma das parcelas precisa ser igual ao total da OP/).waitFor({ timeout: 5000 });
    await rasc().click();
    await p.getByText(/soma das parcelas/i).first().waitFor({ timeout: 15000 });
    await p.getByRole('button', { name: 'Dividir igualmente' }).click();
    confere(await p.getByLabel('Valor da parcela 2').inputValue() === '333,33', 'Dividir igualmente não refez os valores');
    await Promise.all([p.waitForURL(/\/ops\/[0-9a-f-]{36}\/editar/, { timeout: 30000 }), rasc().click()]);
    const idOP = p.url().match(/ops\/([0-9a-f-]{36})\/editar/)[1];
    const op = await opDoBanco(idOP);
    confere(op.cpf_cnpj === '11222333000181' && op.status === 'em_elaboracao', `CPF/CNPJ gravado: ${op.cpf_cnpj}`);
    const parc = await um(admin.from('ordem_parcelas').select('numero, valor, vencimento').eq('ordem_id', idOP).order('numero'));
    confere(parc.map((x) => x.vencimento).join() === '2027-01-31,2027-02-28,2027-03-31' && Math.abs(parc.reduce((t, x) => t + Number(x.valor), 0) - 1000) < 0.005, `parcelas: ${JSON.stringify(parc)}`);
    confere(await p.locator('input[name=parcelas]').inputValue() === '3' && await p.getByLabel('Valor da parcela 3').inputValue() === '333,34', 'a edição não trouxe as parcelas de volta');
    await ir(p, `/ops/${idOP}`);
    confere((await p.locator('main').innerText()).includes('11.222.333/0001-81'), 'o CNPJ não aparece formatado na OP');
    await um(eng.rpc('excluir_op', { p_id: idOP }));
  });

  await passo('OP pela tela: /ops/[id] de OP enviada mostra etapas, valor e não oferece editar/excluir', async () => {
    await ir(p, `/ops/${opBase}`);
    const txt = await p.locator('main').innerText();
    confere(txt.includes(numeroOP) && /Enviada|Em análise/.test(txt), 'sem número/etapa');
    confere(txt.includes(brl(SUBTOTAL - 5.25).replace(/ /g, ' ')) || txt.includes('649,99') || txt.includes('650,00'), `valor total não aparece: ${txt.slice(0, 300)}`);
    confere(!(await p.getByRole('button', { name: 'Excluir rascunho' }).count()) && !(await p.getByRole('link', { name: 'Editar rascunho' }).count()), 'oferece editar/excluir OP enviada');
    await ir(p, `/ops/${opBase}/editar`);
    confere(new URL(p.url()).pathname === `/ops/${opBase}`, 'abriu a edição de OP já enviada');
  });

  await passo('OP pela tela: /ops/[id] de rascunho do Financeiro e de outra obra dá "não encontrada" (404), não vaza', async () => {
    const daFin = await rascunho(fin, { favorecido: marca('Rasc-fin2') });
    const r = await p.goto(BASE + `/ops/${daFin}`);
    confere(r.status() === 404, `status ${r.status()}`);
    const r2 = await p.goto(BASE + `/ops/${randomUUID()}/editar`);
    confere(r2.status() === 404, `status ${r2.status()}`);
    const pdf = await p.request.get(BASE + `/ops/${daFin}/pdf`);
    confere(pdf.status() >= 400, `PDF do rascunho alheio saiu com status ${pdf.status()}`);
  });

  // ---------- aprovação: o admin recusa ou aprova a OP do engenheiro ----------
  await passo('OP rejeitada: Carlos vê o motivo na OP, duplica e recebe rascunho novo com o histórico preservado', async () => {
    const id = await rascunho(eng, { favorecido: marca('Rejeitada'), desconto: 1.5 });
    const pagId = await enviarCompleto(eng, id);
    const pg = await pagDoBanco(pagId);
    await assinarDoc(adm, pagId);
    await falha(decidir(adm, pagId, pg.versao, 'rejeitado', ''), /motivo/i, 'rejeitar sem motivo');
    await um(decidir(adm, pagId, pg.versao, 'rejeitado', 'NF divergente do orçamento'));
    confere((await pagDoBanco(pagId)).status === 'rejeitado', 'pagamento não ficou rejeitado');
    confere((await opDoBanco(id)).status === 'rejeitada', `OP: ${(await opDoBanco(id)).status}`);
    await ir(p, `/ops/${id}`);
    await p.getByText(/Motivo: NF divergente do orçamento/).waitFor({ timeout: 15000 });
    await p.getByRole('button', { name: 'Criar nova solicitação a partir desta' }).click();
    await p.waitForURL(/\/ops\/[0-9a-f-]{36}\/editar/, { timeout: 30000 });
    const novaId = p.url().match(/ops\/([0-9a-f-]{36})\/editar/)[1];
    confere(novaId !== id, 'a cópia reaproveitou o id');
    const nova = await opDoBanco(novaId), velha = await opDoBanco(id);
    confere(nova.status === 'em_elaboracao' && nova.numero === null && nova.favorecido === velha.favorecido && Number(nova.desconto) === 1.5, 'cópia diferente do original');
    confere(velha.status === 'rejeitada' && velha.numero, 'o original foi alterado');
    confere((await pagDoBanco(pagId)).status === 'rejeitado', 'pagamento original mudou');
    const itens = await um(admin.from('ordem_itens').select('descricao').eq('ordem_id', novaId));
    confere(itens.length === ITENS.length, 'itens não foram copiados');
    // a cópia exige nova assinatura (não herda a assinatura da rejeitada)
    confere(!nova.assinatura_criador_hash, 'a cópia herdou a assinatura antiga');
    await falha(enviarRpc(eng, novaId), /Assine a OP/, 'enviar a cópia sem assinar');
  });

  let pagAprovado = '';
  await passo('OP aprovada e paga: administrador aprova, Financeiro baixa, e Carlos acompanha (OP "paga"); engenheiro não consegue dar baixa', async () => {
    const id = await rascunho(eng, { favorecido: marca('Aprovada') });
    pagAprovado = await enviarCompleto(eng, id);
    let pg = await pagDoBanco(pagAprovado);
    await assinarDoc(adm, pagAprovado);
    await um(decidir(adm, pagAprovado, pg.versao, 'aprovado'));
    pg = await pagDoBanco(pagAprovado);
    confere(pg.status === 'aguardando_pagamento', `status ${pg.status}`);
    await falha(eng.rpc('registrar_baixa', { p_id: pagAprovado, p_pago_em: hoje }), /Financeiro|Administrador master/, 'engenheiro dando baixa');
    confere((await pagDoBanco(pagAprovado)).status === 'aguardando_pagamento', 'o engenheiro conseguiu dar baixa');
    await um(fin.rpc('registrar_baixa', { p_id: pagAprovado, p_pago_em: hoje }));
    confere((await opDoBanco(id)).status === 'paga', `OP: ${(await opDoBanco(id)).status}`);
    await ir(p, `/ops/${id}`);
    await p.getByText(/Paga em/).waitFor({ timeout: 15000 });
    await ir(p, `/pagamentos/${pagAprovado}`);
    confere(!(await p.getByRole('button', { name: /Confirmar pagamento|Registrar pagamento/ }).count()), 'tela do pagamento oferece baixa ao engenheiro');
  });

  // ---------- aprovações: etapa do engenheiro em despesas de outros perfis ----------
  const rotulo1 = marca('Aprov-A');
  let pagA = '';
  await passo('Aprovação: despesa do Financeiro aparece em "Aprovações e assinaturas"; aprovar sem assinar o documento é recusado', async () => {
    pagA = await despesaParaEngenheiro(rotulo1);
    const pg = await pagDoBanco(pagA);
    confere(pg.status === 'aguardando_engenheiro' && pg.fluxo === 'A', `status ${pg.status}`);
    await ir(p, '/aprovacoes');
    confere(await p.locator('tr', { hasText: rotulo1 }).count() === 1, 'a despesa não aparece nas aprovações');
    await falha(decidir(eng, pagA, pg.versao, 'aprovado'), /Posicione sua assinatura/, 'aprovar sem assinar o documento');
    confere((await pagDoBanco(pagA)).status === 'aguardando_engenheiro', 'status mudou sem assinatura');
  });

  await passo('Aprovação: pela tela, sem "conferi" ou com senha errada é recusado; com tudo certo assina e encaminha ao administrador', async () => {
    await assinarDoc(eng, pagA); // posicionar a assinatura no documento
    await ir(p, '/aprovacoes');
    const linha = p.locator('tr', { hasText: rotulo1 });
    await linha.locator('input[type=checkbox]').check();
    await p.getByRole('button', { name: 'Revisar e assinar selecionados' }).click();
    const assinarBtn = p.getByRole('button', { name: 'Assinar e aprovar' });
    await assinarBtn.waitFor({ timeout: 15000 });
    await p.fill('input[name=senha]', SENHA);
    await assinarBtn.click(); // sem "conferi" o navegador barra (campo obrigatório)
    await p.waitForTimeout(600);
    confere((await pagDoBanco(pagA)).status === 'aguardando_engenheiro', 'assinou sem confirmar a conferência');
    await p.check('input[name=conferi]');
    await p.fill('input[name=senha]', 'senha-errada');
    await assinarBtn.click();
    await p.getByText('Senha incorreta.').waitFor({ timeout: 15000 });
    confere((await pagDoBanco(pagA)).status === 'aguardando_engenheiro', 'assinou com senha errada');
    await p.fill('input[name=senha]', SENHA);
    await assinarBtn.click();
    await p.getByText(/Documento assinado e encaminhado/).waitFor({ timeout: 30000 });
    const pg = await pagDoBanco(pagA);
    confere(pg.status === 'aguardando_administrador', `status ${pg.status}`);
    const ass = await um(admin.from('assinaturas').select('etapa, user_id, pagamento_versao').eq('pagamento_id', pagA));
    confere(ass.length === 1 && ass[0].etapa === 'engenheiro' && ass[0].user_id === euId, 'assinatura registrada errada');
  });

  await passo('Aprovação (repetição e fora de ordem): assinar de novo, aprovar a etapa do administrador e rejeitar depois são recusados', async () => {
    const pg = await pagDoBanco(pagA);
    await falha(decidir(eng, pagA, pg.versao, 'aprovado'), /não está aguardando a sua assinatura/, 'assinar duas vezes');
    await falha(decidir(eng, pagA, pg.versao, 'rejeitado', 'tarde demais'), /não está aguardando a sua assinatura/, 'rejeitar fora da etapa dele');
    confere((await pagDoBanco(pagA)).status === 'aguardando_administrador', 'mudou o status');
  });

  await passo('Aprovação (rejeição pela tela): motivo é obrigatório; com motivo o pagamento fica rejeitado e o Financeiro vê o motivo', async () => {
    const r = marca('Aprov-R');
    const id = await despesaParaEngenheiro(r, 321.09);
    const pg = await pagDoBanco(id);
    await falha(decidir(eng, id, pg.versao, 'rejeitado', ''), /motivo/i, 'rejeitar sem motivo');
    await ir(p, '/aprovacoes');
    await p.locator('tr', { hasText: r }).locator('input[type=checkbox]').check();
    await p.getByRole('button', { name: 'Revisar e assinar selecionados' }).click();
    await p.getByRole('button', { name: 'Assinar e aprovar' }).waitFor();
    await p.getByLabel('Rejeitar').check();
    await p.fill('input[name=senha]', SENHA);
    await p.check('input[name=conferi]');
    await p.getByRole('button', { name: 'Rejeitar', exact: true }).click(); // motivo vazio: o navegador barra
    await p.waitForTimeout(600);
    confere((await pagDoBanco(id)).status === 'aguardando_engenheiro', 'rejeitou sem motivo');
    await p.locator('textarea[name=comentario]').fill('Quantidade acima do medido no canteiro');
    await p.getByRole('button', { name: 'Rejeitar', exact: true }).click();
    await p.getByText(/Documento rejeitado/).waitFor({ timeout: 20000 });
    confere((await pagDoBanco(id)).status === 'rejeitado', 'não ficou rejeitado');
    const ass = await um(admin.from('assinaturas').select('decisao, comentario').eq('pagamento_id', id));
    confere(ass.length === 1 && ass[0].decisao === 'rejeitado' && /Quantidade/.test(ass[0].comentario), 'assinatura de rejeição');
    confere((await um(fin.from('assinaturas').select('comentario').eq('pagamento_id', id))).length === 1, 'o Financeiro não vê o motivo');
  });

  await passo('Aprovação (versão e lote): versão desatualizada recusa; lote com um item inválido não assina nenhum (atômico)', async () => {
    const a = await despesaParaEngenheiro(marca('Lote-A')), c = await despesaParaEngenheiro(marca('Lote-C'));
    const pa = await pagDoBanco(a), pc = await pagDoBanco(c);
    await assinarDoc(eng, a); await assinarDoc(eng, c);
    await falha(decidir(eng, a, pa.versao + 3, 'aprovado'), /alterado depois que você o conferiu/, 'versão velha');
    await falha(eng.rpc('decidir_aprovacao', { p_itens: [{ id: a, versao: pa.versao }, { id: c, versao: pc.versao + 9 }], p_decisao: 'aprovado' }), /alterado/, 'lote com versão errada');
    confere((await pagDoBanco(a)).status === 'aguardando_engenheiro' && (await pagDoBanco(c)).status === 'aguardando_engenheiro', 'lote parcial: algum item foi assinado');
    const lote = await um(eng.rpc('decidir_aprovacao', { p_itens: [{ id: a, versao: pa.versao }, { id: c, versao: pc.versao }], p_decisao: 'aprovado' }));
    confere(lote, 'sem id do lote');
    confere((await pagDoBanco(a)).status === 'aguardando_administrador' && (await pagDoBanco(c)).status === 'aguardando_administrador', 'o lote não assinou os dois');
  });

  await passo('Aprovação (permissão cruzada): despesa de outra obra e etapa do administrador não podem ser assinadas por Carlos', async () => {
    const idOutra = await um(fin.rpc('criar_pagamento', { p_obra_id: outras[0].id, p_fornecedor_id: null, p_favorecido: marca('Alheio'), p_descricao: marca('Obra-alheia'), p_valor: 100, p_vencimento: somarDias(hoje, 8), p_forma_pagamento: 'boleto' }));
    await falha(decidir(eng, idOutra, 1, 'aprovado'), /não encontrado/, 'aprovar despesa de outra obra');
    confere((await um(eng.from('pagamentos').select('id').eq('id', idOutra))).length === 0, 'enxerga despesa de outra obra');
    const r = await p.goto(BASE + `/pagamentos/${idOutra}`);
    confere(r.status() === 404, `/pagamentos/[id] de outra obra: ${r.status()}`);
    const docs = await um(admin.from('documentos').select('id, storage_path').eq('pagamento_id', pagOP).limit(1));
    const r2 = await p.request.get(BASE + `/documentos/${docs[0].id}`); // da própria obra: abre
    confere(r2.status() < 400, `documento da própria obra: ${r2.status()}`);
    // documento de obra alheia
    const alheio = await um(admin.from('documentos').select('id, storage_path').in('obra_id', outras.map((o) => o.id)).limit(1));
    if (alheio.length) {
      const r3 = await p.request.get(BASE + `/documentos/${alheio[0].id}`, { maxRedirects: 0 });
      confere(r3.status() >= 400 || (r3.status() >= 300 && r3.status() < 400 && !/token|signed/i.test(r3.headers().location ?? '')), `documento de obra alheia abriu (${r3.status()})`);
      const dl = await eng.storage.from('documentos').download(alheio[0].storage_path);
      confere(dl.error, 'baixou arquivo de obra alheia direto do Storage');
    }
  });

  // ---------- fundo fixo ----------
  let fundoId = '';
  await passo('Fundo fixo: Financeiro cria o fundo do Carlos; Carlos vê só o dele e não consegue criar/fechar fundo', async () => {
    const abertoDele = () => um(admin.from('fundos_fixos').select('id, valor, status').eq('pessoa_id', euId).eq('obra_id', obra.id).neq('status', 'fechado'));
    let abertos = await abertoDele();
    if (abertos.length) {
      // começa de um fundo limpo: se o anterior já teve gasto ou não está "em andamento", o Financeiro fecha e (se esgotado) repõe
      const gastos = await um(admin.from('fundo_gastos').select('id').eq('fundo_id', abertos[0].id));
      if (gastos.length || abertos[0].status !== 'em_andamento') {
        await um(fin.rpc('fechar_fundo_fixo', { p_fundo_id: abertos[0].id, p_vencimento: hoje, p_modo: abertos[0].status === 'esgotado' ? 'repor' : 'encerrar', p_conta_id: conta }));
        abertos = await abertoDele();
      }
    }
    fundoId = abertos.length ? abertos[0].id : await um(fin.rpc('criar_fundo_fixo', { p_obra_id: obra.id, p_pessoa_id: euId, p_valor: 100, p_conta_id: conta }));
    confere((await um(eng.from('fundos_fixos').select('id').eq('id', fundoId))).length === 1, 'não vê o próprio fundo');
    await falha(eng.rpc('criar_fundo_fixo', { p_obra_id: obra.id, p_pessoa_id: euId, p_valor: 5000, p_conta_id: conta }), /Financeiro/, 'engenheiro criando fundo');
    await falha(eng.rpc('fechar_fundo_fixo', { p_fundo_id: fundoId, p_vencimento: hoje, p_modo: 'encerrar' }), /Financeiro/, 'engenheiro fechando fundo');
    await falha(fin.rpc('criar_fundo_fixo', { p_obra_id: obra.id, p_pessoa_id: euId, p_valor: 50, p_conta_id: conta }), null, 'dois fundos abertos para a mesma pessoa e obra');
  });

  let fundoSup = '';
  await passo('Fundo fixo (colega): Carlos não lança gasto, não troca dados bancários e não pede reposição no fundo do Suprimentos', async () => {
    const supId = (await sup.auth.getUser()).data.user.id;
    fundoSup = (await um(admin.from('fundos_fixos').select('id').eq('pessoa_id', supId).eq('obra_id', obra.id).neq('status', 'fechado')))[0]?.id;
    if (!fundoSup) fundoSup = await um(fin.rpc('criar_fundo_fixo', { p_obra_id: obra.id, p_pessoa_id: supId, p_valor: 80, p_conta_id: conta }));
    const ja = await um(admin.from('fundos_fixos').select('receb_informado_em').eq('id', fundoSup).single());
    if (!ja.receb_informado_em) await um(sup.rpc('informar_dados_bancarios_fundo', { p_fundo_id: fundoSup, p_forma: 'pix', p_banco: 'Banco do Colega', p_favorecido: 'Sérgio Teste', p_chave_pix: 'chave-do-colega@exemplo.com' }));
    await falha(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoSup, p_descricao: 'Invasão', p_data: hoje, p_valor: 10 }), /Somente a pessoa do fundo/, 'lançar no fundo alheio');
    await falha(eng.rpc('informar_dados_bancarios_fundo', { p_fundo_id: fundoSup, p_forma: 'pix', p_banco: 'Meu banco', p_favorecido: 'Carlos', p_chave_pix: 'minha@chave.com' }), /Somente a pessoa do fundo/, 'trocar os dados bancários do colega');
    await falha(eng.rpc('solicitar_fechamento_fundo', { p_fundo_id: fundoSup }), /Somente a pessoa do fundo/, 'solicitar fechamento do fundo do colega');
    const fz = await um(admin.from('fundos_fixos').select('receb_banco, receb_chave_pix').eq('id', fundoSup).single());
    confere(fz.receb_banco !== 'Meu banco' && fz.receb_chave_pix !== 'minha@chave.com', 'os dados bancários do colega foram trocados');
  });

  await passo('Fundo fixo (privacidade): chave PIX, agência e conta do fundo de um colega não saem pela API (README: dados bancários só para quem precisa)', async () => {
    const vistos = await um(eng.from('fundos_fixos').select('id, pessoa_id, receb_chave_pix, receb_conta, receb_agencia, receb_banco').neq('pessoa_id', euId));
    const vazou = vistos.filter((x) => x.receb_chave_pix || x.receb_conta || x.receb_agencia || x.receb_banco);
    confere(vazou.length === 0, `Carlos lê banco/agência/conta/PIX de ${vazou.length} fundo(s) de colega pela API (RLS fundos_select usa pode_ver_obra; ex.: ${vazou[0]?.receb_banco} / ${vazou[0]?.receb_chave_pix})`);
  });

  await passo('Fundo fixo (escopo): README diz "Fundo fixo: o seu" — Carlos só vê fundos, gastos e comprovantes dele, na API e na tela', async () => {
    const alheios = await um(eng.from('fundos_fixos').select('id').neq('pessoa_id', euId));
    confere(alheios.length === 0, `Carlos enxerga ${alheios.length} fundo(s) de colega pela API`);
    const gastosAlheios = await um(eng.from('fundo_gastos').select('id, fundo_id').in('fundo_id', [fundoSup]));
    confere(gastosAlheios.length === 0, 'Carlos enxerga gastos do fundo de colega');
    await ir(p, '/fundos-fixos');
    const links = await p.locator('main a[href^="/fundos-fixos/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
    confere(links.every((h) => h.endsWith(fundoId)) , `a lista mostra fundos de outras pessoas: ${links.join(' ')}`);
    const r = await p.goto(BASE + `/fundos-fixos/${fundoSup}`);
    confere(r.status() === 404, `/fundos-fixos/[id] do colega: ${r.status()}`);
  });

  await passo('Fundo fixo (tela): sem dados bancários não há formulário de gasto; gasto sem valor/descrição é recusado', async () => {
    const f = await um(admin.from('fundos_fixos').select('receb_informado_em').eq('id', fundoId).single());
    if (!f.receb_informado_em) {
      await falha(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: 'Sem dados', p_data: hoje, p_valor: 10 }), /dados bancários/, 'gasto sem dados bancários');
      await ir(p, `/fundos-fixos/${fundoId}`);
      await p.locator('[data-dados-bancarios-obrigatorio]').waitFor({ timeout: 15000 });
      confere(!(await p.getByRole('button', { name: 'Lançar gasto' }).count()), 'formulário de gasto antes dos dados bancários');
      await p.check('input[name=forma][value=conta]');
      for (const campo of ['favorecido', 'banco', 'agencia', 'conta']) await p.fill(`input[name=${campo}]`, ''); // vêm preenchidos do fundo anterior
      await p.getByRole('button', { name: 'Salvar dados bancários' }).click(); // campos obrigatórios vazios: o navegador barra
      await p.waitForTimeout(500);
      confere((await um(admin.from('fundos_fixos').select('receb_informado_em').eq('id', fundoId).single())).receb_informado_em === null, 'salvou dados bancários vazios');
      await p.fill('input[name=favorecido]', 'Eduardo Nunes da Silva');
      await p.fill('input[name=banco]', 'Banco Teste');
      await p.fill('input[name=agencia]', '1234');
      await p.fill('input[name=conta]', '56789-0');
      await p.getByRole('button', { name: 'Salvar dados bancários' }).click();
      await p.locator('[data-dados-recebimento]').waitFor({ timeout: 30000 });
    }
    await falha(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: 'Zero', p_data: hoje, p_valor: 0 }), /valor/i, 'gasto de valor zero');
    await falha(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: 'Negativo', p_data: hoje, p_valor: -5 }), /valor/i, 'gasto negativo');
    await falha(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: '  ', p_data: hoje, p_valor: 5 }), /descrição/i, 'gasto sem descrição');
  });

  let gasto1 = '';
  const descGasto = marca('Combustível');
  await passo('Fundo fixo (tela): Carlos lança gasto (pendente), anexa comprovante, assina (janela); gasto só vale com comprovante assinado', async () => {
    const f0 = await um(admin.from('fundos_fixos').select('valor').eq('id', fundoId).single());
    const dispo = Number(f0.valor) - (await um(admin.from('fundo_gastos').select('valor, status').eq('fundo_id', fundoId).in('status', ['aprovado', 'pendente']))).reduce((s, g) => s + Number(g.valor), 0);
    confere(dispo > 20, `fundo sem saldo para o teste (${dispo}); feche e reponha o fundo`);
    await ir(p, `/fundos-fixos/${fundoId}`);
    await p.fill('input[name=descricao]', descGasto);
    await p.fill('input[name=data_gasto]', hoje);
    await p.fill('input[name=valor]', '12,34');
    await p.getByRole('button', { name: 'Lançar gasto' }).click();
    await p.getByText(/Gasto lançado/).waitFor({ timeout: 30000 });
    const g = await um(admin.from('fundo_gastos').select('id, status, valor').eq('descricao', descGasto));
    confere(g.length === 1 && g[0].status === 'pendente' && Number(g[0].valor) === 12.34, `gasto: ${JSON.stringify(g)}`);
    gasto1 = g[0].id;
    await p.getByText(/Aguardando comprovante assinado/).first().waitFor();
    await falha(adm.rpc('decidir_gasto_fundo', { p_gasto_id: gasto1, p_aprovar: true }), /comprovante assinado/, 'aprovar sem comprovante assinado');
    const li = p.locator('li', { hasText: descGasto });
    await li.locator('input[type=file]').setInputFiles(pdfUI);
    await p.getByText('Posicione sua assinatura').waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: 'Confirmar assinatura' }).click();
    await p.getByText(/Comprovante assinado\. O original/).waitFor({ timeout: 120000 });
    const an = await um(admin.from('fundo_gasto_anexos').select('assinado').eq('gasto_id', gasto1));
    confere(an.some((a) => a.assinado), 'nenhum comprovante assinado');
  });

  await passo('Fundo fixo (aprovação): o próprio engenheiro não aprova o gasto; o administrador aprova e o gasto entra no saldo; decidir de novo é recusado', async () => {
    await falha(eng.rpc('decidir_gasto_fundo', { p_gasto_id: gasto1, p_aprovar: true }), /administrador da obra/, 'engenheiro aprovando o próprio gasto');
    await falha(adm.rpc('decidir_gasto_fundo', { p_gasto_id: gasto1, p_aprovar: false, p_motivo: '' }), /motivo/i, 'recusar sem motivo');
    await um(adm.rpc('decidir_gasto_fundo', { p_gasto_id: gasto1, p_aprovar: true }));
    confere((await um(admin.from('fundo_gastos').select('status').eq('id', gasto1).single())).status === 'aprovado', 'não aprovou');
    await falha(adm.rpc('decidir_gasto_fundo', { p_gasto_id: gasto1, p_aprovar: false, p_motivo: 'tarde' }), /já foi decidido/, 'decidir duas vezes');
    await ir(p, `/fundos-fixos/${fundoId}`);
    const txt = await p.locator('main').innerText();
    confere(/Aprovado/i.test(txt) && /Saldo/.test(txt), 'a tela não mostra o gasto aprovado e o saldo');
    // comprovante de gasto aprovado não pode mais ser removido
    const an = await um(admin.from('fundo_gasto_anexos').select('id').eq('gasto_id', gasto1));
    await falha(eng.rpc('remover_anexo_gasto', { p_anexo_id: an[0].id }), /ainda não foram decididos/, 'remover comprovante de gasto aprovado');
    await falha(eng.rpc('excluir_gasto_fundo', { p_gasto_id: gasto1 }), /Financeiro/, 'engenheiro excluindo gasto');
  });

  await passo('Fundo fixo (recusa e remoção): gasto recusado fica fora do saldo com o motivo; comprovante de gasto pendente pode ser removido', async () => {
    const g = await um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: marca('Recusado'), p_data: hoje, p_valor: 5 }));
    const bytes = await pdfBytes('comprovante x');
    const caminho = `fundos/${fundoId}/${randomUUID()}.pdf`;
    const up = await eng.storage.from('documentos').upload(caminho, bytes, { contentType: 'application/pdf' });
    confere(!up.error, 'upload do comprovante: ' + up.error?.message);
    const anexoId = await um(eng.rpc('registrar_anexo_gasto', { p_gasto_id: g, p_storage_path: caminho, p_nome: 'c.pdf', p_mime: 'application/pdf', p_sha256: sha(bytes), p_assinado: false }));
    await falha(adm.rpc('decidir_gasto_fundo', { p_gasto_id: g, p_aprovar: true }), /comprovante assinado/, 'aprovar com comprovante sem assinatura');
    await um(eng.rpc('remover_anexo_gasto', { p_anexo_id: anexoId }));
    confere((await um(admin.from('fundo_gasto_anexos').select('id').eq('gasto_id', g))).length === 0, 'comprovante não foi removido');
    await um(adm.rpc('decidir_gasto_fundo', { p_gasto_id: g, p_aprovar: false, p_motivo: 'Sem nota fiscal' }));
    const r = await um(admin.from('fundo_gastos').select('status, motivo_recusa').eq('id', g).single());
    confere(r.status === 'recusado' && r.motivo_recusa === 'Sem nota fiscal', 'recusa não gravada');
    await ir(p, `/fundos-fixos/${fundoId}`);
    await p.getByText(/Recusado: Sem nota fiscal/).waitFor({ timeout: 15000 });
  });

  await passo('Fundo fixo (sem limite): passa do valor e continua lançando; solicita o fechamento uma única vez e só o Financeiro fecha', async () => {
    const f = await um(admin.from('fundos_fixos').select('valor').eq('id', fundoId).single());
    const comp = (await um(admin.from('fundo_gastos').select('valor').eq('fundo_id', fundoId).in('status', ['aprovado', 'pendente']))).reduce((s, x) => s + Number(x.valor), 0);
    const resto = Math.round((Number(f.valor) - comp) * 100) / 100;
    await um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: marca('Passa-do-valor'), p_data: hoje, p_valor: resto + 20 }));
    // Depois de cobrir todo o valor, novos gastos continuam sendo aceitos (sem limite)
    await um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: marca('Depois-do-valor'), p_data: hoje, p_valor: 1 }));
    await ir(p, `/fundos-fixos/${fundoId}`);
    confere(await p.getByRole('button', { name: 'Lançar gasto' }).count() > 0, 'some o formulário de gasto depois de passar do valor');
    await p.getByRole('button', { name: 'Solicitar fechamento do fundo' }).click();
    await p.locator('[data-fechamento-solicitado]').waitFor({ timeout: 20000 });
    await falha(eng.rpc('solicitar_fechamento_fundo', { p_fundo_id: fundoId }), /já foi solicitado/, 'solicitar fechamento duas vezes');
    await falha(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: 'Depois do pedido', p_data: hoje, p_valor: 1 }), /solicitou o fechamento/, 'lançar gasto depois de solicitar o fechamento');
    confere(await p.getByRole('button', { name: 'Lançar gasto' }).count() === 0, 'ainda oferece lançar gasto depois de solicitar o fechamento');
    await falha(eng.rpc('fechar_fundo_fixo', { p_fundo_id: fundoId, p_vencimento: hoje, p_modo: 'encerrar', p_conta_id: null }), /Financeiro/, 'engenheiro fechar o próprio fundo');
    const aviso = await um(fin.from('notificacoes').select('titulo').ilike('titulo', 'Fechamento de fundo fixo%').limit(1));
    confere(aviso.length === 1, 'o Financeiro não foi avisado');
  });

  // ---------- anexos, assinatura e escopo do histórico ----------
  await passo('Anexos da OP (API): engenheiro só anexa com assinatura; caminho de outra OP/obra recusado; remover só em rascunho', async () => {
    const id = await rascunho(eng, { favorecido: marca('Anexos') });
    const envia = async (obraId, opId, assinado, caminhoForcado) => {
      const bytes = await pdfBytes('anexo ' + randomUUID());
      const caminho = caminhoForcado ?? `${obraId}/ops/${opId}/${randomUUID()}.pdf`;
      const up = await eng.storage.from('documentos').upload(caminho, bytes, { contentType: 'application/pdf' });
      if (up.error) return { upload: up.error.message };
      return eng.rpc('registrar_anexo_op', { p_ordem_id: opId, p_storage_path: caminho, p_nome: 'a.pdf', p_mime: 'application/pdf', p_sha256: sha(bytes), p_assinado: assinado });
    };
    const semAss = await envia(obra.id, id, false);
    confere(semAss.error && /Assine o arquivo/.test(semAss.error.message), `anexo sem assinatura: ${JSON.stringify(semAss.error ?? semAss)}`);
    const alheio = await envia(obra.id, id, true, `${obra.id}/ops/${randomUUID()}/${randomUUID()}.pdf`);
    confere(alheio.upload || alheio.error, 'subiu arquivo para uma OP que não existe');
    const outraObra = await envia(outras[0].id, id, true);
    confere(outraObra.upload || outraObra.error, 'subiu arquivo na pasta de outra obra');
    const daFin = await rascunho(fin, { favorecido: marca('Rasc-fin3') });
    const naDaFin = await envia(obra.id, daFin, true);
    confere(naDaFin.upload || naDaFin.error, 'anexou em rascunho do Financeiro');
    const ok = await envia(obra.id, id, true);
    confere(!ok.upload && !ok.error, `anexo assinado recusado: ${JSON.stringify(ok.error ?? ok)}`);
    const anexos = await um(admin.from('ordem_anexos').select('id, assinado').eq('ordem_id', id));
    confere(anexos.length === 1 && anexos[0].assinado, 'anexo assinado não ficou registrado');
    await um(eng.rpc('remover_anexo_op', { p_anexo_id: anexos[0].id }));
    confere((await um(admin.from('ordem_anexos').select('id').eq('ordem_id', id))).length === 0, 'não removeu');
    // depois do envio, o anexo da OP enviada não pode ser removido nem acrescentado
    const anexoEnviada = await um(admin.from('ordem_anexos').select('id').eq('ordem_id', opUI));
    if (anexoEnviada.length) await falha(eng.rpc('remover_anexo_op', { p_anexo_id: anexoEnviada[0].id }), /rascunho/, 'remover anexo de OP enviada');
    const tarde = await envia(obra.id, opUI, true);
    confere(tarde.upload || tarde.error, 'anexou em OP já enviada');
    await um(eng.rpc('excluir_op', { p_id: id }));
  });

  await passo('Assinatura cadastrada: Carlos não aponta a assinatura de outra pessoa nem sobe arquivo na pasta dela; a dele segue intacta', async () => {
    const antes = (await um(admin.from('profiles').select('assinatura_path').eq('id', euId).single())).assinatura_path;
    await falha(eng.rpc('definir_assinatura', { p_path: `${admId}/assinatura.png` }), null, 'apontar assinatura da administradora');
    const up = await eng.storage.from('assinaturas').upload(`${admId}/assinatura.png`, Buffer.from('x'), { contentType: 'image/png', upsert: true });
    confere(up.error, 'subiu arquivo na pasta de assinatura de outra pessoa');
    const dl = await eng.storage.from('assinaturas').download(`${admId}/assinatura.png`);
    confere(dl.error, 'baixou a assinatura de outra pessoa');
    const eu = await eng.storage.from('assinaturas').download(antes);
    confere(!eu.error, 'não consegue baixar a própria assinatura');
    confere((await um(admin.from('profiles').select('assinatura_path').eq('id', euId).single())).assinatura_path === antes, 'a assinatura de Carlos mudou');
    await semEfeito(eng.from('profiles').update({ assinatura_path: `${admId}/assinatura.png` }).eq('id', admId), 'trocar a assinatura da administradora');
  });

  await passo('Histórico e PDF: auditoria só das obras dele; PDF do rascunho próprio abre como PDF; OP enviada mostra o PDF oficial', async () => {
    const aud = await um(eng.from('auditoria').select('obra_id, pagamento_id').limit(2000));
    const meus = new Set((await vinculos()).minhas.map((o) => o.id));
    confere(aud.every((a) => a.obra_id === null || meus.has(a.obra_id)), 'auditoria de outra obra visível');
    confere(aud.every((a) => a.pagamento_id !== null), 'auditoria sem pagamento visível ao engenheiro (só o Financeiro vê o resto)');
    const id = await rascunho(eng, { favorecido: marca('PDF-prev') });
    const r = await p.request.get(BASE + `/ops/${id}/pdf`);
    confere(r.status() === 200 && /pdf/.test(r.headers()['content-type'] ?? ''), `PDF do rascunho: ${r.status()} ${r.headers()['content-type']}`);
    confere((await r.body()).slice(0, 4).toString() === '%PDF', 'o arquivo não é PDF');
    await um(eng.rpc('excluir_op', { p_id: id }));
    await ir(p, `/ops/${opBase}`);
    confere(await p.getByRole('link', { name: 'Abrir PDF da OP' }).count() === 1, 'OP enviada sem "Abrir PDF da OP"');
  });

  await passo('Valores (arredondamento): total por item = qtd × valor em centavos; total do pagamento = soma dos itens − desconto', async () => {
    const itens = [{ descricao: 'Fração', unidade: 'm', quantidade: 0.333, valor_unitario: 3 }, { descricao: 'Metade', unidade: 'm', quantidade: 1.5, valor_unitario: 0.33 }, { descricao: 'Grande', unidade: 'UN', quantidade: 3, valor_unitario: 33.33 }];
    const id = await rascunho(eng, { itens, desconto: 0.07, favorecido: marca('Arred') });
    const t = await um(admin.from('ordem_itens').select('total, posicao').eq('ordem_id', id).order('posicao'));
    confere(t.map((x) => Number(x.total)).join() === '1,0.5,99.99'.replace('0.5', '0.5'), `totais dos itens: ${t.map((x) => x.total)}`); // 0,999→1,00 · 0,495→0,50 · 99,99
    const pag = await enviarCompleto(eng, id);
    const pg = await pagDoBanco(pag);
    confere(Math.abs(Number(pg.valor) - (1 + 0.5 + 99.99 - 0.07)) < 0.0001, `valor do pagamento: ${pg.valor} (esperado 101,42)`);
  });

  // ---------- obra sem administrador, obra suspensa, usuário sem vínculo ----------
  const NOME_SEM_ADM = 'Obra sem administrador (persona engenheiro)';
  async function obraSemAdministrador() {
    let o = (await um(admin.from('obras').select('*').eq('nome', NOME_SEM_ADM)))[0];
    if (!o) o = await um(fin.from('obras').insert({ nome: NOME_SEM_ADM, cidade: 'Lauro de Freitas', uf: 'BA', fluxo: 'C', engenheiro_id: euId }).select().single());
    else if (o.status !== 'ativa' || o.engenheiro_id !== euId) await um(fin.from('obras').update({ status: 'ativa', engenheiro_id: euId }).eq('id', o.id).select());
    return o;
  }
  async function preencherOP(pg, { obraId, nome, venc = somarDias(hoje, 9), valor = '80,00' }) {
    await ir(pg, '/pagamentos/novo');
    await pg.selectOption('select[name=obra_id]', obraId);
    await pg.fill('input[name=vencimento]', venc);
    await pg.fill('input[name=favorecido]', nome);
    await pg.fill('input[name=descricao]', `Desp ${nome}`);
    await pg.fill('input[name=banco]', 'Banco Teste'); await pg.fill('input[name=chave_pix]', 'c@x.com');
    await pg.getByLabel('Descrição do item 1').fill('Serviço'); await pg.getByLabel('Valor unitário do item 1').fill(valor);
    await pg.click('button[aria-label="Categoria"]'); await pg.locator('[role=option]').first().click();
    await pg.locator('select[name=conta_bancaria_id]').selectOption(conta);
  }
  let obraSemAdm = null;
  await passo('Obra sem administrador (fluxo C): OP do engenheiro vai direto ao Financeiro e a assinatura dele continua registrada no documento', async () => {
    obraSemAdm = await obraSemAdministrador();
    const nome = marca('SemAdm-OP');
    await preencherOP(p, { obraId: obraSemAdm.id, nome });
    await p.getByText(/Esta obra não tem administrador: a OP seguirá direto ao Financeiro/).waitFor({ timeout: 5000 });
    await p.getByRole('button', { name: 'Salvar rascunho para anexar' }).click();
    await p.getByRole('button', { name: 'Assinar OP' }).click();
    await p.getByAltText('Última página da OP').waitFor({ timeout: 60000 });
    await p.getByRole('button', { name: 'Confirmar assinatura' }).click();
    await p.getByText(/OP assinada por você/).waitFor({ timeout: 30000 });
    await Promise.all([p.waitForURL(/\/pagamentos\/[0-9a-f-]{36}/, { timeout: 120000 }), p.getByRole('button', { name: 'Salvar e enviar' }).click()]);
    const pagId = p.url().match(/pagamentos\/([0-9a-f-]{36})/)[1];
    const pg = await pagDoBanco(pagId);
    confere(pg.fluxo === 'C' && pg.status === 'aguardando_pagamento', `pagamento: ${pg.fluxo} ${pg.status}`);
    const docs = await um(admin.from('documentos').select('tipo, nome_arquivo').eq('pagamento_id', pagId));
    confere(docs.some((d) => d.tipo === 'ordem_pagamento'), 'sem PDF oficial da OP');
    confere(docs.some((d) => d.tipo === 'documento_assinado'), `o engenheiro assinou a OP na solicitação, mas o pagamento ficou só com o PDF sem assinatura (documentos: ${docs.map((d) => d.tipo)})`);
    const aud = await um(admin.from('auditoria').select('descricao').eq('pagamento_id', pagId).eq('acao', 'criou'));
    confere(/Financeiro/.test(aud[0]?.descricao ?? ''), `linha do tempo: ${aud[0]?.descricao}`);
  });

  await passo('Obra suspensa: Carlos não cria nem envia OP nela e a obra some do formulário', async () => {
    obraSemAdm = obraSemAdm ?? (await obraSemAdministrador());
    const id = await rascunho(eng, { obra: obraSemAdm.id, favorecido: marca('Susp-OP') });
    await um(assinarCriador(eng, id));
    await um(fin.from('obras').update({ status: 'suspensa' }).eq('id', obraSemAdm.id).select());
    await falha(eng.rpc('salvar_op', { p_id: null, p_obra_id: obraSemAdm.id, p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: 0, p_numero_nf: '' }), /não está ativo/, 'criar OP em obra suspensa');
    await falha(enviarRpc(eng, id), /não está ativo/, 'enviar OP de obra suspensa');
    await ir(p, '/pagamentos/novo');
    const opcoes = await p.locator('select[name=obra_id] option').allInnerTexts();
    confere(!opcoes.some((t) => t.includes(NOME_SEM_ADM)), 'a obra suspensa aparece no formulário de OP');
    confere((await opDoBanco(id)).status === 'em_elaboracao', 'a OP saiu do rascunho');
    await um(eng.rpc('excluir_op', { p_id: id }));
  });

  await passo('Engenheiro sem vínculo com obra: não vê obras, pagamentos nem fundos, não cria OP, não assina; tela avisa que não está vinculado', async () => {
    const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]));
    // usuário fixo e reaproveitado (apagar usuário do Auth é bloqueado pela auditoria): engenheiro sem nenhuma obra
    const email = 'eng-sem-vinculo@teste.local';
    let novoId = (await um(admin.from('profiles').select('id').eq('email', email)))[0]?.id;
    if (!novoId) {
      const { data, error } = await admin.auth.admin.createUser({ email, password: 'Senha-Teste-123', email_confirm: true });
      if (error) throw new Error(error.message);
      novoId = data.user.id;
      await um(admin.from('profiles').insert({ id: novoId, nome: 'Engenheiro sem vínculo (teste)', email, perfil: 'engenheiro', troca_senha_pendente: false }));
    }
    await um(admin.from('profiles').update({ ativo: true, perfil: 'engenheiro' }).eq('id', novoId).select());
    await um(admin.from('obra_acessos').delete().eq('user_id', novoId).select());
    {
      const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
      const { error: eLogin } = await c.auth.signInWithPassword({ email, password: 'Senha-Teste-123' });
      if (eLogin) throw new Error(eLogin.message);
      confere((await um(c.from('obras').select('id'))).length === 0, 'vê obras sem vínculo');
      confere((await um(c.from('pagamentos').select('id'))).length === 0, 'vê pagamentos sem vínculo');
      confere((await um(c.from('documentos').select('id'))).length === 0, 'vê documentos sem vínculo');
      confere((await um(c.from('fundos_fixos').select('id'))).length === 0, 'vê fundos sem vínculo');
      confere((await um(c.from('ordens_pagamento').select('id'))).length === 0, 'vê OPs sem vínculo');
      await falha(c.rpc('salvar_op', { p_id: null, p_obra_id: obra.id, p_favorecido: marca('X'), p_cpf_cnpj: '', p_descricao: 'x', p_vencimento: somarDias(hoje, 5), p_forma_pagamento: 'pix', p_dados_bancarios: '', p_observacoes: '', p_itens: ITENS, p_desconto: 0, p_numero_nf: '' }), /vinculado/, 'OP sem vínculo');
      await falha(decidir(c, pagA, 1, 'aprovado'), /não encontrado/, 'aprovar sem vínculo');
      const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
      const q = await ctx.newPage();
      await q.goto(BASE + '/login'); await q.fill('input[name=email]', email); await q.fill('input[name=senha]', 'Senha-Teste-123');
      await Promise.all([q.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 }), q.click('button:has-text("Entrar")')]);
      await ir(q, '/pagamentos/novo');
      await q.getByText(/não está vinculado a nenhum centro de custo ativo/).waitFor({ timeout: 10000 });
      await ir(q, '/obras');
      confere(!(await q.locator('main').innerText()).includes(obra.nome), 'a obra aparece para quem não tem vínculo');
      const r = await q.goto(BASE + `/pagamentos/${pagOP}`);
      confere(r.status() === 404, `pagamento por URL sem vínculo: ${r.status()}`);
      await ctx.close();
    }
  });

  // ---------- Compras ----------
  await passo('Compras (tela): Carlos consulta preços de todas as obras, sem CNPJ, sem Excel e sem "Ler notas"', async () => {
    await ir(p, '/compras');
    const txt = await p.locator('main').innerText();
    confere(/Comparação de preços por material/.test(txt), 'a tela de compras não carregou');
    confere(!/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/.test(txt) && !/\b\d{14}\b/.test(txt), 'há CNPJ na tela de Compras');
    confere(!(await p.getByRole('link', { name: 'Exportar para Excel' }).count()) && !(await p.getByRole('link', { name: 'Ler notas (PDF)' }).count()), 'oferece Excel/Ler notas');
    const comNota = new Set((await um(admin.from('nf_notas').select('obra_id').eq('ativa', true))).map((n) => n.obra_id));
    const meusC = new Set((await vinculos()).minhas.map((o) => o.id));
    confere([...comNota].some((o) => !meusC.has(o)), 'sem notas de outras obras para provar o escopo');
    confere((await p.locator('select[name=obra] option').count()) - 1 === comNota.size, 'o filtro de obra deveria listar as obras com notas (inclusive de outras obras)');
    await ir(p, '/compras?material=cimento');
    confere(new URL(p.url()).pathname === '/compras', 'filtro quebrou');
    const x = await p.request.get(BASE + '/compras/exportar');
    confere(x.status() === 403, `exportar Excel de Compras: ${x.status()}`);
  });

  await passo('Compras (API): CNPJ do fornecedor sempre nulo; tabelas de notas e itens fechadas; fornecedores só nomes', async () => {
    const itens = await um(eng.from('compras_itens').select('id, fornecedor_nome, fornecedor_cnpj').limit(500));
    confere(itens.length > 0, 'sem itens de compras para conferir');
    confere(itens.every((i) => i.fornecedor_cnpj === null), 'compras_itens entrega CNPJ ao engenheiro');
    const obrasVistas = new Set((await um(eng.from('compras_itens').select('obra_id').limit(5000))).map((i) => i.obra_id));
    const meusV = new Set((await vinculos()).minhas.map((o) => o.id));
    confere([...obrasVistas].some((o) => !meusV.has(o)), 'Compras deveria trazer também notas de outras obras (README: todos os perfis, todas as obras)');
    confere((await um(eng.from('nf_notas').select('id'))).length === 0, 'nf_notas aberta ao engenheiro');
    confere((await um(eng.from('nf_itens').select('id'))).length === 0, 'nf_itens aberta ao engenheiro');
    await falha(eng.from('fornecedores').select('cpf_cnpj'), null, 'CPF/CNPJ de fornecedores');
    await falha(eng.from('fornecedores').select('chave_pix'), null, 'PIX de fornecedores');
    await falha(eng.from('fornecedores').select('banco, agencia, conta'), null, 'conta de fornecedores');
    confere((await um(eng.from('fornecedores_dados').select('id'))).length === 0, 'fornecedores_dados aberta ao engenheiro');
    await um(eng.from('fornecedores').select('id, nome').limit(5));
  });

  // ---------- Privacidade e escrita direta pela API ----------
  await passo('API: e-mail e telefone dos colegas não saem (só o próprio); contas bancárias da empresa só nomes', async () => {
    const meus = await um(eng.from('profiles_completo').select('id, email, telefone'));
    confere(meus.length === 1 && meus[0].id === euId && meus[0].email === 'engenheiro@demo.local', 'profiles_completo devolveu mais que o próprio');
    await falha(eng.from('profiles').select('email'), null, 'e-mail na tabela profiles');
    await falha(eng.from('profiles').select('telefone'), null, 'telefone na tabela profiles');
    await um(eng.from('profiles').select('id, nome, perfil')); // nomes continuam visíveis (responsável, favorecido)
    confere((await um(eng.from('contas_bancarias_dados').select('id'))).length === 0, 'contas_bancarias_dados aberta');
    await falha(eng.from('contas_bancarias').select('agencia'), null, 'agência da conta da empresa');
    await falha(eng.from('contas_bancarias').select('conta'), null, 'número da conta da empresa');
    const aud = await eng.auth.admin.listUsers();
    confere(aud.error || !aud.data?.users?.length, 'o engenheiro lista usuários do Auth');
    const cr = await eng.auth.admin.createUser({ email: `invasor-${Date.now()}@teste.local`, password: 'Senha-Teste-123' });
    confere(cr.error, 'o engenheiro criou usuário no Auth');
  });

  await passo('API: Usuários e perfis — criar perfil, mudar o próprio perfil, conceder obra e criar obra são recusados', async () => {
    await falha(eng.rpc('criar_perfil_completo', { p_id: randomUUID(), p_nome: 'Invasor', p_email: 'i@t.local', p_telefone: '', p_perfil: 'financeiro', p_obras: [] }), null, 'criar perfil');
    await semEfeito(eng.from('profiles').update({ perfil: 'financeiro' }).eq('id', euId), 'virar financeiro');
    confere((await um(admin.from('profiles').select('perfil').eq('id', euId).single())).perfil === 'engenheiro', 'o perfil do engenheiro mudou');
    const { error: eAcesso } = await eng.from('obra_acessos').insert({ obra_id: outras[0].id, user_id: euId });
    confere(eAcesso, 'concedeu a si mesmo acesso a outra obra');
    const { error: eObra } = await eng.from('obras').insert({ nome: marca('Obra-invasora'), cidade: 'X', uf: 'BA' });
    confere(eObra, 'criou obra');
    await semEfeito(eng.from('obras').update({ engenheiro_id: null, nome: 'Alterada' }).eq('id', obra.id), 'alterar a própria obra');
    confere((await um(admin.from('obras').select('nome').eq('id', obra.id).single())).nome === obra.nome, 'a obra foi alterada');
    await semEfeito(eng.from('profiles').update({ ativo: false }).neq('id', euId), 'desativar colegas');
  });

  await passo('API: baixa, conciliação, contas bancárias, categorias, medição e notas são recusadas ao engenheiro', async () => {
    const chamadas = [
      ['registrar_baixa', { p_id: pagAprovado, p_pago_em: hoje }],
      ['estornar_baixa', { p_id: pagAprovado, p_motivo: 'teste' }],
      ['registrar_baixa_parcela', { p_parcela_id: randomUUID(), p_pago_em: hoje }],
      ['importar_extrato', { p_banco: '0104', p_agencia: '1', p_conta: '1', p_arquivo: 'x.ofx', p_inicio: hoje, p_fim: hoje, p_saldo: 0, p_saldo_em: hoje, p_linhas: [] }],
      ['conciliar_linha', { p_linha_id: randomUUID(), p_itens: [], p_diferenca: 'saldo' }],
      ['conciliar_recebimento', { p_linha_id: randomUUID(), p_recebimento_id: randomUUID() }],
      ['desfazer_conciliacao', { p_linha_id: randomUUID(), p_voltar_aberto: true, p_motivo: 'x' }],
      ['arquivar_linhas', { p_ids: [randomUUID()], p_classificacao: 'x', p_observacao: 'x' }],
      ['criar_conta_bancaria', { p_nome: marca('Conta'), p_banco: '0104', p_agencia: '1', p_conta: '2' }],
      ['criar_conta_investimento', { p_nome: marca('Inv'), p_banco: '0104' }],
      ['renomear_conta_bancaria', { p_id: conta, p_nome: 'Renomeada' }],
      ['criar_categoria', { p_nome: marca('Cat') }],
      ['criar_categoria_receita', { p_nome: marca('CatR') }],
      ['atualizar_categoria', { p_id: categoria, p_nome: 'Mudada', p_ativo: false }],
      ['criar_recebimento', { p_obra_id: obra.id, p_categoria_id: categoria, p_cliente: 'X', p_descricao: 'X', p_valor: 10, p_vencimento: hoje, p_competencia: hoje, p_conta_id: conta, p_observacoes: '', p_nota_id: null }],
      ['registrar_nota_medicao', { p_obra_id: obra.id, p_storage_path: `${obra.id}/medicoes/x.pdf`, p_nome: 'x.pdf', p_mime: 'application/pdf', p_sha256: '0'.repeat(64), p_dados: {} }],
      ['marcar_nota_contabil_enviada', { p_id: randomUUID(), p_enviada: true }],
      ['criar_pagamento_completo', { p_obra_id: obra.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'X', p_valor: 10, p_vencimento: hoje, p_forma_pagamento: 'pix', p_categoria_id: categoria, p_conta_id: conta, p_numero_documento: null, p_observacoes: null, p_competencia: hoje, p_parcelas: null, p_repetir_intervalo: null, p_repetir_vezes: null, p_provisao_id: null }],
      ['criar_pagamento', { p_obra_id: obra.id, p_fornecedor_id: null, p_favorecido: 'X', p_descricao: 'X', p_valor: 10, p_vencimento: hoje, p_forma_pagamento: 'pix' }],
      ['excluir_lancamentos', { p_pagamento_id: pagAprovado, p_parcela_id: null, p_escopo: 'este', p_motivo: 'x' }],
      ['cancelar_pagamento', { p_id: pagAprovado, p_motivo: 'x' }],
    ];
    for (const [fn, args] of chamadas) await falha(eng.rpc(fn, args), null, `engenheiro executou ${fn}`);
    confere((await pagDoBanco(pagAprovado)).status === 'pago', 'o pagamento pago do teste mudou de situação');
    for (const t of ['extrato_linhas', 'extrato_importacoes', 'conciliacao_itens', 'transferencias']) {
      confere((await um(eng.from(t).select('id'))).length === 0, `${t} visível ao engenheiro`);
    }
    confere((await um(eng.from('notas_contabeis').select('id'))).length === 0, 'notas_contabeis visível ao engenheiro');
    confere((await um(eng.from('notas_medicao').select('id'))).every(() => true), 'notas de medição: leitura');
  });

  await passo('API: escrita direta em pagamentos, assinaturas, documentos, auditoria e OP é recusada; o estado não muda', async () => {
    const antes = await pagDoBanco(pagOP);
    await semEfeito(eng.from('pagamentos').update({ status: 'pago', valor: 1 }).eq('id', pagOP), 'pagamentos.update');
    await semEfeito(eng.from('pagamentos').delete().eq('id', pagOP), 'pagamentos.delete');
    await semEfeito(eng.from('ordens_pagamento').update({ status: 'paga', desconto: 0 }).eq('id', opBase), 'ordens.update');
    await semEfeito(eng.from('ordem_itens').update({ valor_unitario: 0.01 }).eq('ordem_id', opBase), 'ordem_itens.update');
    await semEfeito(eng.from('assinaturas').delete().eq('pagamento_id', pagOP), 'assinaturas.delete');
    await semEfeito(eng.from('assinaturas').update({ decisao: 'rejeitado' }).eq('pagamento_id', pagOP), 'assinaturas.update');
    await semEfeito(eng.from('documentos').delete().eq('pagamento_id', pagOP), 'documentos.delete');
    await semEfeito(eng.from('auditoria').delete().eq('pagamento_id', pagOP), 'auditoria.delete');
    await semEfeito(eng.from('auditoria').update({ descricao: 'apagado' }).eq('pagamento_id', pagOP), 'auditoria.update');
    const { error: eIns } = await eng.from('pagamentos').insert({ obra_id: obra.id, favorecido: 'X', descricao: 'X', valor: 1, vencimento: hoje, forma_pagamento: 'pix', fluxo: 'C', status: 'aguardando_pagamento' });
    confere(eIns, 'insert direto em pagamentos foi aceito');
    const { error: eAss } = await eng.from('assinaturas').insert({ pagamento_id: pagOP, etapa: 'administrador', decisao: 'aprovado', user_id: euId, user_nome: 'Carlos', pagamento_versao: 1, hash_integridade: '0'.repeat(64), conteudo_assinado: {} });
    confere(eAss, 'forjou assinatura do administrador');
    const { error: eNot } = await eng.from('notificacoes').insert({ user_id: admId, titulo: 'forjada', mensagem: 'x' });
    confere(eNot, 'inseriu notificação para outro usuário');
    const depois = await pagDoBanco(pagOP);
    confere(antes.status === depois.status && Number(antes.valor) === Number(depois.valor) && antes.versao === depois.versao, 'o pagamento mudou');
    confere((await um(admin.from('assinaturas').select('id').eq('pagamento_id', pagOP))).length === 1, 'assinaturas mudaram');
  });

  await passo('API: engenheiro cancela só... nada: cancelar/editar pagamento de outra pessoa e de outra obra é recusado', async () => {
    const id = await despesaParaEngenheiro(marca('Cancel-fin'));
    await falha(eng.rpc('cancelar_pagamento', { p_id: id, p_motivo: 'quero cancelar' }), null, 'cancelar despesa do Financeiro');
    await falha(eng.rpc('atualizar_pagamento', { p_id: id, p_fornecedor_id: null, p_favorecido: 'Outro', p_descricao: 'Alterada', p_valor: 1, p_vencimento: hoje, p_forma_pagamento: 'boleto', p_numero_documento: null, p_observacoes: null, p_motivo: 'x', p_obra_id: obra.id }), null, 'editar despesa do Financeiro');
    const pg = await pagDoBanco(id);
    confere(pg.status === 'aguardando_engenheiro' && pg.descricao !== 'Alterada', 'a despesa do Financeiro mudou');
  });

  // ---------- notificações, privacidade nas telas, leitura de recebíveis, relatórios ----------
  await passo('Notificações: Carlos só recebe as dele (nova despesa para assinar) e abre o pagamento pelo aviso; não cria aviso para outro', async () => {
    const id = await despesaParaEngenheiro(marca('Aviso-eng'));
    const minhas = await um(eng.from('notificacoes').select('id, user_id, pagamento_id'));
    confere(minhas.length > 0 && minhas.every((n) => n.user_id === euId), 'a API devolve aviso de outra pessoa');
    const aviso = minhas.find((n) => n.pagamento_id === id);
    confere(aviso, 'o engenheiro não foi avisado da despesa que aguarda a assinatura dele');
    await ir(p, '/notificacoes');
    confere((await p.locator('main').innerText()).length > 20, 'a tela de notificações veio vazia');
    const ab = await p.request.get(BASE + `/notificacoes/${aviso.id}`, { maxRedirects: 0 });
    confere(ab.status() === 303 && new URL(ab.headers().location).pathname === `/pagamentos/${id}`, `o aviso levou a ${ab.status()} ${ab.headers().location}`);
    confere((await um(admin.from('notificacoes').select('lida_em').eq('id', aviso.id).single())).lida_em, 'o aviso não ficou marcado como lido');
    const alheia = await um(adm.from('notificacoes').select('id').limit(1));
    if (alheia.length) {
      const antes = (await um(admin.from('notificacoes').select('lida_em').eq('id', alheia[0].id).single())).lida_em;
      await eng.rpc('marcar_notificacoes_lidas', { p_ids: alheia.map((a) => a.id) }); // não pode afetar as do administrador
      confere((await um(admin.from('notificacoes').select('lida_em').eq('id', alheia[0].id).single())).lida_em === antes, 'o engenheiro marcou como lido o aviso de outra pessoa');
    }
  });

  await passo('Privacidade nas telas: e-mail e telefone de colegas não aparecem em Painel, Obra, Pagamento, Aprovações, Fundos nem Notificações', async () => {
    const donos = await um(admin.from('profiles_completo').select('email, telefone').neq('id', euId)).catch(() => []);
    const emails = (await um(admin.auth.admin.listUsers())).users.map((u) => u.email).filter((e) => e && e !== 'engenheiro@demo.local');
    for (const rota of ['/', '/obras', `/obras/${obra.id}`, `/pagamentos/${pagOP}`, `/pagamentos/${pagAprovado}`, '/aprovacoes', '/fundos-fixos', `/fundos-fixos/${fundoId}`, '/notificacoes', '/relatorios']) {
      await ir(p, rota);
      const html = await p.content();
      const vazou = emails.find((e) => html.includes(e));
      confere(!vazou, `${rota} mostra o e-mail de um colega (${vazou})`);
    }
    void donos;
  });

  await passo('Relatórios e exportação: Carlos vê e exporta só as obras dele (nenhum nome de obra alheia)', async () => {
    await ir(p, '/relatorios?ver=centro');
    const txt = await p.locator('main').innerText();
    confere(txt.includes(obra.nome), 'o relatório não mostra a obra dele');
    const alheias = (await vinculos()).outras;
    for (const o of alheias) confere(!txt.includes(o.nome), `o relatório mostra a obra de outro vínculo: ${o.nome}`);
    const csv = await p.request.get(BASE + '/pagamentos/exportar?periodo=todos');
    confere(csv.status() === 200, `exportar planilha: ${csv.status()}`);
    const corpo = await csv.text();
    for (const o of alheias) confere(!corpo.includes(o.nome), `a planilha traz a obra de outro vínculo: ${o.nome}`);
    confere(corpo.includes(obra.nome), 'a planilha não traz a obra dele');
  });

  await passo('Contas a receber e Provisões: Carlos só lê (sem lançar), só das obras dele; escrita pela API é recusada', async () => {
    await ir(p, '/recebimentos?periodo=todos');
    const txt = await p.locator('main').innerText();
    confere(!/Lançar receita|Nova receita|Novo recebimento/.test(txt), 'oferece lançar receita ao engenheiro');
    const vis = await um(eng.from('recebimentos').select('id, obra_id'));
    const meusR = new Set((await vinculos()).minhas.map((o) => o.id));
    confere(vis.every((r) => meusR.has(r.obra_id)), 'vê recebimento de outra obra');
    const alheio = await um(admin.from('recebimentos').select('id').in('obra_id', outras.map((o) => o.id)).limit(1));
    if (alheio.length) {
      const r = await p.goto(BASE + `/recebimentos/${alheio[0].id}`);
      confere(r.status() === 404, `/recebimentos/[id] de outra obra: ${r.status()}`);
    }
    const { error: eRec } = await eng.from('recebimentos').insert({ obra_id: obra.id, cliente: 'X', descricao: 'X', valor: 1, vencimento: hoje, status: 'aberto' });
    confere(eRec, 'inseriu recebimento direto');
    await semEfeito(eng.from('recebimentos').update({ valor: 1 }).eq('obra_id', obra.id), 'recebimentos.update');
    await ir(p, '/provisoes');
    const tp = await p.locator('main').innerText();
    confere(!/Registrar provisão/.test(tp), 'o engenheiro vê o formulário de registrar provisão');
    const { error: eProv } = await eng.from('provisoes').insert({ obra_id: obra.id, descricao: marca('Prov-eng'), vencimento: hoje, valor_estimado: 10 });
    confere(eProv, 'o engenheiro registrou provisão direto pela API (só Financeiro e Suprimentos criam)');
    await semEfeito(eng.from('provisoes').delete().eq('obra_id', obra.id), 'provisoes.delete');
  });

  await passo('Obra e agenda: /obras/[id] de obra alheia dá 404; agenda mostra só as obras dele', async () => {
    const r = await p.goto(BASE + `/obras/${outras[0].id}`);
    confere(r.status() === 404, `/obras/[id] de obra alheia: ${r.status()}`);
    await ir(p, `/obras/${obra.id}`);
    confere(!(await p.getByRole('button', { name: /Salvar|Excluir|Desativar/ }).count()), 'a tela da obra oferece edição ao engenheiro');
    await ir(p, '/agenda');
    const txt = await p.locator('main').innerText();
    for (const o of (await vinculos()).outras) confere(!txt.includes(o.nome), `a agenda mostra a obra de outro vínculo: ${o.nome}`);
  });

  // ---------- celular (390px) ----------
  const semRolagem = async (pg) => pg.evaluate(() => {
    const tabelas = [...document.querySelectorAll('main *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.offsetParent !== null);
    return { pagina: document.documentElement.scrollWidth - innerWidth, tabelas: tabelas.map((w) => `${w.tagName}.${String(w.className).slice(0, 30)} ${w.scrollWidth}>${w.clientWidth}`) };
  });
  const cel = await entrar('engenheiro', 390);
  for (const [nome, url] of [
    ['Painel', '/'], ['Contas a pagar', '/pagamentos'], ['Aprovações', '/aprovacoes'], ['Centros de custo', '/obras'], ['Fundo fixo', () => `/fundos-fixos/${fundoId}`],
    ['Lista de fundos', '/fundos-fixos'], ['Compras', '/compras'], ['Contas a receber', '/recebimentos'], ['Minha assinatura', '/perfil'], ['OP enviada', () => `/ops/${opBase}`], ['Pagamento da OP', () => `/pagamentos/${pagOP}`], ['Nova OP', '/pagamentos/novo'],
  ]) {
    await passo(`Celular 390px: ${nome} cabe na largura, sem rolagem lateral`, async () => {
      await ir(cel, typeof url === 'function' ? url() : url);
      const r = await semRolagem(cel);
      confere(r.pagina <= 1, `a página passa ${r.pagina}px da tela`);
      confere(r.tabelas.length === 0, `rolagem lateral em: ${r.tabelas.join(' | ')}`);
    });
  }

  await passo('Celular 390px: o menu do celular abre pelo botão, lista só o que o engenheiro usa e fecha ao escolher uma tela', async () => {
    await ir(cel, '/');
    await cel.getByRole('button', { name: 'Abrir menu' }).click();
    const itens = await cel.getByRole('navigation', { name: 'Menu principal' }).locator('a').allInnerTexts();
    confere(itens.length > 5 && itens.some((t) => t.startsWith('Aprovações')), `menu: ${itens.join(' | ')}`);
    confere(!itens.some((t) => /Usuários|Contas bancárias|Fornecedores/.test(t)), 'o menu do celular mostra itens proibidos');
    const visiveis = await cel.getByRole('navigation', { name: 'Menu principal' }).locator('a:visible').count();
    confere(visiveis > 5, 'o menu aberto não está visível');
    await cel.getByRole('navigation', { name: 'Menu principal' }).getByRole('link', { name: 'Fundos fixos' }).click();
    await cel.waitForURL(/\/fundos-fixos/);
    confere(await cel.getByRole('navigation', { name: 'Menu principal' }).locator('a:visible').count() === 0, 'o menu continuou aberto depois de escolher uma tela');
  });

  // ---------- janelas (role="dialog") ----------
  const medirJanelas = (pg, vw) => pg.evaluate((w) => [...document.querySelectorAll('[role="dialog"]')].map((d) => {
    const c = d.firstElementChild || d; const box = c.getBoundingClientRect();
    const rolavel = ['auto', 'scroll'].includes(getComputedStyle(d).overflowY);
    return { corta: c.scrollWidth > c.clientWidth + 1, fora: box.left < -1 || box.right > w + 1, verticalInalcancavel: box.bottom > innerHeight + 1 && !rolavel, visivel: box.width > 0 };
  }), vw);
  for (const largura of [1440, 390]) {
    await passo(`Janelas (${largura}px): "Assinar OP" e "Posicione sua assinatura" do anexo cabem na tela e o botão Confirmar é alcançável`, async () => {
      const pj = largura === 1440 ? p : cel;
      const id = await rascunho(eng, { favorecido: marca('Janela') });
      await ir(pj, `/ops/${id}/editar`);
      await pj.getByRole('button', { name: 'Assinar OP' }).click();
      await pj.getByAltText('Última página da OP').waitFor({ timeout: 60000 });
      let ms = await medirJanelas(pj, largura);
      confere(ms.length === 1 && ms.every((m) => m.visivel && !m.corta && !m.fora && !m.verticalInalcancavel), `janela Assinar OP: ${JSON.stringify(ms)}`);
      const conf = pj.getByRole('button', { name: 'Confirmar assinatura' });
      await conf.scrollIntoViewIfNeeded();
      confere(await conf.isVisible(), 'o botão Confirmar assinatura não fica visível');
      await pj.getByRole('button', { name: 'Cancelar' }).click();
      await pj.locator('label:has-text("Anexar comprovante") input[type=file]').setInputFiles(pdfUI);
      await pj.getByText('Posicione sua assinatura').waitFor({ timeout: 60000 });
      ms = await medirJanelas(pj, largura);
      confere(ms.length === 1 && ms.every((m) => m.visivel && !m.corta && !m.fora && !m.verticalInalcancavel), `janela do anexo: ${JSON.stringify(ms)}`);
      await pj.getByRole('button', { name: 'Cancelar' }).click();
      await um(eng.rpc('excluir_op', { p_id: id }));
    });
    await passo(`Janelas (${largura}px): "Assinatura em lote" (Aprovações) cabe na tela e os campos de senha e botão são alcançáveis`, async () => {
      const pj = largura === 1440 ? p : cel;
      const r = marca('Janela-lote');
      await despesaParaEngenheiro(r);
      await ir(pj, '/aprovacoes');
      await pj.locator('tr', { hasText: r }).locator('input[type=checkbox]').check();
      await pj.getByRole('button', { name: 'Revisar e assinar selecionados' }).click();
      await pj.locator('[role=dialog]').waitFor({ timeout: 15000 });
      const ms = await medirJanelas(pj, largura);
      confere(ms.length === 1 && ms.every((m) => m.visivel && !m.corta && !m.fora && !m.verticalInalcancavel), `janela de assinatura em lote: ${JSON.stringify(ms)}`);
      const btn = pj.getByRole('button', { name: 'Assinar e aprovar' });
      await btn.scrollIntoViewIfNeeded();
      confere(await btn.isVisible() && await pj.locator('input[name=senha]').isVisible(), 'campo de senha ou botão fora de alcance');
      await pj.getByRole('button', { name: 'Fechar' }).click();
    });
    await passo(`Janelas (${largura}px): "Posicione sua assinatura" do pagamento (Abrir e posicionar) e do comprovante do fundo cabem na tela`, async () => {
      const pj = largura === 1440 ? p : cel;
      const id = await despesaParaEngenheiro(marca('Janela-ap'));
      await ir(pj, `/pagamentos/${id}`);
      const abrir = pj.getByRole('button', { name: 'Abrir e posicionar a assinatura' });
      if (await abrir.count()) {
        await abrir.click();
        await pj.locator('[role=dialog]').waitFor({ timeout: 60000 });
        const ms = await medirJanelas(pj, largura);
        confere(ms.length >= 1 && ms.every((m) => m.visivel && !m.corta && !m.fora && !m.verticalInalcancavel), `janela de assinatura do pagamento: ${JSON.stringify(ms)}`);
      } else {
        throw new Error('a tela do pagamento não oferece "Abrir e posicionar a assinatura" ao engenheiro da etapa');
      }
      const descJan = marca('Jan-gasto');
      const g = await um(eng.rpc('lancar_gasto_fundo', { p_fundo_id: fundoId, p_descricao: descJan, p_data: hoje, p_valor: 1 }));
      if (g) {
        await ir(pj, `/fundos-fixos/${fundoId}`);
        const li = pj.locator('li', { hasText: descJan });
        await li.locator('input[type=file]').setInputFiles(pdfUI);
        await pj.getByText('Posicione sua assinatura').waitFor({ timeout: 60000 });
        const ms = await medirJanelas(pj, largura);
        confere(ms.length >= 1 && ms.every((m) => m.visivel && !m.corta && !m.fora && !m.verticalInalcancavel), `janela do comprovante do fundo: ${JSON.stringify(ms)}`);
      }
    });
  }
});
