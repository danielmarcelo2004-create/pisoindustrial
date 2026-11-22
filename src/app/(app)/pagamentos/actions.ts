"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUsuario } from "@/lib/auth";
import { arquivosDoForm, enviarDocumento, validarArquivo } from "@/lib/documentos";
import { mensagemErro, type Estado } from "@/lib/erros";
import { lerValor } from "@/lib/formato";
import { FORMAS_PAGAMENTO, TIPOS_DOCUMENTO, type FormaPagamento, type TipoDocumento } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";
import { duplicarOP } from "../ops/actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function texto(fd: FormData, k: string) {
  return String(fd.get(k) ?? "").trim();
}

function lerDadosPagamento(fd: FormData) {
  const fornecedor = texto(fd, "fornecedor_id");
  const favorecido = texto(fd, "favorecido");
  const descricao = texto(fd, "descricao");
  const valor = lerValor(texto(fd, "valor"));
  const vencimento = texto(fd, "vencimento");
  const forma = texto(fd, "forma_pagamento") as FormaPagamento;

  if (fornecedor && !UUID.test(fornecedor)) return { erro: "Fornecedor inválido." } as const;
  if (!fornecedor && !favorecido) return { erro: "Selecione um fornecedor ou informe o favorecido." } as const;
  if (!descricao) return { erro: "Informe a descrição." } as const;
  if (valor === null) return { erro: "Informe um valor válido (ex.: 1.250,00)." } as const;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) return { erro: "Informe a data de vencimento." } as const;
  if (!(forma in FORMAS_PAGAMENTO)) return { erro: "Forma de pagamento inválida." } as const;

  return {
    dados: {
      // null explícito: o PostgREST exige todos os parâmetros sem valor padrão.
      p_fornecedor_id: (fornecedor || null) as string,
      p_favorecido: favorecido,
      p_descricao: descricao,
      p_valor: valor,
      p_vencimento: vencimento,
      p_forma_pagamento: forma,
      p_numero_documento: texto(fd, "numero_documento"),
      p_observacoes: texto(fd, "observacoes"),
    },
  } as const;
}

async function buscarPagamento(id: string) {
  if (!UUID.test(id)) return null;
  const supabase = await createClient();
  const { data } = await supabase.from("pagamentos").select("id, obra_id, status, created_by").eq("id", id).maybeSingle();
  return data;
}

