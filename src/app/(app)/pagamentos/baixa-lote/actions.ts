"use server";

import { revalidatePath } from "next/cache";
import { getUsuario } from "@/lib/auth";
import { enviarDocumento } from "@/lib/documentos";
import { mensagemErro, type Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Baixa em lote: registra os pagamentos como pagos e anexa a cada um o seu
 * comprovante (arquivos enviados como comp_<id_do_pagamento>).
 */
export async function registrarBaixasLote(_: Estado, fd: FormData): Promise<Estado> {
  const u = await getUsuario();
  if (u.perfil !== "financeiro" && u.perfil !== "administrador_master") {
    return { erro: "Somente o Financeiro e o Administrador master registram baixas." };
  }
  const pagoEm = String(fd.get("pago_em") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pagoEm)) return { erro: "Informe a data do pagamento." };
  let ids: string[];
  try {
    ids = JSON.parse(String(fd.get("ids") ?? "[]"));
  } catch {
    return { erro: "Seleção inválida." };
  }
  ids = ids.filter((i) => UUID.test(i)).slice(0, 300);
  if (ids.length === 0) return { erro: "Selecione ao menos um pagamento." };

  const supabase = await createClient();
  const erros: string[] = [];
  const baixados: string[] = [];
  for (const id of ids) {
    const { error } = await supabase.rpc("registrar_baixa", { p_id: id, p_pago_em: pagoEm, p_observacao: "Baixa em lote" });
    if (error) erros.push(mensagemErro(error));
    else baixados.push(id);
  }

  const { data: pagamentos } = await supabase.from("pagamentos").select("id, obra_id").in("id", baixados);
  const obraDe = new Map((pagamentos ?? []).map((p) => [p.id, p.obra_id]));
  let anexados = 0;
  for (const [chave, valor] of fd.entries()) {
    if (!chave.startsWith("comp_") || typeof valor === "string") continue;
    const id = chave.slice(5);
    const obra = obraDe.get(id);
    if (!obra) continue;
    const r = await enviarDocumento(supabase, { id, obra_id: obra }, "comprovante", valor as File);
    if (r.erro) erros.push(`Comprovante do pagamento ${id.slice(0, 8)}: ${r.erro}`);
    else anexados++;
  }

  revalidatePath("/", "layout");
  const resumo = `${baixados.length} pagamento(s) registrados como pagos${anexados ? `, com ${anexados} comprovante(s) anexados` : ""}.`;
  if (erros.length) return { erro: `${resumo} Problemas: ${erros.join(" ")}` };
  return { ok: resumo };
}
