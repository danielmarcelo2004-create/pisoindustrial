import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Cabecalho } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { carregarOP } from "@/lib/consultas/ops";
import { obrasParaOP } from "@/lib/consultas/obras-op";
import { createClient } from "@/lib/supabase/server";
import { salvarOP } from "../../actions";
import { FormOP } from "../../form";
import type { AnexoOP } from "../../anexos-op";
import { assinaturaDoUsuario } from "../../assinatura-usuario";

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
  const ehEngenheiro = u.perfil === "engenheiro";
  const assinaturaUrl = await assinaturaDoUsuario(u.id, ehEngenheiro);
  // A assinatura do criador só vale enquanto o conteúdo da OP for o mesmo que foi assinado.
  const { data: hashAtual } = await supabase.rpc("conteudo_op_hash", { p_ordem_id: id });
  const assinaturaCriador =
    op.assinatura_criador_pos && typeof op.assinatura_criador_pos === "object"
      ? { pos: op.assinatura_criador_pos as { fx: number; fy: number; fw: number }, atual: op.assinatura_criador_hash === hashAtual }
      : null;
  return (
    <>
      <Cabecalho titulo="Editar solicitação (rascunho)" voltar={{ href: `/ops/${id}`, rotulo: "Voltar" }} />
      <FormOP
        action={salvarOP.bind(null, id)}
        obras={obras}
        padrao={{ ...op, itens: op.ordem_itens, parcelas: Math.max(1, op.ordem_parcelas?.length ?? 1), parcelasValores: op.ordem_parcelas?.map((p) => ({ vencimento: p.vencimento, valor: Number(p.valor) })) }}
        ordemId={id}
        anexosIniciais={(anexosDb ?? []) as AnexoOP[]}
        assinaturaUrl={assinaturaUrl}
        ehEngenheiro={ehEngenheiro}
        assinaturaCriador={assinaturaCriador}
      />
    </>
  );
}
