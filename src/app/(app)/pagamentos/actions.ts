"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUsuario } from "@/lib/auth";
import { arquivosDoForm, enviarDocumento, validarArquivo } from "@/lib/documentos";
import { mensagemErro, type Estado } from "@/lib/erros";
import { lerValor } from "@/lib/formato";
import { FORMAS_PAGAMENTO, TIPOS_DOCUMENTO, type FormaPagamento, type TipoDocumento } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

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
  const { data } = await supabase.from("pagamentos").select("id, obra_id, status").eq("id", id).maybeSingle();
  return data;
}

export async function criarPagamento(_: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const obra = texto(fd, "obra_id");
  if (!UUID.test(obra)) return { erro: "Selecione a obra." };
  const lido = lerDadosPagamento(fd);
  if ("erro" in lido) return { erro: lido.erro };

  const anexos: { tipo: TipoDocumento; arquivo: File }[] = [
    ...arquivosDoForm(fd, "boleto").map((arquivo) => ({ tipo: "boleto" as const, arquivo })),
    ...arquivosDoForm(fd, "nota_fiscal").map((arquivo) => ({ tipo: "nota_fiscal" as const, arquivo })),
    ...arquivosDoForm(fd, "outros").map((arquivo) => ({ tipo: "outro" as const, arquivo })),
  ];
  for (const a of anexos) {
    const e = validarArquivo(a.arquivo);
    if (e) return { erro: e };
  }

  const supabase = await createClient();
  const { data: id, error } = await supabase.rpc("criar_pagamento", { p_obra_id: obra, ...lido.dados });
  if (error || !id) return { erro: mensagemErro(error) };

  const falhas: string[] = [];
  for (const a of anexos) {
    const r = await enviarDocumento(supabase, { id, obra_id: obra }, a.tipo, a.arquivo);
    if (r.erro) falhas.push(r.erro);
    if (r.aviso) falhas.push(r.aviso);
  }

  revalidatePath("/", "layout");
  redirect(`/pagamentos/${id}?${falhas.length ? "aviso=" + encodeURIComponent(falhas.join(" ")) : "criado=1"}`);
}

export async function atualizarPagamento(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await getUsuario();
  const p = await buscarPagamento(id);
  if (!p) return { erro: "Pagamento não encontrado." };
  const lido = lerDadosPagamento(fd);
  if ("erro" in lido) return { erro: lido.erro };

  const supabase = await createClient();
  const { error } = await supabase.rpc("atualizar_pagamento", {
    p_id: id,
    ...lido.dados,
    p_motivo: texto(fd, "motivo"),
    p_obra_id: texto(fd, "obra_id") || undefined,
  });
  if (error) return { erro: mensagemErro(error) };
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
  revalidatePath("/", "layout");
  return { ok: "Pagamento cancelado." };
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