export async function criarPagamento(_: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const obra = texto(fd, "obra_id");
  if (!UUID.test(obra)) return { erro: "Selecione a obra." };
  const lido = lerDadosPagamento(fd);
  if ("erro" in lido) return { erro: lido.erro };

  const categoria = texto(fd, "categoria_id");
  if (!UUID.test(categoria)) return { erro: "Escolha a categoria." };
  const contaBancaria = texto(fd, "conta_bancaria_id");
  if (!UUID.test(contaBancaria)) return { erro: "Escolha a conta bancária (de onde sai o pagamento)." };
  const repIntervalo = Number(texto(fd, "repetir_intervalo") || 0);
  const repVezes = Number(texto(fd, "repetir_vezes") || 0);
  if (repIntervalo && (repIntervalo < 1 || repIntervalo > 12 || repVezes < 2 || repVezes > 60)) {
    return { erro: "Repetição inválida: de 1 a 12 meses e de 2 a 60 vezes." };
  }

  // Parcelas escolhidas no cadastro (uma parcela = pagamento único). A soma precisa ser igual ao valor.
  let parcelas: { valor: number; vencimento: string }[] = [];
  try {
    const bruto = JSON.parse(texto(fd, "parcelas_json") || "[]");
    if (Array.isArray(bruto)) parcelas = bruto as typeof parcelas;
  } catch {
    return { erro: "Parcelas inválidas." };
  }
  if (parcelas.length >= 2) {
    if (parcelas.some((p) => !(Number(p.valor) > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.vencimento)))) {
      return { erro: "Cada parcela precisa de valor maior que zero e vencimento." };
    }
    const soma = parcelas.reduce((s, p) => s + Number(p.valor), 0);
    if (Math.abs(soma - Number(lido.dados.p_valor)) >= 0.005) {
      return { erro: "A soma das parcelas precisa ser igual ao valor do pagamento." };
    }
  }

  const anexos: { tipo: TipoDocumento; arquivo: File }[] = [
    ...arquivosDoForm(fd, "boleto").map((arquivo) => ({ tipo: "boleto" as const, arquivo })),
    ...arquivosDoForm(fd, "nota_fiscal").map((arquivo) => ({ tipo: "nota_fiscal" as const, arquivo })),
    ...arquivosDoForm(fd, "outros").map((arquivo) => ({ tipo: "outro" as const, arquivo })),
  ];
  for (const a of anexos) {
    const e = validarArquivo(a.arquivo);
    if (e) return { erro: e };
  }
  // O engenheiro assina boleto ou nota fiscal (comprovante não entra na assinatura): sem um deles não há o que aprovar.
  if (!anexos.some((a) => a.tipo === "boleto" || a.tipo === "nota_fiscal")) {
    return { erro: "Anexe um boleto ou nota fiscal para o engenheiro assinar." };
  }

  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("criar_pagamento", { p_obra_id: obra, ...lido.dados });
  if (error || !id) return { erro: mensagemErro(error) };

  const competencia = texto(fd, "data_competencia");
  if (/^\d{4}-\d{2}-\d{2}$/.test(competencia)) {
    await supabase.rpc("definir_competencia", { p_pagamento_id: id as string, p_data: competencia });
  }
  await supabase.rpc("definir_categoria", { p_pagamento_id: id as string, p_categoria_id: categoria });
  const { error: erroConta } = await supabase.rpc("definir_conta_bancaria", { p_pagamento_id: id as string, p_conta_id: contaBancaria });
  if (parcelas.length >= 2) {
    const { error: erroParcelas } = await supabase.rpc("definir_parcelas", {
      p_pagamento_id: id as string,
      p_parcelas: parcelas.map((p) => ({ valor: Number(p.valor), vencimento: p.vencimento, multa: 0, juros: 0, desconto: 0, motivo: null })) as never,
    });
    if (erroParcelas) {
      revalidatePath("/", "layout");
      redirect(`/pagamentos/${id}?aviso=${encodeURIComponent("Pagamento cadastrado, mas as parcelas não foram gravadas: " + mensagemErro(erroParcelas))}`);
    }
  }

  const falhas: string[] = [];
  if (erroConta) falhas.push("A conta bancária não foi gravada: " + mensagemErro(erroConta));
  if (repIntervalo) {
    const { error: erroRep } = await supabase.rpc("criar_repeticoes", { p_pagamento_id: id as string, p_intervalo: repIntervalo, p_vezes: repVezes });
    if (erroRep) falhas.push("As repetições não foram criadas: " + mensagemErro(erroRep));
  }
  for (const a of anexos) {
    const r = await enviarDocumento(supabase, { id, obra_id: obra }, a.tipo, a.arquivo);
    if (r.erro) falhas.push(r.erro);
    if (r.aviso) falhas.push(r.aviso);
  }

  revalidatePath("/", "layout");
  redirect(`/pagamentos/${id}?${falhas.length ? "aviso=" + encodeURIComponent(falhas.join(" ")) : "criado=1"}`);
}

