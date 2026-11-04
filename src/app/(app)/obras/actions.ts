"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { FLUXOS, STATUS_OBRA, UFS, type Fluxo, type StatusObra } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function salvarObra(id: string | null, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  const fluxo = t(fd, "fluxo") as Fluxo;
  const status = (t(fd, "status") || "ativa") as StatusObra;
  const uf = t(fd, "uf").toUpperCase();
  const eng = t(fd, "engenheiro_id");
  const adm = t(fd, "administrador_id");

  if (!t(fd, "nome")) return { erro: "Informe o nome da obra." };
  if (!t(fd, "cidade") || !UFS.includes(uf)) return { erro: "Informe cidade e UF." };
  if (!(fluxo in FLUXOS)) return { erro: "Escolha o fluxo de aprovação." };
  if (!(status in STATUS_OBRA)) return { erro: "Situação inválida." };
  if ((eng && !UUID.test(eng)) || (adm && !UUID.test(adm))) return { erro: "Responsável inválido." };
  if (fluxo === "A" && (!eng || !adm)) return { erro: "O Fluxo A exige engenheiro e administrador responsáveis." };
  if (fluxo === "B" && !adm) return { erro: "O Fluxo B exige administrador responsável." };

  const dados = {
    codigo: t(fd, "codigo") || null,
    nome: t(fd, "nome"),
    cliente: t(fd, "cliente") || null,
    endereco: t(fd, "endereco") || null,
    cidade: t(fd, "cidade"),
    uf,
    fluxo,
    status,
    engenheiro_id: eng || null,
    administrador_id: adm || null,
    observacoes: t(fd, "observacoes") || null,
  };

  const supabase = await createClient();
  if (id) {
    const { error } = await supabase.from("obras").update(dados).eq("id", id);
    if (error) return { erro: mensagemErro(error) };
    revalidatePath("/", "layout");
    return { ok: "Obra atualizada. A alteração foi registrada no histórico." };
  }
  const { data, error } = await supabase.from("obras").insert(dados).select("id").single();
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/obras");
  redirect(`/obras/${data.id}?criada=1`);
}

export async function concederAcesso(obraId: string, _: Estado, fd: FormData): Promise<Estado> {
  await exigirPerfil("financeiro");
  const userId = t(fd, "user_id");
  if (!UUID.test(obraId) || !UUID.test(userId)) return { erro: "Selecione o usuário." };
  const supabase = await createClient();
  const { error } = await supabase.from("obra_acessos").insert({ obra_id: obraId, user_id: userId });
  if (error) return { erro: error.code === "23505" ? "Este usuário já tem acesso à obra." : mensagemErro(error) };
  revalidatePath(`/obras/${obraId}`);
  return { ok: "Acesso concedido." };
}

export async function revogarAcesso(obraId: string, userId: string, _: Estado): Promise<Estado> {
  await exigirPerfil("financeiro");
  const supabase = await createClient();
  const { error } = await supabase.from("obra_acessos").delete().eq("obra_id", obraId).eq("user_id", userId);
  if (error) return { erro: mensagemErro(error) };
  revalidatePath(`/obras/${obraId}`);
  return { ok: "Acesso revogado." };
}
