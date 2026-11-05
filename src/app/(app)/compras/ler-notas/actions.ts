"use server";

import { revalidatePath } from "next/cache";
import { exigirPerfil } from "@/lib/auth";
import { mensagemErro, type Estado } from "@/lib/erros";
import { createClient } from "@/lib/supabase/server";

/** Registra uma nota lida pelo OCR (só chega aqui quando a leitura foi considerada confiável). */
export async function registrarNotaLida(documentoId: string, payload: { nota: unknown; itens: unknown }): Promise<Estado> {
  await exigirPerfil("financeiro", "suprimentos");
  if (!/^[0-9a-f-]{36}$/i.test(documentoId)) return { erro: "Documento inválido." };
  if (!payload || !Array.isArray(payload.itens) || payload.itens.length === 0) return { erro: "Nota sem itens." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("registrar_nf", {
    p_documento_id: documentoId,
    p_nota: payload.nota as never,
    p_itens: payload.itens as never,
    p_origem: "ocr",
  });
  if (error) return { erro: mensagemErro(error) };
  revalidatePath("/compras");
  return { ok: "Nota registrada na Inteligência de Compras." };
}
