import type { Metadata } from "next";
import { Cabecalho } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { FormLerNotas } from "./form";

export const metadata: Metadata = { title: "Ler notas fiscais" };

export default async function LerNotasPage() {
  await exigirPerfil("financeiro", "suprimentos");
  const supabase = await createClient();
  const { data: docs } = await supabase
    .from("documentos")
    .select("id, nome_arquivo, mime_type, created_at, pagamento:pagamentos(numero, favorecido, obra:obras(nome))")
    .eq("tipo", "nota_fiscal")
    .eq("ativo", true)
    .neq("mime_type", "application/xml")
    .order("created_at", { ascending: false })
    .limit(300);
  const { data: jaRegistradas } = await supabase.from("nf_notas").select("documento_id").in("documento_id", (docs ?? []).map((d) => d.id).concat(["00000000-0000-0000-0000-000000000000"]));
  const registradas = new Set((jaRegistradas ?? []).map((n) => n.documento_id));
  const pendentes = (docs ?? []).filter((d) => !registradas.has(d.id)).map((d) => ({
    id: d.id,
    arquivo: d.nome_arquivo,
    mime: d.mime_type ?? "",
    numero: d.pagamento?.numero ?? null,
    favorecido: d.pagamento?.favorecido ?? "",
    obra: d.pagamento?.obra?.nome ?? "",
  }));
  return (
    <>
      <Cabecalho
        titulo="Ler notas fiscais (PDF e imagem)"
        subtitulo="A leitura acontece no seu navegador. Só entram na análise as notas nítidas, em que todas as linhas de itens fecham a conta. As demais ficam de fora."
        voltar={{ href: "/compras", rotulo: "Inteligência de Compras" }}
      />
      <FormLerNotas pendentes={pendentes} />
    </>
  );
}
