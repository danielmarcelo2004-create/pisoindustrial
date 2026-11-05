import type { Metadata } from "next";
import { exigirPerfil } from "@/lib/auth";
import { Cabecalho } from "@/components/ui";
import { createClient } from "@/lib/supabase/server";
import { FormBaixaLote } from "./form";

export const metadata: Metadata = { title: "Baixa em lote" };

export default async function BaixaLotePage() {
  await exigirPerfil("financeiro", "administrador_master");
  const supabase = await createClient();
  const { data } = await supabase
    .from("pagamentos")
    .select("id, numero, favorecido, descricao, valor, vencimento, obra:obras(nome), fornecedor:fornecedores(cpf_cnpj)")
    .eq("status", "aguardando_pagamento")
    .order("vencimento", { ascending: true })
    .limit(500);
  const linhas = (data ?? []).map((p) => ({
    id: p.id,
    numero: p.numero,
    favorecido: p.favorecido,
    descricao: p.descricao,
    valor: Number(p.valor),
    vencimento: p.vencimento,
    obra: p.obra?.nome ?? "",
    cnpj: p.fornecedor?.cpf_cnpj ?? null,
  }));
  return (
    <>
      <Cabecalho
        titulo="Baixa de pagamentos em lote"
        subtitulo="Marque os pagamentos liberados, envie o PDF com os comprovantes do banco e confira a separação antes de confirmar."
        voltar={{ href: "/pagamentos", rotulo: "Pagamentos" }}
      />
      <FormBaixaLote linhas={linhas} />
    </>
  );
}
