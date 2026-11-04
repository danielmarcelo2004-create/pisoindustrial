import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { fornecedoresAtivos } from "@/lib/consultas/cadastros";
import { createClient } from "@/lib/supabase/server";
import { CamposPagamento } from "../../campos";
import { atualizarPagamento } from "../../actions";

export const metadata: Metadata = { title: "Editar pagamento" };

export default async function EditarPagamentoPage({ params }: PageProps<"/pagamentos/[id]/editar">) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  await getUsuario();
  const supabase = await createClient();
  const { data: p } = await supabase.from("pagamentos").select("*, obra:obras(nome)").eq("id", id).maybeSingle();
  if (!p) notFound();
  const { data: pode } = await supabase.rpc("pode_atuar_obra", { p_obra_id: p.obra_id });
  if (!pode || p.status === "pago" || p.status === "cancelado") redirect(`/pagamentos/${id}`);

  const [fornecedores, { count: assinaturas }] = await Promise.all([
    fornecedoresAtivos(),
    supabase
      .from("assinaturas")
      .select("id", { count: "exact", head: true })
      .eq("pagamento_id", id)
      .eq("pagamento_versao", p.versao)
      .eq("decisao", "aprovado"),
  ]);

  return (
    <>
      <Cabecalho titulo={`Editar pagamento nº ${p.numero}`} subtitulo={p.obra?.nome} voltar={{ href: `/pagamentos/${id}`, rotulo: "Voltar ao pagamento" }} />
      {!!assinaturas && (
        <div className="mb-4">
          <Aviso tipo="alerta">
            Este pagamento já foi assinado nesta versão. Alterar valor, vencimento, favorecido, descrição ou documento gera uma nova
            versão e reinicia o fluxo de assinaturas. A versão anterior fica preservada no histórico.
          </Aviso>
        </div>
      )}
      <FormAcao action={atualizarPagamento.bind(null, id)} enviar="Salvar alterações">
        <Cartao titulo="Dados do pagamento">
          <CamposPagamento fornecedores={fornecedores} padrao={p} />
        </Cartao>
        <Cartao>
          <Campo rotulo="Motivo da alteração" ajuda="Fica registrado no histórico do pagamento.">
            <input name="motivo" className="campo" maxLength={500} />
          </Campo>
        </Cartao>
      </FormAcao>
    </>
  );
}
