import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Cabecalho } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { carregarOP } from "@/lib/consultas/ops";
import { obrasParaOP } from "@/lib/consultas/obras-op";
import { createClient } from "@/lib/supabase/server";
import { salvarOP } from "../../actions";
import { FormOP } from "../../form";
import { AnexosOP, type AnexoOP } from "../../anexos-op";

export const metadata: Metadata = { title: "Editar solicitação de OP" };

export default async function EditarOPPage({ params }: PageProps<"/ops/[id]/editar">) {
  const u = await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const { id } = await params;
  const op = await carregarOP(id);
  if (!op) notFound();
  if (op.solicitante_id !== u.id || op.status !== "em_elaboracao") redirect(`/ops/${id}`);
  const obras = await obrasParaOP();
  const supabase = await createClient();
  const { data: anexosDb } = await supabase
    .from("ordem_anexos")
    .select("id, storage_path, nome_arquivo, mime_type, assinado")
    .eq("ordem_id", id)
    .order("created_at");
  const { data: meuPerfil } = await supabase.from("profiles").select("assinatura_path").eq("id", u.id).single();
  const caminhoAss = meuPerfil?.assinatura_path && meuPerfil.assinatura_path.startsWith(`${u.id}/`) && !meuPerfil.assinatura_path.endsWith("/removida") ? meuPerfil.assinatura_path : null;
  const assinaturaUrl = caminhoAss ? (await supabase.storage.from("assinaturas").createSignedUrl(caminhoAss, 600)).data?.signedUrl ?? null : null;
  const podeAssinar = u.perfil === "engenheiro";
  return (
    <>
      <Cabecalho titulo="Editar solicitação (rascunho)" voltar={{ href: `/ops/${id}`, rotulo: "Voltar" }} />
      <FormOP
        action={salvarOP.bind(null, id)}
        obras={obras}
        padrao={{ ...op, itens: op.ordem_itens, parcelas: Math.max(1, op.ordem_parcelas?.length ?? 1), parcelasValores: op.ordem_parcelas?.map((p) => ({ vencimento: p.vencimento, valor: Number(p.valor) })) }}
        anexos={
          <AnexosOP
            ordemId={id}
            obraId={op.obra_id}
            anexos={(anexosDb ?? []) as AnexoOP[]}
            podeAssinar={podeAssinar}
            assinaturaUrl={assinaturaUrl}
          />
        }
      />
    </>
  );
}
