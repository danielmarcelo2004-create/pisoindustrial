"use server";

import { revalidatePath } from "next/cache";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";

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
