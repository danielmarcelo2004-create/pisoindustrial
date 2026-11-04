import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { TabelaPagamentos } from "@/components/pagamentos";
import { Aviso, Cabecalho, Cartao, Indicador } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { listarPagamentos, somar } from "@/lib/consultas/pagamentos";
import { moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { CamposFornecedor } from "../campos";
import { salvarFornecedor } from "../actions";

export const metadata: Metadata = { title: "Fornecedor" };

export default async function FornecedorPage({ params, searchParams }: PageProps<"/fornecedores/[id]">) {
  await exigirPerfil("financeiro", "suprimentos");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const { data: f } = await supabase.from("fornecedores").select("*").eq("id", id).maybeSingle();
  if (!f) notFound();
  const { itens, total } = await listarPagamentos({ fornecedor: id }, 1, 1000);
  const pagos = itens.filter((p) => p.status === "pago");
  const abertos = itens.filter((p) => ["aguardando_engenheiro", "aguardando_administrador", "aguardando_pagamento"].includes(p.status));

  return (
    <>
      <Cabecalho titulo={f.nome} voltar={{ href: "/fornecedores", rotulo: "Fornecedores" }} />
      {sp.criado && (
        <div className="mb-4">
          <Aviso tipo="sucesso">Fornecedor cadastrado.</Aviso>
        </div>
      )}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Indicador rotulo="Pagamentos" valor={total} />
        <Indicador rotulo="Em aberto" valor={moeda(somar(abertos))} detalhe={`${abertos.length} pagamento(s)`} cor="amarelo" />
        <Indicador rotulo="Total pago" valor={moeda(pagos.reduce((s, p) => s + Number(p.valor_pago ?? p.valor), 0))} cor="verde" />
      </div>
      <div className="space-y-6">
        <Cartao titulo="Cadastro">
          <FormAcao action={salvarFornecedor.bind(null, id)} enviar="Salvar alterações">
            <CamposFornecedor padrao={f} edicao />
          </FormAcao>
        </Cartao>
        <Cartao titulo="Histórico de pagamentos" semPadding>
          <TabelaPagamentos itens={[...itens].reverse()} />
        </Cartao>
      </div>
    </>
  );
}
