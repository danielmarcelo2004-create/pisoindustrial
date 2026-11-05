"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { carregarOP, dadosPdf } from "@/lib/consultas/ops";
import { mensagemErro, type Estado } from "@/lib/erros";
import { gerarPdfOP } from "@/lib/pdf-op";
import { FORMAS_PAGAMENTO, type FormaPagamento } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

type ItemOP = { descricao: string; unidade: string; quantidade: number; valor_unitario: number };

/** "1.234,56" → 1234.56; vazio = 0; inválido = null. */
function dinheiro(s: string): number | null {
  const x = s.trim();
  if (!x) return 0;
  const n = x.includes(",") ? Number(x.replace(/\./g, "").replace(",", ".")) : Number(x);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

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

export async function salvarOP(id: string | null, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const obra = t(fd, "obra_id");
  const forma = t(fd, "forma_pagamento") as FormaPagamento;
  const venc = t(fd, "vencimento");
  if (!UUID.test(obra)) return { erro: "Selecione a obra." };
  if (!t(fd, "favorecido")) return { erro: "Informe o favorecido." };
  if (!t(fd, "descricao")) return { erro: "Informe a descrição." };
  if (!(forma in FORMAS_PAGAMENTO)) return { erro: "Forma de pagamento inválida." };
  if (venc && !/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Vencimento inválido." };
  const itens = lerItens(fd);
  if (typeof itens === "string") return { erro: itens };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("salvar_op", {
    p_id: (id ?? null) as string,
    p_obra_id: obra,
    p_favorecido: t(fd, "favorecido"),
    p_cpf_cnpj: t(fd, "cpf_cnpj"),
    p_descricao: t(fd, "descricao"),
    p_vencimento: (venc || null) as string,
    p_forma_pagamento: forma,
    p_dados_bancarios: t(fd, "dados_bancarios"),
    p_observacoes: t(fd, "observacoes"),
    p_itens: itens,
    p_numero_nf: t(fd, "numero_nf"),
  });
  if (error) return { erro: mensagemErro(error) };

  revalidatePath("/ops");
  const destino = `/ops/${data}`;
  if (fd.get("acao") === "enviar") return enviarOP(data as string, null);
  redirect(`${destino}?salva=1`);
}

export async function enviarOP(id: string, _: Estado): Promise<Estado> {
  await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const supabase = await createClient();
  const { data: pagId, error } = await supabase.rpc("enviar_op", { p_id: id });
  if (error || !pagId) return { erro: mensagemErro(error) };

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
