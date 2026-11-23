"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getUsuario } from "@/lib/auth";
import { mensagemErro } from "@/lib/erros";
import { decodificarOfx, lerOfx, normalizarBanco, normalizarConta } from "@/lib/ofx";
import { createClient } from "@/lib/supabase/server";
import { arquivosDoForm, enviarDocumento, validarArquivo } from "@/lib/documentos";
import { lerValor } from "@/lib/formato";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLASSES = ["tarifa", "aplicacao", "entrada", "transferencia", "cartao", "imposto", "emprestimo", "outro"];
type Resultado = { erro?: string; ok?: string };

async function soFinanceiro() {
  const u = await getUsuario();
  return u.perfil === "financeiro";
}

/** Importa um ou mais arquivos OFX. A conta é reconhecida pelo arquivo (banco, agência e conta). */
export async function importarExtrato(_: Resultado | null, fd: FormData): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro importa extratos." };
  const arquivos = fd.getAll("arquivo").filter((f): f is File => f instanceof File && f.size > 0);
  if (!arquivos.length) return { erro: "Escolha o arquivo OFX do extrato." };
  const contaEsperada = String(fd.get("conta_id") ?? "");
  const supabase = await createClient();
  let esperada: { banco: string; agencia: string; conta: string; nome: string } | null = null;
  if (UUID.test(contaEsperada)) {
    const { data } = await supabase.from("contas_bancarias").select("banco, agencia, conta, nome").eq("id", contaEsperada).maybeSingle();
    esperada = data;
  }
  const resumo: string[] = [];
  let destino = "";
  for (const f of arquivos) {
    if (f.size > 5 * 1024 * 1024) return { erro: `${f.name}: arquivo maior que 5 MB.` };
    if (!/\.ofx$/i.test(f.name)) return { erro: `${f.name}: envie o extrato no formato OFX (exporte do internet banking como OFX/Money).` };
    let ext;
    try {
      ext = lerOfx(decodificarOfx(new Uint8Array(await f.arrayBuffer())));
    } catch (e) {
      return { erro: `${f.name}: ${(e as Error).message}` };
    }
    const banco = normalizarBanco(ext.banco);
    const agencia = normalizarConta(ext.agencia);
    const conta = normalizarConta(ext.conta);
    // Importando "nesta conta": o arquivo precisa ser dela
    if (esperada && (esperada.banco !== banco || esperada.conta !== conta || (esperada.agencia && agencia && esperada.agencia !== agencia))) {
      return { erro: `${f.name} é de outra conta (banco ${banco}, ${agencia ? `ag. ${agencia}, ` : ""}conta ${conta}), não de “${esperada.nome}”. Nada foi importado.` };
    }
    if (!ext.linhas.length) {
      resumo.push(`${f.name}: nenhum lançamento no período`);
      continue;
    }
    const { data, error } = await supabase.rpc("importar_extrato", {
      p_banco: banco,
      p_agencia: agencia,
      p_conta: conta,
      p_arquivo: f.name,
      p_inicio: ext.inicio as string,
      p_fim: ext.fim as string,
      p_saldo: ext.saldo as number,
      p_saldo_em: ext.saldoEm as string,
      p_linhas: ext.linhas,
    });
    if (error) return { erro: `${f.name}: ${mensagemErro(error)}` };
    const r = data as { conta_id: string; novas: number; repetidas: number };
    destino = r.conta_id;
    resumo.push(`${f.name}: ${r.novas} lançamento(s) novo(s)${r.repetidas ? `, ${r.repetidas} já importado(s) antes` : ""}`);
  }
  revalidatePath("/contas-bancarias");
  redirect(`/contas-bancarias?conta=${destino || contaEsperada}&importado=${encodeURIComponent(resumo.join(" · "))}`);
}

export async function conciliar(linhaId: string, itens: { tipo: "pagamento" | "parcela"; id: string }[], diferenca: "desconto" | "saldo" | "juros" | "encargos" | null): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro faz a conciliação." };
  if (!UUID.test(linhaId) || !itens.length || itens.some((i) => !UUID.test(i.id) || !["pagamento", "parcela"].includes(i.tipo))) return { erro: "Seleção inválida." };
  if (diferenca !== null && !["desconto", "saldo", "juros", "encargos"].includes(diferenca)) return { erro: "Diferença inválida." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("conciliar_linha", { p_linha_id: linhaId, p_itens: itens, p_diferenca: diferenca as string });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/contas-bancarias");
  revalidatePath("/pagamentos");
  return { ok: "Conciliado." };
}

export async function desfazer(linhaId: string, voltarAberto: boolean, motivo: string): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro desfaz conciliações." };
  if (!UUID.test(linhaId)) return { erro: "Lançamento inválido." };
  if (motivo.trim().length < 3) return { erro: "Informe o motivo." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("desfazer_conciliacao", { p_linha_id: linhaId, p_voltar_aberto: voltarAberto, p_motivo: motivo.trim() });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/contas-bancarias");
  revalidatePath("/pagamentos");
  return { ok: "Conciliação desfeita." };
}

