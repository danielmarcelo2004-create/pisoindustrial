"use server";

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
    const valor = Number(it.valor_unitario);
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
  if (!FORMAS_PAGAMENTO_ATUAIS.includes(forma)) return { erro: "Escolha PIX ou transferência bancária." };
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
  } else if (paraEnviar && !dadosBancarios) {
    return { erro: "Informe a chave PIX para pagamento antes de gerar a OP." };
  }

  // Desconto é opcional (padrão zero); não pode passar do total dos itens.
  const descontoTxt = t(fd, "desconto");
  const desconto = descontoTxt ? Number(descontoTxt.replace(/\./g, "").replace(",", ".")) : 0;
  if (!Number.isFinite(desconto) || desconto < 0) return { erro: "Desconto inválido." };
  const subtotal = itens.reduce((s, i) => s + Math.round(i.quantidade * i.valor_unitario * 100) / 100, 0);
  if (desconto > subtotal) return { erro: "O desconto não pode ser maior que o total dos itens." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("salvar_op", {
    p_id: (id ?? null) as string,
    p_obra_id: obra,
    p_favorecido: t(fd, "favorecido"),
    p_cpf_cnpj: t(fd, "cpf_cnpj"),
    p_descricao: t(fd, "descricao"),
    p_vencimento: (venc || null) as string,
    p_forma_pagamento: forma,
    p_dados_bancarios: dadosBancarios,
    p_observacoes: t(fd, "observacoes"),
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
  if (fd.get("acao") === "enviar") return enviarOP(r.id as string, null, fd);
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

export async function enviarOP(id: string, _: Estado, fd?: FormData): Promise<Estado> {
  const u = await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const supabase = await createClient();
  const { data: pagId, error } = await supabase.rpc("enviar_op", { p_id: id });
  if (error || !pagId) return { erro: mensagemErro(error) };
  if (fd?.get("assinar") === "on") {
    await supabase.rpc("marcar_assinatura_cadastro", { p_id: pagId as string, p_assinar: true });
  }

  // Gera o PDF oficial (já numerado) e anexa ao pagamento criado.
  const op = await carregarOP(id);
  let aviso = "";
  if (op) {
    try {
      const bytes = Buffer.from(await gerarPdfOP(dadosPdf(op)));
      const caminho = `${op.obra_id}/${pagId}/${randomUUID()}.pdf`;
      const up = await supabase.storage.from("documentos").upload(caminho, bytes, { contentType: "application/pdf" });
      if (up.error) throw up.error;
      const reg = await supabase.rpc("registrar_documento", {
        p_pagamento_id: pagId as string,
        p_tipo: "ordem_pagamento",
        p_nome_arquivo: `${op.numero}.pdf`,
        p_storage_path: caminho,
        p_mime_type: "application/pdf",
        p_tamanho: bytes.length,
        p_sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      if (reg.error) throw reg.error;

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
          p_pagamento_id: pagId as string,
          p_storage_path: caminhoAss,
          p_nome: `${op.numero}-assinado.pdf`,
          p_mime: "application/pdf",
          p_tamanho: assinada.length,
          p_sha256: createHash("sha256").update(assinada).digest("hex"),
        });
        if (conc.error) throw conc.error;
      }
    } catch (e) {
      aviso = `&aviso=${encodeURIComponent("A OP foi enviada, mas o PDF não foi anexado: " + mensagemErro(e as { message?: string }))}`;
    }
  }
  revalidatePath("/", "layout");
  redirect(`/ops/${id}?enviada=1${aviso}`);
}

export async function excluirOP(id: string, _: Estado): Promise<Estado> {
  await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const supabase = await createClient();
  const { error } = await supabase.rpc("excluir_op", { p_id: id });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/ops");
  redirect("/ops?excluida=1");
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
    p_observacoes: [op.observacoes, op.numero ? `Corrige a ${op.numero}.` : null].filter(Boolean).join(" "),
    p_itens: op.ordem_itens.map((i) => ({
      descricao: i.descricao,
      unidade: i.unidade ?? "",
      quantidade: Number(i.quantidade),
      valor_unitario: Number(i.valor_unitario),
    })),
    p_numero_nf: op.numero_nf ?? "",
  });
  if (error) return { erro: mensagemErro(error) };
  redirect(`/ops/${data}/editar`);
}
