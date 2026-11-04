import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Aviso, Cabecalho, classeBotao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { lancarNF } from "../../actions";
import { FormLancarNF } from "./form";

export const metadata: Metadata = { title: "Lançar itens da NF" };

export default async function LancarNFPage({ params }: PageProps<"/compras/lancar/[documentoId]">) {
  await exigirPerfil("financeiro", "suprimentos");
  const { documentoId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(documentoId)) notFound();
  const supabase = await createClient();
  const { data: doc } = await supabase
    .from("documentos")
    .select("id, tipo, nome_arquivo, pagamento:pagamentos(id, numero, numero_documento, favorecido, fornecedor:fornecedores(nome, cpf_cnpj, uf))")
    .eq("id", documentoId)
    .maybeSingle();
  if (!doc || doc.tipo !== "nota_fiscal" || !doc.pagamento) notFound();
  const { data: ja } = await supabase.from("nf_notas").select("id").eq("documento_id", documentoId).maybeSingle();
  if (ja) redirect(`/pagamentos/${doc.pagamento.id}`);
  const f = doc.pagamento.fornecedor;

  return (
    <>
      <Cabecalho
        titulo="Lançar itens da nota fiscal"
        subtitulo={`${doc.nome_arquivo} · pagamento nº ${doc.pagamento.numero}`}
        voltar={{ href: `/pagamentos/${doc.pagamento.id}`, rotulo: "Voltar ao pagamento" }}
        acoes={
          <a href={`/documentos/${doc.id}`} target="_blank" rel="noopener" className={classeBotao("secundario")}>
            Abrir a nota
          </a>
        }
      />
      <div className="mb-4">
        <Aviso tipo="info">
          Para NF em PDF ou imagem, confira a nota aberta ao lado e digite os itens como estão nela. Sempre que houver o XML da
          NF-e, prefira anexá-lo: a leitura é automática e mais confiável.
        </Aviso>
      </div>
      <FormLancarNF
        action={lancarNF.bind(null, doc.id, doc.pagamento.id)}
        padrao={{ emitente_nome: f?.nome ?? doc.pagamento.favorecido, emitente_cnpj: f?.cpf_cnpj ?? "", emitente_uf: f?.uf ?? "", numero: doc.pagamento.numero_documento ?? "" }}
      />
    </>
  );
}
