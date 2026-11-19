import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao, Dado } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { data, moeda, valorParaCampo } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { editarParcela } from "../../../actions";

export const metadata: Metadata = { title: "Editar parcela" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditarParcelaPage({ params }: PageProps<"/pagamentos/[id]/parcelas/[parcelaId]">) {
  const { id, parcelaId } = await params;
  if (!UUID.test(id) || !UUID.test(parcelaId)) notFound();
  const u = await getUsuario();
  const supabase = await createClient();
  const [{ data: p }, { data: parcelas }] = await Promise.all([
    supabase.from("pagamentos").select("id, numero, favorecido, valor, status, created_by, obra:obras(nome)").eq("id", id).maybeSingle(),
    supabase.from("pagamento_parcelas").select("id, numero, valor_base, vencimento, status").eq("pagamento_id", id).order("numero"),
  ]);
  const pc = (parcelas ?? []).find((x) => x.id === parcelaId);
  if (!p || !pc) notFound();
  if (pc.status === "pago" || p.status === "pago" || p.status === "cancelado") redirect(`/pagamentos/${id}`);
  if (u.perfil !== "financeiro" && p.created_by !== u.id) redirect(`/pagamentos/${id}`);
  const liberado = p.status === "aguardando_pagamento";
  const emAprovacao = p.status === "aguardando_engenheiro" || p.status === "aguardando_administrador";

  return (
    <>
      <Cabecalho titulo={`Editar parcela ${pc.numero}/${parcelas?.length}`} subtitulo={`Pagamento nº ${p.numero} · ${p.favorecido} · ${p.obra?.nome ?? ""}`} voltar={{ href: `/pagamentos/${id}`, rotulo: "Voltar ao lançamento" }} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Cartao titulo="Parcela" className="lg:col-span-2">
          <FormAcao action={editarParcela.bind(null, id, parcelaId)} enviar="Salvar parcela">
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo rotulo="Vencimento" obrigatorio>
                <input type="date" name="vencimento" required defaultValue={pc.vencimento} className="campo" />
              </Campo>
              <Campo rotulo="Valor (R$)" obrigatorio ajuda="Se mudar, o total do lançamento muda junto.">
                <input name="valor" required inputMode="decimal" defaultValue={valorParaCampo(pc.valor_base)} className="campo tabular-nums" />
              </Campo>
            </div>
            <Campo rotulo="Motivo" ajuda="Obrigatório se o valor mudar. Fica no histórico.">
              <input name="motivo" className="campo" maxLength={500} />
            </Campo>
            {emAprovacao && <Aviso tipo="alerta">O lançamento está em aprovação: mudar o valor gera uma nova versão e as assinaturas recomeçam.</Aviso>}
            {liberado && <Aviso tipo="info">O lançamento já foi liberado: mudar o valor não pede nova aprovação, mas avisa o Financeiro.</Aviso>}
          </FormAcao>
        </Cartao>
        <Cartao titulo="Todas as parcelas">
          <ul className="space-y-2 text-sm">
            {(parcelas ?? []).map((x) => (
              <li key={x.id} className={`flex justify-between ${x.id === parcelaId ? "font-semibold text-slate-900" : "text-slate-600"}`}>
                <span>
                  {x.numero}/{parcelas?.length} · {data(x.vencimento)} {x.status === "pago" && <span className="text-emerald-700">(paga)</span>}
                </span>
                <span className="tabular-nums">{moeda(x.valor_base)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-slate-200 pt-2">
            <Dado rotulo="Total do lançamento">{moeda(p.valor)}</Dado>
          </div>
        </Cartao>
      </div>
    </>
  );
}
