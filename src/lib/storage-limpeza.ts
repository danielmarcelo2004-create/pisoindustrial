import "server-only";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * Remove do Storage um arquivo que acabou de ser enviado, mas cujo registro no banco falhou
 * (evita arquivo órfão). Só deve ser chamado com o caminho gerado na própria operação.
 */
export async function descartarArquivoEnviado(caminho: string): Promise<void> {
  try {
    await createAdminClient().storage.from("documentos").remove([caminho]);
  } catch (e) {
    console.error("[storage] não foi possível remover o arquivo órfão", caminho, e);
  }
}
