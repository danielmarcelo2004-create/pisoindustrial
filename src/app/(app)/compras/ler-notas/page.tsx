import type { Metadata } from "next";
import { Cabecalho } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { FormLerNotas } from "./form";

export const metadata: Metadata = { title: "Ler notas fiscais" };

export default async function LerNotasPage() {
  await exigirPerfil("financeiro", "suprimentos");
  const supabase = await createClient();
  // Consulta exata no banco (as mais recentes primeiro), sem janela fixa que esconda as antigas
  const LIMITE = 300;
  const [{ data: docs }, { data: total }] = await Promise.all([
    supabase.rpc("notas_fiscais_pendentes", { p_limite: LIMITE }),
    supabase.rpc("notas_fiscais_pendentes_total"),
  ]);
  const pendentes = (docs ?? []).map((d) => ({
    id: d.documento_id,
    arquivo: d.nome_arquivo,
    mime: d.mime_type ?? "",
    numero: d.pagamento_numero !== null && d.pagamento_numero !== undefined ? String(d.pagamento_numero) : null,
    favorecido: d.favorecido ?? "",
    obra: d.obra_nome ?? "",
  }));
  const restantes = Math.max(0, (total ?? pendentes.length) - pendentes.length);
  return (
    <>
      <Cabecalho
        titulo="Ler notas fiscais (PDF e imagem)"
        subtitulo="A leitura acontece no seu navegador. Só entram na análise as notas nítidas, em que todas as linhas de itens fecham a conta. As demais ficam de fora."
        voltar={{ href: "/compras", rotulo: "Inteligência de Compras" }}
      />
      {restantes > 0 && (
        <p className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900" data-notas-restantes>
          Mostrando as {pendentes.length} mais recentes. Faltam {restantes} nota(s) além destas: leia estas e abra a página de novo para continuar.
        </p>
      )}
      <FormLerNotas pendentes={pendentes} />
    </>
  );
}