export async function atualizarPagamento(id: string, _: Estado, fd: FormData): Promise<Estado> {
  const usuario = await getUsuario();
  const p = await buscarPagamento(id);
  if (!p) return { erro: "Pagamento não encontrado." };
  const lido = lerDadosPagamento(fd);
  if ("erro" in lido) return { erro: lido.erro };

  // Parcelas editadas: valida tudo ANTES de gravar, para o total nunca ficar diferente da soma das parcelas
  const parcelasTxt = texto(fd, "parcelas_editadas");
  let parcelasEditadas: { id: string; vencimento: string; valor: number }[] | null = null;
  if (parcelasTxt) {
    if (usuario.perfil !== "financeiro" && p.created_by !== usuario.id) return { erro: "Somente o Financeiro ou quem cadastrou altera as parcelas." };
    let itens: unknown;
    try {
      itens = JSON.parse(parcelasTxt);
    } catch {
      return { erro: "Parcelas inválidas." };
    }
    if (!Array.isArray(itens)) return { erro: "Parcelas inválidas." };
    for (const [i, it] of itens.entries()) {
      const x = it as { id?: unknown; vencimento?: unknown; valor?: unknown };
      if (typeof x.id !== "string" || !UUID.test(x.id)) return { erro: "Parcelas inválidas." };
      if (typeof x.vencimento !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x.vencimento)) return { erro: `Parcela ${i + 1}: informe o vencimento.` };
      if (typeof x.valor !== "number" || !(x.valor > 0)) return { erro: `Parcela ${i + 1}: informe um valor válido (ex.: 1.250,00).` };
    }
    parcelasEditadas = itens as { id: string; vencimento: string; valor: number }[];
  }

  const [novoBoleto] = arquivosDoForm(fd, "novo_boleto");
  if (novoBoleto) {
    const e = validarArquivo(novoBoleto);
    if (e) return { erro: e };
  }
  const supabase = await createClient();
  const { data: antes } = await supabase.from("pagamentos").select("valor, obra_id").eq("id", id).single();
  // "Editar lançamento (todas as parcelas)": as parcelas são gravadas primeiro (elas acertam o total e o vencimento);
  // se forem recusadas, nada é salvo.
  if (parcelasEditadas?.length) {
    const { error: erroParc } = await supabase.rpc("editar_parcelas", { p_pagamento_id: id, p_parcelas: parcelasEditadas as never, p_motivo: texto(fd, "motivo") || undefined });
    if (erroParc) return { erro: "Nada foi salvo: " + mensagemErro(erroParc) };
  }
  const { error } = await supabase.rpc("atualizar_pagamento", {
    p_id: id,
    ...lido.dados,
    p_motivo: texto(fd, "motivo"),
    p_obra_id: texto(fd, "obra_id") || undefined,
  });
  if (error) return { erro: mensagemErro(error) };
  const competencia = texto(fd, "data_competencia");
  if (/^\d{4}-\d{2}-\d{2}$/.test(competencia)) {
    const { error: erroComp } = await supabase.rpc("definir_competencia", { p_pagamento_id: id, p_data: competencia });
    if (erroComp) return { erro: mensagemErro(erroComp) };
  }
  const categoria = texto(fd, "categoria_id");
  if (UUID.test(categoria)) {
    const { error: erroCat } = await supabase.rpc("definir_categoria", { p_pagamento_id: id, p_categoria_id: categoria });
    if (erroCat) return { erro: mensagemErro(erroCat) };
  }
  const contaBancaria = texto(fd, "conta_bancaria_id");
  if (UUID.test(contaBancaria)) {
    const { error: erroConta } = await supabase.rpc("definir_conta_bancaria", { p_pagamento_id: id, p_conta_id: contaBancaria });
    if (erroConta) return { erro: mensagemErro(erroConta) };
  }
  // "Aplicar o novo valor às próximas": provisões em aberto da repetição
  if (fd.get("reajustar_serie") === "on") {
    const { error: erroSerie } = await supabase.rpc("reajustar_serie", { p_pagamento_id: id, p_valor: lido.dados.p_valor });
    if (erroSerie) return { erro: mensagemErro(erroSerie) };
  }
  // Boleto novo junto com a edição: substitui o boleto ativo (o anterior fica no histórico).
  if (novoBoleto) {
    const { data: boletoAtivo } = await supabase
      .from("documentos")
      .select("id")
      .eq("pagamento_id", id)
      .eq("tipo", "boleto")
      .eq("ativo", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const mudouValor = antes && Number(antes.valor) !== lido.dados.p_valor;
    const motivo = mudouValor
      ? `Valor alterado de R$ ${Number(antes.valor).toFixed(2).replace(".", ",")} para R$ ${lido.dados.p_valor.toFixed(2).replace(".", ",")}`
      : "Boleto atualizado na edição do pagamento";
    const { data: atual } = await supabase.from("pagamentos").select("id, obra_id").eq("id", id).single();
    const r = await enviarDocumento(supabase, atual ?? p, "boleto", novoBoleto, boletoAtivo ? { id: boletoAtivo.id, motivo } : undefined);
    if (r.erro) {
      revalidatePath("/", "layout");
      return { erro: `Dados salvos, mas o boleto novo não foi anexado: ${r.erro}` };
    }
  }
  revalidatePath("/", "layout");
  redirect(`/pagamentos/${id}?salvo=1`);
}