export async function arquivar(ids: string[], classificacao: string, observacao = ""): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro arquiva lançamentos." };
  if (!ids.length || ids.some((i) => !UUID.test(i)) || !CLASSES.includes(classificacao)) return { erro: "Seleção inválida." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("arquivar_linhas", { p_ids: ids, p_classificacao: classificacao, p_observacao: observacao });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/contas-bancarias");
  return { ok: `${data} lançamento(s) arquivado(s).` };
}

export async function restaurar(id: string): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro restaura lançamentos." };
  if (!UUID.test(id)) return { erro: "Lançamento inválido." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("restaurar_linha", { p_id: id });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/contas-bancarias");
  return { ok: "Lançamento voltou para as pendentes." };
}

export async function renomearConta(id: string, nome: string): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro renomeia contas." };
  if (!UUID.test(id) || !nome.trim()) return { erro: "Informe o nome." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("renomear_conta_bancaria", { p_id: id, p_nome: nome.trim() });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/contas-bancarias");
  return { ok: "Nome alterado." };
}

/** Cadastra uma conta bancária à mão (o extrato importado depois é reconhecido pela conta). */
export async function criarContaBancaria(_: Resultado | null, fd: FormData): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro cadastra contas bancárias." };
  const nome = String(fd.get("nome") ?? "").trim();
  const banco = String(fd.get("banco") === "outro" ? fd.get("banco_outro") ?? "" : fd.get("banco") ?? "").trim();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("criar_conta_bancaria", {
    p_nome: nome,
    p_banco: banco,
    p_agencia: String(fd.get("agencia") ?? ""),
    p_conta: String(fd.get("conta") ?? ""),
  });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  redirect(`/contas-bancarias?conta=${data}&criada=1`);
}

const FORMAS = ["boleto", "pix", "transferencia", "dinheiro", "cartao", "outro", "cheque"];
type DadosLancamento = { obra: string; categoria: string; descricao: string; fornecedor?: string; competencia?: string; forma?: string; valor?: number | null; juros?: number; multa?: number; desconto?: number; observacoes?: string };

async function lancar(linhaId: string, d: DadosLancamento) {
  if (!UUID.test(linhaId)) return { erro: "Lançamento inválido." };
  if (!UUID.test(d.obra)) return { erro: "Escolha o centro de custo." };
  if (!UUID.test(d.categoria)) return { erro: "Escolha a categoria." };
  if (!d.descricao.trim()) return { erro: "Informe a descrição." };
  if (d.fornecedor && !UUID.test(d.fornecedor)) return { erro: "Fornecedor inválido." };
  if (d.competencia && !/^\d{4}-\d{2}-\d{2}$/.test(d.competencia)) return { erro: "Data de competência inválida." };
  if (d.forma && !FORMAS.includes(d.forma)) return { erro: "Forma de pagamento inválida." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("criar_lancamento_conciliacao", {
    p_linha_id: linhaId,
    p_obra_id: d.obra,
    p_categoria_id: d.categoria,
    p_descricao: d.descricao.trim(),
    p_fornecedor_id: (d.fornecedor || null) as string,
    p_competencia: (d.competencia || null) as string,
    p_forma: (d.forma || null) as "outro",
    p_valor: (d.valor ?? null) as number,
    p_juros: d.juros ?? 0,
    p_multa: d.multa ?? 0,
    p_desconto: d.desconto ?? 0,
    p_observacoes: (d.observacoes ?? "").trim(),
  });
  if (error) return { erro: mensagemErro(error) };
  return { id: data as string, supabase };
}

/** "Novo lançamento" direto no cartão: cria a despesa já paga e conciliada (sem aprovação; avisa quem aprova). */
export async function novoLancamento(linhaId: string, d: DadosLancamento): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro faz a conciliação." };
  const r = await lancar(linhaId, d);
  if ("erro" in r && r.erro) return { erro: r.erro };
  revalidatePath("/contas-bancarias");
  revalidatePath("/pagamentos");
  return { ok: "Lançamento criado e conciliado." };
}

