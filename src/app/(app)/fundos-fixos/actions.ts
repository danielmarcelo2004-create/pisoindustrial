"use server";

import { descartarArquivoEnviado } from "@/lib/storage-limpeza";
import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { hojeISO, lerValor, moeda } from "@/lib/formato";
import { textoDadosBancarios } from "@/lib/fundos";
import { gerarPdfOP, type DadosPdfOP } from "@/lib/pdf-op";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function revalidar(id?: string) {
  revalidatePath("/fundos-fixos");
  if (id) revalidatePath(`/fundos-fixos/${id}`);
}

export async function criarFundo(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  const obra = t(fd, "obra_id");
  const pessoa = t(fd, "pessoa_id");
  const valor = lerValor(t(fd, "valor"));
  if (!UUID.test(obra)) return { erro: "Selecione o centro de custo." };
  if (!UUID.test(pessoa)) return { erro: "Selecione o engenheiro ou Suprimentos responsável pelo fundo." };
  if (valor === null || valor <= 0) return { erro: "Informe o valor do fundo." };
  const conta = t(fd, "conta_id");
  const venc = t(fd, "vencimento");
  if (!UUID.test(conta)) return { erro: "Escolha a conta de onde sai o dinheiro do fundo." };
  if (venc && !/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Data do desembolso inválida." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("criar_fundo_fixo", { p_obra_id: obra, p_pessoa_id: pessoa, p_valor: valor, p_conta_id: conta, ...(venc ? { p_vencimento: venc } : {}) });
  if (error) return { erro: mensagemErro(error) };
  revalidar();
  revalidatePath("/pagamentos");
  return { ok: "Fundo fixo criado. O desembolso entrou em Contas a pagar e a pessoa já pode lançar gastos." };
}

export async function lancarGasto(fundoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("engenheiro", "suprimentos", "administrador", "administrador_master", "financeiro");
  if (!UUID.test(fundoId)) return { erro: "Fundo não encontrado." };
  const valor = lerValor(t(fd, "valor"));
  const data = t(fd, "data_gasto");
  const descricao = t(fd, "descricao");
  if (!descricao) return { erro: "Informe a descrição do gasto." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return { erro: "Informe a data do gasto." };
  if (valor === null || valor <= 0) return { erro: "Informe o valor do gasto." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("lancar_gasto_fundo", { p_fundo_id: fundoId, p_descricao: descricao, p_data: data, p_valor: valor });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  return { ok: "Gasto lançado. Agora anexe o comprovante e assine: o gasto só conta no saldo com o comprovante assinado." };
}

/** A pessoa do fundo solicita o fechamento ao Financeiro (avisa na hora; um pedido por fundo). Só o Financeiro fecha. */
export async function solicitarFechamento(fundoId: string, _: Estado, __: FormData): Promise<Estado> {
  await exigirPerfil("engenheiro", "suprimentos", "administrador", "administrador_master", "financeiro");
  if (!UUID.test(fundoId)) return { erro: "Fundo não encontrado." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("solicitar_fechamento_fundo", { p_fundo_id: fundoId });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  return { ok: "Fechamento solicitado ao Financeiro." };
}

/** A pessoa do fundo informa instituição e conta (agência + conta) ou chave PIX, antes do primeiro gasto. */
export async function informarDadosBancarios(fundoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("engenheiro", "suprimentos", "administrador", "administrador_master", "financeiro");
  if (!UUID.test(fundoId)) return { erro: "Fundo não encontrado." };
  const supabase = await createClient();
  const forma = t(fd, "forma");
  const { error } = await supabase.rpc("informar_dados_bancarios_fundo", {
    p_fundo_id: fundoId,
    p_forma: forma,
    p_banco: t(fd, "banco"),
    p_favorecido: t(fd, "favorecido"),
    p_agencia: t(fd, "agencia") || undefined,
    p_conta: t(fd, "conta") || undefined,
    p_chave_pix: t(fd, "chave_pix") || undefined,
  });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  return { ok: "Dados bancários salvos. Agora você já pode lançar gastos." };
}

/**
 * Ao fechar o fundo: gera a OP (ordem de pagamento, modelo da empresa) com os dados bancários e o valor
 * e anexa ao pagamento criado, para aparecer junto com a despesa em Contas a pagar.
 */
async function anexarOpDoFundo(fundoId: string, pagamentoId: string) {
  const supabase = await createClient();
  const [{ data: f }, { data: pg }, { data: gastos }] = await Promise.all([
    supabase
      .from("fundos_fixos")
      .select("valor, reposicao, reembolso, receb_forma, receb_favorecido, receb_banco, receb_agencia, receb_conta, receb_chave_pix, obra:obras(nome), pessoa:profiles!fundos_fixos_pessoa_id_fkey(nome)")
      .eq("id", fundoId)
      .single(),
    supabase.from("pagamentos").select("numero, obra_id, vencimento, forma_pagamento").eq("id", pagamentoId).single(),
    supabase.from("fundo_gastos").select("descricao, data_gasto, valor").eq("fundo_id", fundoId).eq("status", "aprovado").order("data_gasto"),
  ]);
  if (!f || !pg) throw new Error("dados do fundo não encontrados");
  const obra = f.obra?.nome ?? "";
  const reposicao = Number(f.reposicao ?? 0);
  const reembolso = Number(f.reembolso ?? 0);
  const itens: DadosPdfOP["itens"] = [];
  if (reposicao > 0) itens.push({ descricao: `Reposição dos gastos do fundo fixo (${obra})`, unidade: "UN", quantidade: 1, valorUnitario: reposicao, total: reposicao });
  if (reembolso > 0) itens.push({ descricao: `Reembolso: gastos acima do valor do fundo de ${moeda(Number(f.valor))} (${obra})`, unidade: "UN", quantidade: 1, valorUnitario: reembolso, total: reembolso });
  const lista = (gastos ?? []).slice(0, 4).map((g) => `${g.descricao} ${moeda(Number(g.valor))}`).join("; ");
  const resto = (gastos?.length ?? 0) > 4 ? ` e mais ${(gastos?.length ?? 0) - 4}` : "";
  const dados: DadosPdfOP = {
    numero: `FF-${String(pg.numero).padStart(4, "0")}`,
    rascunho: false,
    dataEmissao: hojeISO(),
    favorecido: f.receb_favorecido ?? f.pessoa?.nome ?? "Fundo fixo",
    cpfCnpj: null,
    numeroNf: null,
    vencimento: pg.vencimento,
    formaPagamento: pg.forma_pagamento,
    dadosBancarios: textoDadosBancarios(f),
    observacoes: `Fundo fixo de ${f.pessoa?.nome ?? ""}: ${gastos?.length ?? 0} gasto(s) aprovado(s). ${lista}${resto}`.trim(),
    desconto: 0,
    centroDeCusto: obra,
    solicitante: f.pessoa?.nome ?? "",
    emitidaEm: new Date().toISOString(),
    itens,
  };
  const bytes = Buffer.from(await gerarPdfOP(dados));
  const caminho = `${pg.obra_id}/${pagamentoId}/${randomUUID()}.pdf`;
  const up = await supabase.storage.from("documentos").upload(caminho, bytes, { contentType: "application/pdf" });
  if (up.error) throw up.error;
  const reg = await supabase.rpc("registrar_documento", {
    p_pagamento_id: pagamentoId,
    p_tipo: "ordem_pagamento",
    p_nome_arquivo: `${dados.numero}.pdf`,
    p_storage_path: caminho,
    p_mime_type: "application/pdf",
    p_tamanho: bytes.length,
    p_sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (reg.error) {
    await descartarArquivoEnviado(caminho);
    throw reg.error;
  }
}

export async function decidirGasto(fundoId: string, gastoId: string, aprovar: boolean, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("administrador", "administrador_master");
  if (!UUID.test(gastoId)) return { erro: "Gasto não encontrado." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("decidir_gasto_fundo", {
    p_gasto_id: gastoId,
    p_aprovar: aprovar,
    p_motivo: aprovar ? undefined : t(fd, "motivo") || undefined,
  });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  // Após decidir, volta à lista: o formulário do gasto some e a confirmação aparece lá.
  redirect(`/fundos-fixos?decidido=${aprovar ? "aprovado" : "recusado"}`);
}

/** O Financeiro recusa o pedido de fechamento: a pessoa do fundo volta a poder lançar gastos. */
export async function recusarFechamento(fundoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(fundoId)) return { erro: "Fundo não encontrado." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("recusar_fechamento_fundo", { p_fundo_id: fundoId, p_motivo: t(fd, "motivo") || undefined });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  return { ok: "Pedido de fechamento recusado: a pessoa já pode lançar gastos de novo." };
}

export async function fecharFundo(fundoId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(fundoId)) return { erro: "Fundo não encontrado." };
  const venc = t(fd, "vencimento");
  if (venc && !/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Vencimento inválido." };
  const supabase = await createClient();
  const modo = t(fd, "modo") === "encerrar" ? "encerrar" : "repor";
  const conta = t(fd, "conta_id");
  const { data, error } = await supabase.rpc("fechar_fundo_fixo", { p_fundo_id: fundoId, p_vencimento: venc || hojeISO(), p_modo: modo, ...(UUID.test(conta) ? { p_conta_id: conta } : {}) });
  if (error) return { erro: mensagemErro(error) };
  // OP em PDF anexada ao pagamento (se o fechamento gerou pagamento). Se falhar, o fechamento vale e avisamos.
  let aviso = "";
  if (data) {
    try {
      await anexarOpDoFundo(fundoId, data as string);
    } catch (e) {
      aviso = `&aviso=${encodeURIComponent("O fundo foi fechado, mas a OP em PDF não foi anexada ao pagamento: " + mensagemErro(e as { message?: string }))}`;
    }
  }
  revalidar(fundoId);
  revalidatePath("/pagamentos");
  revalidatePath("/");
  revalidatePath("/recebimentos");
  redirect(`/fundos-fixos?fechado=${modo === "repor" ? "reposto" : data ? "pagamento" : "saldo"}${aviso}`);
}

export async function excluirGasto(fundoId: string, gastoId: string, _: Estado, __: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(gastoId)) return { erro: "Gasto não encontrado." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("excluir_gasto_fundo", { p_gasto_id: gastoId });
  if (error) return { erro: mensagemErro(error) };
  revalidar(fundoId);
  return { ok: "Gasto excluído." };
}
