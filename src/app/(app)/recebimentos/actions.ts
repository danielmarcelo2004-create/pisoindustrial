"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";
import { registrarNotaMedicao } from "../notas-medicao/actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Edita descrição, cliente, centro de custo, categoria, competência e observações (Financeiro e master). */
export async function editarRecebimento(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "administrador_master");
  if (!UUID.test(id)) return { erro: "Recebimento não encontrado." };
  const obra = t(fd, "obra_id");
  const categoria = t(fd, "categoria_id");
  const competencia = t(fd, "competencia");
  if (!UUID.test(obra)) return { erro: "Escolha o centro de custo." };
  if (categoria && !UUID.test(categoria)) return { erro: "Categoria inválida." };
  if (competencia && !/^\d{4}-\d{2}-\d{2}$/.test(competencia)) return { erro: "Data de competência inválida." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("editar_recebimento", {
    p_id: id,
    p_obra_id: obra,
    p_categoria_id: (categoria || null) as string,
    p_cliente: t(fd, "cliente"),
    p_descricao: t(fd, "descricao"),
    p_competencia: (competencia || null) as string,
    p_observacoes: t(fd, "observacoes"),
  });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/recebimentos", "layout");
  return { ok: "Recebimento atualizado." };
}

/** Anexa a nota de medição (do mesmo centro de custo) ou retira, com nota vazia. */
export async function vincularNota(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "administrador_master");
  const nota = t(fd, "nota_id");
  if (!UUID.test(id) || (nota && !UUID.test(nota))) return { erro: "Seleção inválida." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("vincular_nota_medicao", { p_recebimento_id: id, p_nota_id: (nota || null) as string });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/recebimentos", "layout");
  return { ok: nota ? "Nota de medição anexada." : "Nota de medição retirada." };
}

/** Envia a nota de medição aqui mesmo (do centro de custo do recebimento) e já anexa ao recebimento. */
export async function enviarNotaNoRecebimento(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  if (!UUID.test(id)) return { erro: "Recebimento não encontrado." };
  const supabase = await createClient();
  const { data: r } = await supabase.from("recebimentos").select("obra_id, status").eq("id", id).maybeSingle();
  if (!r) return { erro: "Recebimento não encontrado." };
  if (r.status === "cancelado") return { erro: "Recebimento cancelado não pode ser alterado." };
  fd.set("obra_id", r.obra_id);
  const nota = await registrarNotaMedicao(fd);
  if (nota.erro || !nota.id) return { erro: nota.erro ?? "Não foi possível enviar a nota." };
  const { error } = await supabase.rpc("vincular_nota_medicao", { p_recebimento_id: id, p_nota_id: nota.id });
  if (error) return { erro: "A nota foi registrada em Notas de medição, mas não foi anexada: " + mensagemErro(error) };
  revalidatePath("/recebimentos", "layout");
  revalidatePath("/notas-medicao");
  return { ok: "Nota de medição enviada e anexada." };
}

const num = (v: string) => (v.trim() ? Number(v.replace(/\./g, "").replace(",", ".")) : NaN);

/** "+ Nova receita": recebimento em aberto, lançado à mão (Financeiro e master). */
export async function criarReceita(_: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "administrador_master");
  const obra = t(fd, "obra_id");
  const categoria = t(fd, "categoria_id");
  const conta = t(fd, "conta_id");
  const valor = num(t(fd, "valor"));
  const venc = t(fd, "vencimento");
  const comp = t(fd, "competencia");
  if (!UUID.test(obra)) return { erro: "Escolha o centro de custo." };
  if (categoria && !UUID.test(categoria)) return { erro: "Categoria inválida." };
  if (!(valor > 0)) return { erro: "Informe o valor." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Informe o vencimento." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("criar_recebimento", {
    p_obra_id: obra,
    p_categoria_id: (categoria || null) as string,
    p_cliente: t(fd, "cliente"),
    p_descricao: t(fd, "descricao"),
    p_valor: valor,
    p_vencimento: venc,
    ...(/^\d{4}-\d{2}-\d{2}$/.test(comp) ? { p_competencia: comp } : {}),
    ...(UUID.test(conta) ? { p_conta_id: conta } : {}),
    ...(t(fd, "observacoes") ? { p_observacoes: t(fd, "observacoes") } : {}),
  });
  if (error || !data) return { erro: mensagemErro(error) };
  revalidatePath("/recebimentos", "layout");
  return { ok: "Receita lançada.", dados: { id: data as string } };
}

export async function cancelarReceita(id: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "administrador_master");
  if (!UUID.test(id)) return { erro: "Recebimento não encontrado." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancelar_recebimento", { p_id: id, p_motivo: t(fd, "motivo") });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/recebimentos", "layout");
  return { ok: "Receita cancelada." };
}

/** Nota de medição › receita (valor total) + imposto retido (a pagar) + imposto devido (pago, baixa manual). */
export async function lancarMedicao(notaId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro", "administrador_master");
  const conta = t(fd, "conta_id");
  const catR = t(fd, "categoria_receita");
  const catI = t(fd, "categoria_imposto");
  const venc = t(fd, "vencimento");
  const aliq = num(t(fd, "aliquota"));
  if (!UUID.test(notaId)) return { erro: "Nota não encontrada." };
  if (!UUID.test(conta)) return { erro: "Escolha a conta onde o dinheiro vai cair." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { erro: "Informe o vencimento." };
  if (!(aliq >= 0 && aliq <= 100)) return { erro: "Alíquota inválida." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("lancar_medicao", {
    p_nota_id: notaId,
    p_vencimento: venc,
    p_conta_id: conta,
    p_cliente: t(fd, "cliente"),
    p_categoria_receita: (UUID.test(catR) ? catR : null) as string,
    p_categoria_imposto: (UUID.test(catI) ? catI : null) as string,
    p_aliquota: aliq,
    ...(Number.isFinite(num(t(fd, "retido"))) ? { p_retido: num(t(fd, "retido")) } : {}),
    ...(Number.isFinite(num(t(fd, "devido"))) ? { p_devido: num(t(fd, "devido")) } : {}),
  });
  if (error || !data) return { erro: mensagemErro(error) };
  revalidatePath("/", "layout");
  redirect(`/recebimentos/${data}?criada=1`); // a linha da nota troca o botão pelo link da receita: a janela some
}
