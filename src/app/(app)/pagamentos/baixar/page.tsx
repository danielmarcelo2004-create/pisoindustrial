import type { Metadata } from "next";
import Link from "next/link";
import { exigirPerfil } from "@/lib/auth";
import { Cabecalho, Cartao } from "@/components/ui";
import { abertosParaBaixa } from "@/lib/consultas/abertos-baixa";
import { createClient } from "@/lib/supabase/server";
import { FormBaixar } from "./form";

export const metadata: Metadata = { title: "Baixar pagamentos" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BaixarPage({ searchParams }: PageProps<"/pagamentos/baixar">) {
  await exigirPerfil("financeiro", "administrador_master");
  const sp = await searchParams;
  // ?itens=pag:<id>,parc:<id> (marcados em Contas a pagar) ou ?ids=<pagamento> (links "Dar baixa")
  const lista = (k: string) => [sp[k]].flat().flatMap((v) => String(v ?? "").split(",")).filter(Boolean);
  const chaves = lista("itens").filter((c) => /^(pag|parc):/.test(c) && UUID.test(c.split(":")[1])).slice(0, 300);
  const idsDiretos = lista("ids").filter((v) => UUID.test(v));
  const idsPag = new Set([...idsDiretos, ...chaves.filter((c) => c.startsWith("pag:")).map((c) => c.slice(4))]);
  const pagInteiro = new Set(idsPag); // pagamento marcado: todas as parcelas em aberto
  const idsParc = chaves.filter((c) => c.startsWith("parc:")).map((c) => c.slice(5));
  if (idsParc.length) {
    const { data: pcs } = await (await createClient()).from("pagamento_parcelas").select("pagamento_id").in("id", idsParc);
    for (const pc of pcs ?? []) idsPag.add(pc.pagamento_id);
  }
  const todos = idsPag.size ? await abertosParaBaixa([...idsPag]) : [];
  // Parcela marcada: só ela. Pagamento marcado: ele inteiro.
  const abertos = todos.filter((a) => a.tipo !== "parcela" || idsParc.includes(a.parcelaId!) || pagInteiro.has(a.pagamentoId));
  const qtdPagamentos = new Set(abertos.map((a) => a.pagamentoId)).size;
  return (
    <>
      <Cabecalho
        titulo={qtdPagamentos > 1 ? `Baixar ${qtdPagamentos} pagamentos` : "Baixar pagamento"}
        subtitulo="Confira a data e o valor pago. Se quiser, envie os comprovantes do banco: o sistema lê e liga cada um ao pagamento marcado."
        voltar={{ href: "/pagamentos?status=aguardando_pagamento", rotulo: "Contas a pagar" }}
      />
      {chaves.length + idsDiretos.length === 0 ? (
        <Cartao>
          <p className="text-sm text-slate-600">
            Nenhum pagamento liberado foi marcado (ou os marcados já foram baixados). Volte a{" "}
            <Link href="/pagamentos?status=aguardando_pagamento" className="text-marca-700 hover:underline">
              Contas a pagar
            </Link>
            , marque um ou mais pagamentos liberados e clique em <strong>Baixar</strong>.
          </p>
        </Cartao>
      ) : (
        <FormBaixar key={[...chaves, ...idsDiretos].join(",")} abertos={abertos} />
      )}
    </>
  );
}
