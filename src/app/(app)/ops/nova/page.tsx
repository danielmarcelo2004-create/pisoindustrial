import type { Metadata } from "next";
import { Aviso, Cabecalho } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { obrasParaOP } from "@/lib/consultas/obras-op";
import { salvarOP } from "../actions";
import { FormOP } from "../form";

export const metadata: Metadata = { title: "Nova solicitação de OP" };

export default async function NovaOPPage({ searchParams }: PageProps<"/ops/nova">) {
  const u = await exigirPerfil("engenheiro", "financeiro", "suprimentos");
  const sp = await searchParams;
  const t = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const obras = await obrasParaOP();
  const valor = Number(t("valor"));
  const padrao =
    t("descricao") || t("favorecido")
      ? {
          obra_id: t("obra") || undefined,
          favorecido: t("favorecido"),
          descricao: t("descricao"),
          vencimento: t("vencimento") || null,
          forma_pagamento: t("forma") || "pix",
          observacoes: t("observacoes") || null,
          numero_nf: t("nf") || null,
          itens: [{ descricao: t("descricao"), unidade: "UNID.", quantidade: 1, valor_unitario: Number.isFinite(valor) ? valor : 0 }],
        }
      : undefined;
  const podeAssinar = u.perfil === "financeiro" || u.perfil === "suprimentos";
  return (
    <>
      <Cabecalho titulo="Nova solicitação de Ordem de Pagamento" voltar={{ href: "/ops", rotulo: "Solicitações de OP" }} />
      {t("descricao") && (
        <div className="mb-4">
          <Aviso tipo="info">Dados preenchidos a partir do pagamento. Confira antes de enviar: a OP substitui o cadastro direto para formas que não são boleto.</Aviso>
        </div>
      )}
      {obras.length === 0 ? (
        <Aviso tipo="alerta">Você não está vinculado a nenhum centro de custo ativo.</Aviso>
      ) : (
        <FormOP
          action={salvarOP.bind(null, null)}
          obras={obras}
          padrao={padrao}
          podeAssinar={podeAssinar}
          assinarPadrao={t("assinar") === "1"}
          anexos={
            <p className="text-sm text-slate-600">
              Salve o rascunho para anexar comprovantes, recibos ou notas. Engenheiro e administrador assinam cada arquivo antes de anexar.
            </p>
          }
        />
      )}
    </>
  );
}
