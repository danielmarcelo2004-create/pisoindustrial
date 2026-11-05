"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUsuario } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { conferirSenha, createClient } from "@/lib/supabase/server";

/**
 * Aprovação/assinatura eletrônica (individual ou em lote). Exige que o usuário
 * confirme que conferiu os documentos e digite a senha novamente.
 */
export async function decidir(_: Estado, fd: FormData): Promise<Estado> {
  const u = await getUsuario();
  if (u.perfil !== "engenheiro" && u.perfil !== "administrador" && u.perfil !== "administrador_master") {
    return { erro: "Seu perfil não assina documentos." };
  }

  let itens: { id: string; versao: number }[];
  try {
    itens = JSON.parse(String(fd.get("itens") ?? "[]"));
    if (!Array.isArray(itens) || itens.length === 0) throw new Error();
    itens = itens.map((i) => ({ id: String(i.id), versao: Number(i.versao) }));
  } catch {
    return { erro: "Selecione ao menos um documento." };
  }

  const decisao = String(fd.get("decisao") ?? "");
  if (decisao !== "aprovado" && decisao !== "rejeitado") return { erro: "Escolha aprovar ou rejeitar." };
  const comentario = String(fd.get("comentario") ?? "").trim();
  if (decisao === "rejeitado" && !comentario) return { erro: "Informe o motivo da rejeição." };
  if (fd.get("conferi") !== "on") return { erro: "Confirme que conferiu os documentos e dados." };

  const senha = String(fd.get("senha") ?? "");
  if (!senha || !(await conferirSenha(u.email, senha))) return { erro: "Senha incorreta." };

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || null;

  const supabase = await createClient();
  const { error } = await supabase.rpc("decidir_aprovacao", {
    p_itens: itens,
    p_decisao: decisao,
    p_comentario: comentario,
    p_ip: ip ?? undefined,
    p_user_agent: h.get("user-agent") ?? undefined,
  });
  if (error) return { erro: mensagemErro(error) };

  revalidatePath("/", "layout");
  const retorno = String(fd.get("retorno") ?? "");
  if (/^\/pagamentos\/[0-9a-f-]{36}$/i.test(retorno)) redirect(`${retorno}?decisao=${decisao}`);
  const n = itens.length;
  if (decisao === "aprovado") return { ok: n > 1 ? `${n} documentos assinados.` : "Documento assinado e encaminhado." };
  return { ok: n > 1 ? `${n} documentos rejeitados.` : "Documento rejeitado." };
}
