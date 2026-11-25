"use server";

import { descartarArquivoEnviado } from "@/lib/storage-limpeza";
import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { carregarOP, dadosPdf } from "@/lib/consultas/ops";
import { mensagemErro, type Estado } from "@/lib/erros";
import { gerarPdfOP } from "@/lib/pdf-op";
import { sobreporAssinatura, type PosAssinatura } from "@/lib/assinatura-op";
import { FORMAS_PAGAMENTO_ATUAIS, type FormaPagamento } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

type ItemOP = { descricao: string; unidade: string; quantidade: number; valor_unitario: number };


function lerItens(fd: FormData): ItemOP[] | string {
  let bruto: unknown;
  try {
    bruto = JSON.parse(t(fd, "itens") || "[]");
  } catch {
    return "Itens inválidos.";
  }
  if (!Array.isArray(bruto) || bruto.length === 0) return "Informe ao menos um item.";
  if (bruto.length > 200) return "Máximo de 200 itens por OP.";
  const itens: ItemOP[] = [];
  for (const [i, b] of bruto.entries()) {
    const it = b as Record<string, unknown>;
    const descricao = String(it.descricao ?? "").trim();
    const quantidade = Number(it.quantidade);
    const valor = it.valor_unitario === null || it.valor_unitario === "" || it.valor_unitario === undefined ? Number.NaN : Number(it.valor_unitario);
    if (!descricao) return `Item ${i + 1}: informe a descrição.`;
    if (!(quantidade > 0)) return `Item ${i + 1}: quantidade inválida.`;
    if (!(valor >= 0)) return `Item ${i + 1}: valor unitário inválido.`;
    itens.push({
      descricao,
      unidade: String(it.unidade ?? "").trim(),
      quantidade,
      valor_unitario: Math.round(valor * 100) / 100,
    });
  }
  return itens;
}

function lerParcelas(fd: FormData): { vencimento: string; valor: number }[] | string {
  let bruto: unknown;
  try {
    bruto = JSON.parse(t(fd, "parcelas_json") || "[]");
  } catch {
    return "Parcelas inválidas.";
  }
  if (!Array.isArray(bruto)) return "Parcelas inválidas.";
  if (bruto.length > 60) return "Máximo de 60 parcelas.";
  if (bruto.length === 1) return "Use uma parcela só como pagamento único (deixe a quantidade em 1).";
  const lista: { vencimento: string; valor: number }[] = [];
  for (const [i, b] of bruto.entries()) {
    const it = b as Record<string, unknown>;
    const vencimento = String(it.vencimento ?? "");
    const valor = Math.round(Number(it.valor) * 100) / 100;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) return `Parcela ${i + 1}: informe o vencimento.`;
    if (!(valor > 0)) return `Parcela ${i + 1}: informe o valor.`;
    lista.push({ vencimento, valor });
  }
  return lista;
}

