import type { Metadata } from "next";
import Link from "next/link";
import { Aviso, Cabecalho, Cartao, LinkBotao, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { data, moeda } from "@/lib/formato";
import { STATUS_OP } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Solicitações de OP" };

export default async function OPsPage({ searchParams }: PageProps<"/ops">) {
  const u = await getUsuario();
  const sp = await searchParams;
  const eng = u.perfil === "engenheiro";
  const supabase = await createClient();
  let q = supabase
    .from("ordens_pagamento")
    .select("id, numero, status, favorecido, descricao, vencimento, created_at, enviada_em, obra:obras(nome), solicitante:profiles!ordens_pagamento_solicitante_id_fkey(nome), desconto, ordem_itens(total)")
    .order("created_at", { ascending: false })
    .limit(300);
  if (eng && sp.todas !== "1") q = q.eq("solicitante_id", u.id);
  const { data: ops } = await q;

  return (
    <>
      <Cabecalho
        titulo={eng ? "Minhas solicitações de OP" : "Solicitações de OP"}
        subtitulo={
          eng
            ? "Ordens de Pagamento que você solicitou e o andamento de cada uma"
            : "Ordens de Pagamento solicitadas pelos engenheiros das obras que você acessa"
        }
        acoes={(u.perfil === "engenheiro" || u.perfil === "financeiro" || u.perfil === "suprimentos") && <LinkBotao href="/ops/nova">+ Nova solicitação</LinkBotao>}
      />
      {sp.excluida && (
        <div className="mb-4">
          <Aviso tipo="info">Rascunho excluído.</Aviso>
        </div>
      )}
      <Cartao semPadding>
        {!ops?.length ? (
          <Vazio>{eng ? "Você ainda não fez nenhuma solicitação." : "Nenhuma solicitação."}</Vazio>
        ) : (
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Favorecido / descrição</th>
                  <th>Centro de custo</th>
                  {!eng && <th>Solicitante</th>}
                  <th>Vencimento</th>
                  <th className="text-right">Valor</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {ops.map((o) => (
                  <tr key={o.id}>
                    <td className="whitespace-nowrap">
                      <Link href={`/ops/${o.id}`} className="font-medium text-marca-700 hover:underline">
                        {o.numero ?? "Rascunho"}
                      </Link>
                      <div className="text-xs text-slate-500">{data(o.enviada_em ?? o.created_at)}</div>
                    </td>
                    <td className="min-w-56">
                      {o.favorecido}
                      <div className="line-clamp-1 text-xs text-slate-500">{o.descricao}</div>
                    </td>
                    <td>{o.obra?.nome}</td>
                    {!eng && <td>{o.solicitante?.nome}</td>}
                    <td className="whitespace-nowrap tabular-nums">{data(o.vencimento)}</td>
                    <td className="text-right font-medium whitespace-nowrap tabular-nums">
                      {moeda(o.ordem_itens.reduce((s, i) => s + Number(i.total), 0) - Number(o.desconto))}
                    </td>
                    <td>
                      <Selo cor={STATUS_OP[o.status].cor}>{STATUS_OP[o.status].rotulo}</Selo>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>
    </>
  );
}