export async function anexarDocumento(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const p = await buscarPagamento(id);
  if (!p) return { erro: "Pagamento não encontrado." };
  const tipo = texto(fd, "tipo") as TipoDocumento;
  if (!(tipo in TIPOS_DOCUMENTO)) return { erro: "Selecione o tipo de documento." };
  const arquivos = arquivosDoForm(fd, "arquivo");
  if (arquivos.length === 0) return { erro: "Selecione o arquivo." };

  const supabase = await createClient();
  const avisos: string[] = [];
  for (const arq of arquivos) {
    const r = await enviarDocumento(supabase, p, tipo, arq);
    if (r.erro) {
      revalidatePath(`/pagamentos/${id}`);
      return { erro: r.erro };
    }
    if (r.aviso) avisos.push(r.aviso);
  }
  revalidatePath(`/pagamentos/${id}`);
  const ok = arquivos.length > 1 ? `${arquivos.length} documentos anexados.` : "Documento anexado.";
  return avisos.length ? { erro: `${ok} Atenção: ${avisos.join(" ")}` } : { ok };
}

export async function substituirDocumento(id: string, documentoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const p = await buscarPagamento(id);
  if (!p || !UUID.test(documentoId)) return { erro: "Documento não encontrado." };
  const motivo = texto(fd, "motivo");
  if (!motivo) return { erro: "Informe o motivo da substituição." };
  const [arquivo] = arquivosDoForm(fd, "arquivo");
  if (!arquivo) return { erro: "Selecione o novo arquivo." };

  const supabase = await createClient();
  const { data: doc } = await supabase.from("documentos").select("tipo").eq("id", documentoId).maybeSingle();
  if (!doc) return { erro: "Documento não encontrado." };
  const r = await enviarDocumento(supabase, p, doc.tipo, arquivo, { id: documentoId, motivo });
  if (r.erro) return { erro: r.erro };
  if (r.aviso) return { erro: `Documento substituído, mas: ${r.aviso}` };
  revalidatePath("/", "layout");
  return { ok: "Documento substituído. A versão anterior foi preservada no histórico." };
}

export async function cancelarPagamento(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancelar_pagamento", { p_id: id, p_motivo: texto(fd, "motivo") });
  if (error) return { erro: mensagemErro(error) };
  // "Cancelar também as próximas": provisões em aberto da repetição deste pagamento
  let extra = "";
  if (fd.get("cancelar_serie") === "on") {
    const { data: qtd, error: erroSerie } = await supabase.rpc("cancelar_serie", { p_pagamento_id: id });
    if (erroSerie) return { erro: "Pagamento cancelado, mas as repetições não foram canceladas: " + mensagemErro(erroSerie) };
    if (qtd) extra = ` ${qtd} repetição(ões) futura(s) também cancelada(s).`;
  }
  revalidatePath("/", "layout");
  return { ok: "Pagamento cancelado." + extra };
}