/** Grava o rascunho (cabeçalho, itens e parcelas). Sem redirecionar: serve ao salvar e à anexação na criação. */
async function gravarRascunho(id: string | null, fd: FormData, paraEnviar = false): Promise<{ id?: string; erro?: string }> {
  const obra = t(fd, "obra_id");
  const forma = t(fd, "forma_pagamento") as FormaPagamento;
  const venc = t(fd, "vencimento");
  if (!UUID.test(obra)) return { erro: "Selecione a obra." };
  if (!t(fd, "favorecido")) return { erro: "Informe o favorecido." };
  if (!t(fd, "descricao")) return { erro: "Informe a descrição." };
  if (!FORMAS_PAGAMENTO_ATUAIS.includes(forma)) return { erro: "Forma de pagamento inválida." };
  if (venc && !/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Vencimento inválido." };
  const itens = lerItens(fd);
  if (typeof itens === "string") return { erro: itens };

  // Dados de pagamento: PIX usa a chave; transferência usa banco, agência e conta (obrigatórios para gerar a OP).
  let dadosBancarios = t(fd, "dados_bancarios");
  if (forma === "transferencia") {
    const banco = t(fd, "banco");
    const agencia = t(fd, "agencia");
    const conta = t(fd, "conta");
    if (paraEnviar && (!banco || !agencia || !conta)) return { erro: "Para transferência bancária, informe banco, agência e conta antes de gerar a OP." };
    dadosBancarios = [banco && `BANCO: ${banco}`, agencia && `AGÊNCIA: ${agencia}`, conta && `CONTA: ${conta}`].filter(Boolean).join("\n");
  } else if (forma === "pix") {
    const banco = t(fd, "banco");
    const chave = t(fd, "chave_pix");
    if (paraEnviar && (!banco || !chave)) return { erro: "Para PIX, informe o banco e a chave PIX antes de gerar a OP." };
    dadosBancarios = [banco && `BANCO: ${banco}`, chave && `CHAVE PIX: ${chave}`].filter(Boolean).join("\n");
  }

  const categoria = t(fd, "categoria_id");
  if (paraEnviar && !UUID.test(categoria)) return { erro: "Escolha a categoria antes de gerar a OP." };
  const contaBancaria = t(fd, "conta_bancaria_id");
  if (paraEnviar && !UUID.test(contaBancaria)) return { erro: "Escolha a conta bancária (de onde sai o pagamento) antes de gerar a OP." };

  // Desconto é opcional (padrão zero); não pode passar do total dos itens.
  const descontoTxt = t(fd, "desconto");
  const desconto = descontoTxt ? Number(descontoTxt.replace(/\./g, "").replace(",", ".")) : 0;
  if (!Number.isFinite(desconto) || desconto < 0) return { erro: "Desconto inválido." };
  const subtotal = itens.reduce((s, i) => s + Math.round(i.quantidade * i.valor_unitario * 100) / 100, 0);
  if (desconto > subtotal) return { erro: "O desconto não pode ser maior que o total dos itens." };

  const supabase = await createClient();
  // A OP tem um campo só (Descrição), que também vai para o PDF. A observação antiga de rascunhos já existentes é mantida.
  const observacaoAtual = id ? (await supabase.from("ordens_pagamento").select("observacoes").eq("id", id).maybeSingle()).data?.observacoes ?? "" : "";
  const { data, error } = await supabase.rpc("salvar_op", {
    p_id: (id ?? null) as string,
    p_obra_id: obra,
    p_favorecido: t(fd, "favorecido"),
    p_cpf_cnpj: t(fd, "cpf_cnpj"),
    p_descricao: t(fd, "descricao"),
    p_vencimento: (venc || null) as string,
    p_forma_pagamento: forma,
    p_dados_bancarios: dadosBancarios,
    p_observacoes: observacaoAtual,
    p_itens: itens,
    p_desconto: desconto,
    p_numero_nf: t(fd, "numero_nf"),
  });
  if (error) return { erro: mensagemErro(error) };

  // Parcelas informadas no formulário (vencimento e valor de cada uma). Uma parcela só = pagamento único.
  const parcelas = lerParcelas(fd);
  if (typeof parcelas === "string") return { erro: parcelas };
  const { error: erroParcelas } = await supabase.rpc("definir_parcelas_op", { p_id: data as string, p_parcelas: parcelas });
  if (erroParcelas) return { erro: mensagemErro(erroParcelas) };

  // OP criada a partir de uma provisão: ao enviar, a provisão vira lançada (gatilho no banco)
  const provisao = t(fd, "provisao_id");
  if (UUID.test(provisao)) {
    const { error: erroProv } = await supabase.rpc("definir_provisao_op", { p_ordem_id: data as string, p_provisao_id: provisao });
    if (erroProv) return { erro: mensagemErro(erroProv) };
  }

  // Data de competência (vem com a data do lançamento; pode ser alterada)
  const competencia = t(fd, "data_competencia");
  if (/^\d{4}-\d{2}-\d{2}$/.test(competencia)) {
    const { error: erroComp } = await supabase.rpc("definir_competencia_op", { p_ordem_id: data as string, p_data: competencia });
    if (erroComp) return { erro: mensagemErro(erroComp) };
  }
  if (UUID.test(categoria)) {
    const { error: erroCat } = await supabase.rpc("definir_categoria_op", { p_ordem_id: data as string, p_categoria_id: categoria });
    if (erroCat) return { erro: mensagemErro(erroCat) };
  }
  if (UUID.test(contaBancaria)) {
    const { error: erroConta } = await supabase.rpc("definir_conta_bancaria_op", { p_ordem_id: data as string, p_conta_id: contaBancaria });
    if (erroConta) return { erro: mensagemErro(erroConta) };
  }

  // Repetição: guardada no rascunho; as provisões nascem no envio
  const repIntervalo = Number(t(fd, "repetir_intervalo") || 0) || null;
  const repVezes = Number(t(fd, "repetir_vezes") || 0) || null;
  // Sem repetição = nulo (a função aceita; o tipo gerado não marca como opcional)
  const { error: erroRep } = await supabase.rpc("definir_repeticao_op", { p_ordem_id: data as string, p_intervalo: repIntervalo as number, p_vezes: repVezes as number });
  if (erroRep) return { erro: mensagemErro(erroRep) };
  return { id: data as string };
}

/** Salva o rascunho a partir da tela (sem trocar de página). Usado antes de anexar ou assinar. */
export async function salvarRascunhoAjax(fd: FormData): Promise<{ id?: string; erro?: string }> {
  await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const idAtual = t(fd, "ordem_id");
  const r = await gravarRascunho(UUID.test(idAtual) ? idAtual : null, fd);
  if (r.id) revalidatePath("/ops");
  return r;
}

export async function salvarOP(id: string | null, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const idAtual = t(fd, "ordem_id");
  // Para gerar a OP (enviar), os dados de pagamento (chave PIX ou banco, agência e conta) são obrigatórios.
  const r = await gravarRascunho(id ?? (UUID.test(idAtual) ? idAtual : null), fd, fd.get("acao") === "enviar");
  if (r.erro) return { erro: r.erro };
  revalidatePath("/ops");
  if (fd.get("acao") === "enviar") {
    const resultado = await enviarOP(r.id as string, null, fd);
    // "Salvar e enviar" que falhou depois de gravar um rascunho NOVO: o formulário não guarda o id e, ao tentar de novo,
    // criaria outro rascunho (o primeiro ficaria órfão). Remove o rascunho criado agora; um rascunho já existente é mantido.
    if (resultado?.erro && !id && !UUID.test(idAtual)) {
      const supabase = await createClient();
      await supabase.rpc("excluir_op", { p_id: r.id as string });
    }
    return resultado;
  }
  // Rascunho salvo: segue para a edição, onde ficam os anexos e a assinatura.
  redirect(`/ops/${r.id}/editar?salva=1`);
}

/** O engenheiro assina a própria OP na solicitação: guarda a posição escolhida (aplicada no envio). */
export async function assinarOPCriador(ordemId: string, pos: PosAssinatura): Promise<{ erro?: string; ok?: boolean }> {
  await exigirPerfil("engenheiro");
  if (!UUID.test(ordemId)) return { erro: "Solicitação não encontrada." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("registrar_assinatura_criador", { p_ordem_id: ordemId, p_pos: pos });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath(`/ops/${ordemId}/editar`);
  return { ok: true };
}

type ClienteSupabase = Awaited<ReturnType<typeof createClient>>;
type UsuarioOP = Awaited<ReturnType<typeof exigirPerfil>>;
type OPCarregada = NonNullable<Awaited<ReturnType<typeof carregarOP>>>;

/**
 * Gera o PDF oficial da OP (já numerada) e anexa ao pagamento. Se quem envia é o engenheiro que criou a OP e
 * assinou na solicitação, a assinatura é aplicada ao PDF. Lança erro se algum passo falhar (quem chama decide o aviso).
 */
async function anexarPdfOficialDaOP(supabase: ClienteSupabase, u: UsuarioOP, op: OPCarregada, pagId: string): Promise<void> {
  const bytes = Buffer.from(await gerarPdfOP(dadosPdf(op)));
  const caminho = `${op.obra_id}/${pagId}/${randomUUID()}.pdf`;
  const up = await supabase.storage.from("documentos").upload(caminho, bytes, { contentType: "application/pdf" });
  if (up.error) throw up.error;
  const reg = await supabase.rpc("registrar_documento", {
    p_pagamento_id: pagId,
    p_tipo: "ordem_pagamento",
    p_nome_arquivo: `${op.numero}.pdf`,
    p_storage_path: caminho,
    p_mime_type: "application/pdf",
    p_tamanho: bytes.length,
    p_sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (reg.error) {
    await descartarArquivoEnviado(caminho);
    throw reg.error;
  }

  // Engenheiro que criou a OP: a assinatura feita na solicitação é aplicada ao PDF oficial (já numerado).
  if (u.perfil === "engenheiro" && op.assinatura_criador_pos) {
    const { data: perfil } = await supabase.from("profiles").select("assinatura_path").eq("id", u.id).single();
    if (!perfil?.assinatura_path) throw new Error("cadastre sua assinatura em Minha assinatura");
    const dl = await supabase.storage.from("assinaturas").download(perfil.assinatura_path);
    if (dl.error || !dl.data) throw new Error("não foi possível ler sua assinatura");
    const assinada = Buffer.from(
      await sobreporAssinatura(new Uint8Array(bytes), new Uint8Array(await dl.data.arrayBuffer()), op.assinatura_criador_pos as PosAssinatura),
    );
    const caminhoAss = `${op.obra_id}/${pagId}/${randomUUID()}.pdf`;
    const upAss = await supabase.storage.from("documentos").upload(caminhoAss, assinada, { contentType: "application/pdf" });
    if (upAss.error) throw upAss.error;
    const conc = await supabase.rpc("concluir_criacao_assinada", {
      p_pagamento_id: pagId,
      p_storage_path: caminhoAss,
      p_nome: `${op.numero}-assinado.pdf`,
      p_mime: "application/pdf",
      p_tamanho: assinada.length,
      p_sha256: createHash("sha256").update(assinada).digest("hex"),
    });
    if (conc.error) {
      await descartarArquivoEnviado(caminhoAss);
      throw conc.error;
    }
  }
}

export async function enviarOP(id: string, _: Estado, _fd?: FormData): Promise<Estado> {
  const u = await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const supabase = await createClient();
  const { data: pagId, error } = await supabase.rpc("enviar_op", { p_id: id });
  if (error || !pagId) return { erro: mensagemErro(error) };

  // Gera o PDF oficial (já numerado) e anexa ao pagamento criado.
  const op = await carregarOP(id);
  let aviso = "";
  if (op) {
    try {
      await anexarPdfOficialDaOP(supabase, u, op, pagId as string);
    } catch (e) {
      aviso = `&aviso=${encodeURIComponent("A OP foi enviada, mas o PDF não foi anexado (use \"Gerar PDF da OP\" no pagamento): " + mensagemErro(e as { message?: string }))}`;
    }
  }
  // Repetição configurada na OP: as próximas ocorrências viram provisões
  if (op?.repetir_intervalo && op.repetir_vezes) {
    const { error: erroRep } = await supabase.rpc("criar_repeticoes", { p_pagamento_id: pagId as string, p_intervalo: op.repetir_intervalo, p_vezes: op.repetir_vezes });
    if (erroRep) aviso += `&aviso=${encodeURIComponent("As repetições não foram criadas: " + mensagemErro(erroRep))}`;
  }
  revalidatePath("/", "layout");
  // A Ordem de Pagamento agora vive em Pagamentos: depois do envio, abre o pagamento criado.
  redirect(`/pagamentos/${pagId}?criado=1${aviso}`);
}

export async function excluirOP(id: string, _: Estado): Promise<Estado> {
  await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const supabase = await createClient();
  const { error } = await supabase.rpc("excluir_op", { p_id: id });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/ops");
  redirect("/pagamentos?excluida=1");
}

/** Cria um novo rascunho a partir de uma OP (ex.: rejeitada, para corrigir e reenviar). */
export async function duplicarOP(id: string, _: Estado): Promise<Estado> {
  await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const op = await carregarOP(id);
  if (!op) return { erro: "Solicitação não encontrada." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("salvar_op", {
    p_id: null as unknown as string,
    p_obra_id: op.obra_id,
    p_favorecido: op.favorecido,
    p_cpf_cnpj: op.cpf_cnpj ?? "",
    p_descricao: op.descricao,
    p_vencimento: op.vencimento as string,
    p_forma_pagamento: op.forma_pagamento,
    p_dados_bancarios: op.dados_bancarios ?? "",
    // A observação vai para o PDF: a cópia mantém a observação original (sem "Corrige a OP-…").
    p_observacoes: op.observacoes ?? "",
    p_itens: op.ordem_itens.map((i) => ({
      descricao: i.descricao,
      unidade: i.unidade ?? "",
      quantidade: Number(i.quantidade),
      valor_unitario: Number(i.valor_unitario),
    })),
    p_numero_nf: op.numero_nf ?? "",
    p_desconto: Number(op.desconto ?? 0),
  });
  if (error) return { erro: mensagemErro(error) };
  // A cópia leva também parcelas, categoria, conta, competência e repetição da OP original.
  // Se alguma dessas partes não for copiada, o rascunho avisa o que ficou de fora (nada some em silêncio).
  const novaId = data as string;
  const naoCopiados: string[] = [];
  const tenta = async (nome: string, chamada: PromiseLike<{ error: { message?: string } | null }>) => {
    const { error: e } = await chamada;
    if (e) naoCopiados.push(nome);
  };
  if ((op.ordem_parcelas?.length ?? 0) >= 2) {
    await tenta("parcelas", supabase.rpc("definir_parcelas_op", {
      p_id: novaId,
      p_parcelas: op.ordem_parcelas.map((pc) => ({ vencimento: pc.vencimento, valor: Number(pc.valor) })),
    }));
  }
  if (op.categoria_id) await tenta("categoria", supabase.rpc("definir_categoria_op", { p_ordem_id: novaId, p_categoria_id: op.categoria_id }));
  if (op.conta_bancaria_id) await tenta("conta bancária", supabase.rpc("definir_conta_bancaria_op", { p_ordem_id: novaId, p_conta_id: op.conta_bancaria_id }));
  if (op.data_competencia) await tenta("competência", supabase.rpc("definir_competencia_op", { p_ordem_id: novaId, p_data: op.data_competencia }));
  if (op.repetir_intervalo && op.repetir_vezes) {
    await tenta("repetição", supabase.rpc("definir_repeticao_op", { p_ordem_id: novaId, p_intervalo: op.repetir_intervalo, p_vezes: op.repetir_vezes }));
  }
  if (naoCopiados.length) redirect(`/ops/${novaId}/editar?aviso=${encodeURIComponent(`A cópia foi criada, mas não copiou: ${naoCopiados.join(", ")}. Confira e preencha.`)}`);
  redirect(`/ops/${novaId}/editar`);
}

/**
 * OP enviada sem o PDF oficial (o envio vale, mas a geração/anexo do PDF falhou): gera e anexa de novo, sem duplicar
 * (se o pagamento já tem o PDF da OP, não faz nada). Quem envia a OP é quem pode refazer, e o Financeiro/Suprimentos.
 */
export async function gerarPdfDaOP(ordemId: string, _: Estado): Promise<Estado> {
  const u = await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  if (!UUID.test(ordemId)) return { erro: "OP não encontrada." };
  const op = await carregarOP(ordemId);
  const pag = Array.isArray(op?.pagamento) ? op?.pagamento[0] : op?.pagamento;
  if (!op || !pag) return { erro: "OP não encontrada ou ainda sem pagamento." };
  if (op.status === "em_elaboracao") return { erro: "A OP ainda é um rascunho: envie antes de gerar o PDF." };
  const supabase = await createClient();
  const { data: ja } = await supabase.from("documentos").select("id").eq("pagamento_id", pag.id).eq("tipo", "ordem_pagamento").eq("ativo", true).limit(1);
  if (ja?.length) return { ok: "A OP já tem o PDF oficial anexado." };
  try {
    await anexarPdfOficialDaOP(supabase, u, op, pag.id);
  } catch (e) {
    return { erro: "Não foi possível gerar o PDF da OP: " + mensagemErro(e as { message?: string }) };
  }
  revalidatePath("/", "layout");
  return { ok: "PDF oficial da OP gerado e anexado ao pagamento." };
}