/** "Completar informações": o mesmo lançamento com competência, forma, juros/multa/desconto, observações e anexos. */
export async function novoLancamentoCompleto(linhaId: string, _: Resultado | null, fd: FormData): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro faz a conciliação." };
  const t = (k: string) => String(fd.get(k) ?? "").trim();
  // Campo vazio = zero (juros/multa/desconto) ou "o valor do banco" (valor); preenchido e inválido = erro
  const ler = (k: string) => (t(k) ? lerValor(t(k)) : undefined);
  const valores = { valor: ler("valor"), juros: ler("juros"), multa: ler("multa"), desconto: ler("desconto") };
  if (Object.values(valores).some((v) => v === null)) return { erro: "Valores inválidos (use o formato 1.234,56)." };
  const arquivos = arquivosDoForm(fd, "anexos");
  for (const a of arquivos) {
    const e = validarArquivo(a);
    if (e) return { erro: e };
  }
  const r = await lancar(linhaId, {
    obra: t("obra_id"),
    categoria: t("categoria_id"),
    descricao: t("descricao"),
    fornecedor: t("fornecedor_id"),
    competencia: t("data_competencia"),
    forma: t("forma_pagamento"),
    valor: valores.valor ?? null,
    juros: valores.juros ?? 0,
    multa: valores.multa ?? 0,
    desconto: valores.desconto ?? 0,
    observacoes: t("observacoes"),
  });
  if ("erro" in r && r.erro) return { erro: r.erro };
  const { id, supabase } = r as { id: string; supabase: Awaited<ReturnType<typeof createClient>> };
  const avisos: string[] = [];
  if (arquivos.length) {
    const { data: p } = await supabase.from("pagamentos").select("obra_id").eq("id", id).single();
    for (const a of arquivos) {
      const e = await enviarDocumento(supabase, { id, obra_id: p!.obra_id }, "comprovante", a);
      if (e.erro) avisos.push(`${a.name}: ${e.erro}`);
    }
  }
  revalidatePath("/contas-bancarias");
  revalidatePath("/pagamentos");
  return avisos.length ? { ok: "Lançamento criado e conciliado.", erro: `Mas nem todos os anexos foram salvos: ${avisos.join(" · ")}` } : { ok: "Lançamento criado e conciliado." };
}

/** "Nova transferência": saída para outra conta da empresa (ou entrada vinda dela). */
export async function novaTransferencia(linhaId: string, outraConta: string, descricao: string): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro faz a conciliação." };
  if (!UUID.test(linhaId) || !UUID.test(outraConta)) return { erro: "Escolha a outra conta." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("criar_transferencia", { p_linha_id: linhaId, p_outra_conta: outraConta, p_descricao: descricao });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/contas-bancarias");
  return { ok: "Transferência registrada." };
}

export async function conciliarTransferencia(linhaId: string, transferenciaId: string): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro faz a conciliação." };
  if (!UUID.test(linhaId) || !UUID.test(transferenciaId)) return { erro: "Seleção inválida." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("conciliar_transferencia", { p_linha_id: linhaId, p_transferencia_id: transferenciaId });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/contas-bancarias");
  return { ok: "Transferência conciliada." };
}

/** Estorno: concilia a entrada com a saída que ela devolve (se a saída já estava conciliada, a conta volta para em aberto). */
export async function conciliarEstorno(creditoId: string, debitoId: string): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro faz a conciliação." };
  if (!UUID.test(creditoId) || !UUID.test(debitoId)) return { erro: "Escolha a saída estornada." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("conciliar_estorno", { p_credito: creditoId, p_debito: debitoId });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  return { ok: "Estorno conciliado." };
}

/** Conta de investimento (ex.: BB Rende Fácil): sem extrato próprio; recebe as aplicações e devolve os resgates. */
export async function criarContaInvestimento(_: Resultado | null, fd: FormData): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro cadastra contas bancárias." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("criar_conta_investimento", { p_nome: String(fd.get("nome") ?? "").trim(), p_banco: String(fd.get("banco") ?? "") });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  const volta = String(fd.get("voltar") ?? "");
  redirect(UUID.test(volta) ? `/contas-bancarias?conta=${volta}` : `/contas-bancarias?conta=${data}&criada=1`);
}

type DadosRecebimento = { obra: string; categoria: string; cliente: string; descricao: string; competencia?: string; observacoes?: string };

/** "Novo lançamento" numa entrada do extrato: recebimento já recebido (Contas a receber). */
export async function novoRecebimento(linhaId: string, d: DadosRecebimento): Promise<Resultado> {
  if (!(await soFinanceiro())) return { erro: "Somente o Financeiro faz a conciliação." };
  if (!UUID.test(linhaId)) return { erro: "Lançamento inválido." };
  if (!UUID.test(d.obra)) return { erro: "Escolha o centro de custo." };
  if (!UUID.test(d.categoria)) return { erro: "Escolha a categoria de receita." };
  if (!d.cliente.trim()) return { erro: "Informe o cliente." };
  if (!d.descricao.trim()) return { erro: "Informe a descrição." };
  if (d.competencia && !/^\d{4}-\d{2}-\d{2}$/.test(d.competencia)) return { erro: "Data de competência inválida." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("criar_recebimento_conciliacao", {
    p_linha_id: linhaId,
    p_obra_id: d.obra,
    p_categoria_id: d.categoria,
    p_cliente: d.cliente,
    p_descricao: d.descricao,
    ...(d.competencia ? { p_competencia: d.competencia } : {}),
    ...(d.observacoes ? { p_observacoes: d.observacoes } : {}),
  });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  return { ok: "Recebimento lançado." };
}