/** Estorno de baixa do pagamento (sem parcelas): volta para "a pagar". */
export async function estornarBaixa(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  if (!UUID.test(id)) return { erro: "Pagamento não encontrado." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("estornar_baixa", { p_id: id, p_motivo: texto(fd, "motivo") });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  return { ok: "Baixa estornada: o pagamento voltou para \"aguardando pagamento\"." };
}

/** Estorno de uma parcela paga. */
export async function estornarParcela(parcelaId: string, pagamentoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  if (!UUID.test(parcelaId)) return { erro: "Parcela não encontrada." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("estornar_baixa_parcela", { p_parcela_id: parcelaId, p_motivo: texto(fd, "motivo") });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath(`/pagamentos/${pagamentoId}`);
  revalidatePath("/", "layout");
  return { ok: "Parcela estornada." };
}

/** Aviso de possível duplicidade (não bloqueia o cadastro). */
export async function verificarDuplicidade(dados: { hashes: string[]; favorecido: string; valor: number | null; vencimento: string }) {
  await getUsuario();
  const supabase = await createClient();
  const { data } = await supabase.rpc("verificar_duplicidade", {
    p_hashes: dados.hashes.filter((h) => /^[0-9a-f]{64}$/.test(h)),
    p_favorecido: dados.favorecido.trim() || (null as unknown as string),
    p_valor: (dados.valor ?? null) as number,
    p_vencimento: (/^\d{4}-\d{2}-\d{2}$/.test(dados.vencimento) ? dados.vencimento : null) as string,
  });
  return data ?? [];
}

export async function reenviarPagamento(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const supabase = await createClient();
  const { error } = await supabase.rpc("reenviar_pagamento", { p_id: id, p_observacao: texto(fd, "observacao") });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  return { ok: "Pagamento reenviado para aprovação." };
}

export async function registrarBaixa(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const p = await buscarPagamento(id);
  if (!p) return { erro: "Pagamento não encontrado." };
  const pagoEm = texto(fd, "pago_em");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pagoEm)) return { erro: "Informe a data do pagamento." };
  const valorTxt = texto(fd, "valor_pago");
  const valor = valorTxt ? lerValor(valorTxt) : null;
  if (valorTxt && valor === null) return { erro: "Valor pago inválido." };
  const [comprovante] = arquivosDoForm(fd, "comprovante");
  if (comprovante) {
    const e = validarArquivo(comprovante);
    if (e) return { erro: e };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("registrar_baixa", {
    p_id: id,
    p_pago_em: pagoEm,
    p_valor_pago: valor ?? undefined,
    p_observacao: texto(fd, "observacao"),
    // Valor menor que o devido: a diferença é saldo em aberto (padrão) ou desconto
    p_diferenca: texto(fd, "diferenca") === "desconto" ? "desconto" : "saldo",
  });
  if (error) return { erro: mensagemErro(error) };

  if (comprovante) {
    const r = await enviarDocumento(supabase, p, "comprovante", comprovante);
    if (r.erro) {
      revalidatePath("/", "layout");
      return { erro: `Pagamento baixado, mas o comprovante não foi anexado: ${r.erro}` };
    }
  }
  revalidatePath("/", "layout");
  return { ok: "Pagamento registrado como pago." };
}

/** Baixa de uma parcela (pagamento parcelado). O pagamento fica pago só quando todas as parcelas estiverem pagas. */
export async function registrarBaixaParcela(parcelaId: string, pagamentoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  if (!UUID.test(parcelaId)) return { erro: "Parcela não encontrada." };
  const pagoEm = String(fd.get("pago_em") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pagoEm)) return { erro: "Informe a data do pagamento." };
  const supabase = await createClient();
  const { data: pc, error: erroPc } = await supabase.from("pagamento_parcelas").select("valor_base").eq("id", parcelaId).single();
  if (erroPc || !pc) return { erro: "Parcela não encontrada." };

  // Multa, juros e desconto são informados na baixa; se houver algum, o motivo é obrigatório.
  const valorCampo = (nome: string) => {
    const t = String(fd.get(nome) ?? "").trim();
    if (!t) return 0;
    const n = Number(t.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
  };
  const multa = valorCampo("multa");
  const juros = valorCampo("juros");
  const desconto = valorCampo("desconto");
  if ([multa, juros, desconto].some((v) => Number.isNaN(v))) return { erro: "Multa, juros e desconto devem ser valores em reais." };
  const motivo = String(fd.get("motivo") ?? "").trim();
  const houveAjuste = multa > 0 || juros > 0 || desconto > 0;
  if (houveAjuste && !motivo) return { erro: "Informe o motivo da multa, juros ou desconto." };
  const valorPago = Math.round((Number(pc.valor_base) + multa + juros - desconto) * 100) / 100;
  if (valorPago <= 0) return { erro: "O valor pago precisa ser maior que zero." };

  const partes = [
    String(fd.get("observacao") ?? "").trim(),
    houveAjuste ? `Multa R$ ${multa.toFixed(2)}, juros R$ ${juros.toFixed(2)}, desconto R$ ${desconto.toFixed(2)}. Motivo: ${motivo}` : "",
  ].filter(Boolean);

  const [comprovante] = arquivosDoForm(fd, "comprovante");
  if (comprovante) {
    const e = validarArquivo(comprovante);
    if (e) return { erro: e };
  }
  const { error } = await supabase.rpc("registrar_baixa_parcela", {
    p_parcela_id: parcelaId,
    p_pago_em: pagoEm,
    p_valor_pago: valorPago,
    p_observacao: partes.join(" · ") || undefined,
  });
  if (error) return { erro: mensagemErro(error) };
  // Comprovante da parcela fica anexado ao pagamento
  if (comprovante) {
    const pag = await buscarPagamento(pagamentoId);
    const r = pag ? await enviarDocumento(supabase, pag, "comprovante", comprovante) : { erro: "Pagamento não encontrado." };
    if (r.erro) {
      revalidatePath(`/pagamentos/${pagamentoId}`);
      return { erro: `Parcela registrada como paga, mas o comprovante não foi anexado: ${r.erro}` };
    }
  }
  revalidatePath(`/pagamentos/${pagamentoId}`);
  revalidatePath("/", "layout");
  return { ok: "Parcela registrada como paga." };
}

/** Ações da lista: "Voltar para em aberto" (estorno da baixa do pagamento ou da parcela). */
export async function voltarParaEmAberto(pagamentoId: string, parcelaId: string | null, motivo: string): Promise<{ ok?: string; erro?: string }> {
  await getUsuario();
  if (!UUID.test(pagamentoId) || (parcelaId && !UUID.test(parcelaId))) return { erro: "Lançamento não encontrado." };
  const supabase = await createClient();
  const { error } = parcelaId
    ? await supabase.rpc("estornar_baixa_parcela", { p_parcela_id: parcelaId, p_motivo: motivo })
    : await supabase.rpc("estornar_baixa", { p_id: pagamentoId, p_motivo: motivo });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  return { ok: "Voltou para em aberto." };
}

/** Ações da lista: "Clonar lançamento" — OP vira um novo rascunho; boleto abre a Nova despesa preenchida. */
export async function clonarLancamento(pagamentoId: string): Promise<{ erro?: string } | void> {
  const u = await getUsuario();
  if (!UUID.test(pagamentoId)) return { erro: "Lançamento não encontrado." };
  const supabase = await createClient();
  const { data: p } = await supabase.from("pagamentos").select("id, ordem_id").eq("id", pagamentoId).maybeSingle();
  if (!p) return { erro: "Lançamento não encontrado." };
  if (p.ordem_id) {
    if (!["engenheiro", "financeiro", "suprimentos"].includes(u.perfil)) return { erro: "Seu perfil não cria Ordem de Pagamento." };
    const r = await duplicarOP(p.ordem_id, null);
    return r?.erro ? { erro: r.erro } : undefined;
  }
  if (u.perfil !== "financeiro" && u.perfil !== "suprimentos") return { erro: "Somente o Financeiro e o Suprimentos lançam despesas com boleto." };
  redirect(`/pagamentos/novo?clonar=${pagamentoId}`);
}

/** "Editar parcela": vencimento e valor de uma parcela em aberto. */
export async function editarParcela(pagamentoId: string, parcelaId: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  if (!UUID.test(pagamentoId) || !UUID.test(parcelaId)) return { erro: "Parcela não encontrada." };
  const vencimento = texto(fd, "vencimento");
  const valor = lerValor(texto(fd, "valor"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) return { erro: "Informe o vencimento." };
  if (valor === null) return { erro: "Informe um valor válido (ex.: 1.250,00)." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("editar_parcelas", {
    p_pagamento_id: pagamentoId,
    p_parcelas: [{ id: parcelaId, vencimento, valor }] as never,
    p_motivo: texto(fd, "motivo") || undefined,
  });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  redirect(`/pagamentos/${pagamentoId}?salvo=1`);
}

type AcaoLote = "categoria" | "conta" | "competencia" | "cancelar" | "estornar";

/**
 * Ações em lote nas contas marcadas em Contas a pagar. Cada lançamento passa pelas mesmas regras
 * da ação individual (permissão e situação); o que não puder ser feito volta listado com o motivo.
 */
export async function acaoEmLote(acao: AcaoLote, chaves: string[], dados: { categoria?: string; competencia?: string; motivo?: string; conta?: string }): Promise<{ ok?: string; erro?: string }> {
  await getUsuario();
  const lista = chaves.filter((c) => /^(pag|parc):/.test(c) && UUID.test(c.split(":")[1])).slice(0, 300);
  if (!lista.length) return { erro: "Nenhuma conta selecionada." };
  if (acao === "categoria" && !UUID.test(dados.categoria ?? "")) return { erro: "Escolha a categoria." };
  if (acao === "conta" && !UUID.test(dados.conta ?? "")) return { erro: "Escolha a conta bancária." };
  if (acao === "competencia" && !/^\d{4}-\d{2}-\d{2}$/.test(dados.competencia ?? "")) return { erro: "Informe a data de competência." };
  if ((acao === "cancelar" || acao === "estornar") && (dados.motivo ?? "").trim().length < 3) return { erro: "Informe o motivo." };

  const supabase = await createClient();
  const idsParc = lista.filter((c) => c.startsWith("parc:")).map((c) => c.slice(5));
  const { data: parcelas } = idsParc.length
    ? await supabase.from("pagamento_parcelas").select("id, pagamento_id, numero, status").in("id", idsParc)
    : { data: [] as { id: string; pagamento_id: string; numero: number; status: string }[] };
  const idsPag = [...new Set([...lista.filter((c) => c.startsWith("pag:")).map((c) => c.slice(4)), ...(parcelas ?? []).map((p) => p.pagamento_id)])];
  const { data: pags } = await supabase.from("pagamentos").select("id, numero, status").in("id", idsPag);
  const pagPorId = new Map((pags ?? []).map((p) => [p.id, p]));

  let feitos = 0;
  const erros: string[] = [];
  const falhou = (numero: number | undefined, msg: string) => erros.push(`nº ${numero ?? "?"}: ${msg}`);

  if (acao === "estornar") {
    for (const c of lista) {
      if (c.startsWith("pag:")) {
        const p = pagPorId.get(c.slice(4));
        if (!p) continue;
        if (p.status !== "pago") continue; // só as pagas voltam para em aberto
        const { error } = await supabase.rpc("estornar_baixa", { p_id: p.id, p_motivo: dados.motivo! });
        if (error) falhou(p.numero, mensagemErro(error));
        else feitos++;
      } else {
        const pc = (parcelas ?? []).find((x) => x.id === c.slice(5));
        if (!pc || pc.status !== "pago") continue;
        const { error } = await supabase.rpc("estornar_baixa_parcela", { p_parcela_id: pc.id, p_motivo: dados.motivo! });
        if (error) falhou(pagPorId.get(pc.pagamento_id)?.numero, mensagemErro(error));
        else feitos++;
      }
    }
  } else {
    for (const id of idsPag) {
      const p = pagPorId.get(id);
      if (!p) continue;
      const { error } =
        acao === "categoria"
          ? await supabase.rpc("definir_categoria", { p_pagamento_id: id, p_categoria_id: dados.categoria! })
          : acao === "conta"
            ? await supabase.rpc("definir_conta_bancaria", { p_pagamento_id: id, p_conta_id: dados.conta! })
          : acao === "competencia"
            ? await supabase.rpc("definir_competencia", { p_pagamento_id: id, p_data: dados.competencia! })
            : p.status === "cancelado"
              ? { error: null }
              : await supabase.rpc("cancelar_pagamento", { p_id: id, p_motivo: dados.motivo! });
      if (error) falhou(p.numero, mensagemErro(error));
      else if (!(acao === "cancelar" && p.status === "cancelado")) feitos++;
    }
  }

  revalidatePath("/", "layout");
  const verbo = { categoria: "com a categoria alterada", conta: "com a conta bancária alterada", competencia: "com a competência alterada", cancelar: "cancelado(s)", estornar: "voltaram para em aberto" }[acao];
  const resumo = `${feitos} lançamento(s) ${verbo}.`;
  if (!feitos && !erros.length) return { erro: acao === "estornar" ? "Nenhuma das contas marcadas está paga." : "Nada a alterar nas contas marcadas." };
  return erros.length ? { erro: `${resumo} Não foi possível em: ${erros.join(" · ")}` } : { ok: resumo };
}

/** Ações → "Alterar conta bancária" (ex.: foi paga por outra conta). */
export async function alterarContaBancaria(pagamentoId: string, contaId: string): Promise<{ ok?: string; erro?: string }> {
  await getUsuario();
  if (!UUID.test(pagamentoId) || !UUID.test(contaId)) return { erro: "Escolha a conta bancária." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("definir_conta_bancaria", { p_pagamento_id: pagamentoId, p_conta_id: contaId });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  return { ok: "Conta bancária alterada." };
}
