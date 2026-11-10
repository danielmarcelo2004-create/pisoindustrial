import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Cabecalho } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { carregarOP } from "@/lib/consultas/ops";
import { obrasParaOP } from "@/lib/consultas/obras-op";
import { salvarOP } from "../../actions";
import { FormOP } from "../../form";

export const metadata: Metadata = { title: "Editar solicitação de OP" };

export default async function EditarOPPage({ params }: PageProps<"/ops/[id]/editar">) {
  const u = await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const { id } = await params;
  const op = await carregarOP(id);
  if (!op) notFound();
  if (op.solicitante_id !== u.id || op.status !== "em_elaboracao") redirect(`/ops/${id}`);
  const obras = await obrasParaOP();
  return (
    <>
      <Cabecalho titulo="Editar solicitação (rascunho)" voltar={{ href: `/ops/${id}`, rotulo: "Voltar" }} />
      <FormOP
        action={salvarOP.bind(null, id)}
        obras={obras}
        padrao={{ ...op, itens: op.ordem_itens, parcelas: Math.max(1, op.ordem_parcelas?.length ?? 1), parcelasValores: op.ordem_parcelas?.map((p) => ({ vencimento: p.vencimento, valor: Number(p.valor) })) }}
      />
    </>
  );
}
