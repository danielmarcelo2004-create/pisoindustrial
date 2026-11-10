import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Campo, Cabecalho, Cartao, Dado, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { STATUS_FUNDO, STATUS_GASTO, saldoDoFundo } from "@/lib/fundos";
import { data, moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { decidirGasto, excluirGasto, fecharFundo, lancarGasto } from "../actions";
import { AnexosGasto, type AnexoGasto } from "./anexos";

export const metadata: Metadata = { title: "Fundo fixo" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FundoFixoPage({ params }: PageProps<"/fundos-fixos/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const u = await getUsuario();
  const supabase = await createClient();

  const { data: f } = await supabase
    .from("fundos_fixos")
    .select("id, valor, status, pessoa_id, fechado_em, reposicao, reembolso, saldo_repassado, pagamento_id, obra:obras(id, nome), pessoa:profiles!fundos_fixos_pessoa_id_fkey(nome)")
    .eq("id", id)
    .maybeSingle();
  if (!f) notFound();

  const [{ data: gastos }, { data: meuPerfil }] = await Promise.all([
    supabase
      .from("fundo_gastos")
      .select("id, descricao, data_gasto, valor, status, motivo_recusa, anexos:fundo_gasto_anexos(id, storage_path, nome_arquivo, mime_type, assinado, created_at)")
      .eq("fundo_id", id)
      .order("data_gasto")
      .order("created_at"),
    supabase.from("profiles").select("assinatura_path").eq("id", u.id).single(),
  ]);

  const fin = u.perfil === "financeiro";
  const admin = u.perfil === "administrador" || u.perfil === "administrador_master";
  const minhas = f.pessoa_id === u.id;
  const fechado = f.status === "fechado";

  const caminhoAss = meuPerfil?.assinatura_path && meuPerfil.assinatura_path.startsWith(`${u.id}/`) && !meuPerfil.assinatura_path.endsWith("/removida") ? meuPerfil.assinatura_path : null;
  const assinaturaUrl = caminhoAss && minhas ? (await supabase.storage.from("assinaturas").createSignedUrl(caminhoAss, 600)).data?.signedUrl ?? null : null;
  const assinaturaMime = caminhoAss?.endsWith(".png") ? ("image/png" as const) : ("image/jpeg" as const);

  const aprovados = (gastos ?? []).filter((g) => g.status === "aprovado").map((g) => g.valor);
  const gastoAprovado = aprovados.reduce((s, v) => s + v, 0);
  const saldo = saldoDoFundo(f.valor, aprovados);
  const st = STATUS_FUNDO[f.status] ?? STATUS_FUNDO.em_andamento;
  const reposicaoPrevista = Math.min(gastoAprovado, f.valor);
  const reembolsoPrevisto = Math.max(gastoAprovado - f.valor, 0);

  // Saldo corrente: cada gasto aprovado desconta na ordem em que aconteceu.
  let corrente = f.valor;
  const linhas = (gastos ?? []).map((g) => {
    if (g.status === "aprovado") corrente = Math.round((corrente - g.valor) * 100) / 100;
    return { ...g, saldoApos: corrente };
  });

  return (
    <>
      <div className="mb-2 text-sm">
        <Link href="/fundos-fixos" className="text-marca-700 hover:underline">← Fundos fixos</Link>
      </div>
      <Cabecalho
        titulo={`Fundo fixo · ${f.obra?.nome ?? ""}`}
        subtitulo={`Responsável: ${f.pessoa?.nome ?? ""}`}
        acoes={<Selo cor={st.cor}>{st.rotulo}</Selo>}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Cartao titulo="Valor do fundo"><p className="text-xl font-semibold tabular-nums">{moeda(f.valor)}</p></Cartao>
        <Cartao titulo="Gasto aprovado"><p className="text-xl font-semibold tabular-nums">{moeda(gastoAprovado)}</p></Cartao>
        <Cartao titulo="Saldo"><p className="text-xl font-semibold tabular-nums">{fechado ? "—" : moeda(Math.max(saldo, 0))}</p></Cartao>
        <Cartao titulo="Reembolso">
          <p className="text-xl font-semibold tabular-nums">{moeda(reembolsoPrevisto)}</p>
          <p className="text-xs text-slate-500">Gasto aprovado acima do valor do fundo</p>
        </Cartao>
        <Cartao titulo="Pode gastar?"><p className="text-sm">{fechado ? "Fundo fechado" : admin ? "Acompanhe e decida os gastos" : "Lance gastos com comprovante assinado"}</p></Cartao>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Cartao titulo={`Gastos (${gastos?.length ?? 0})`} semPadding>
            {!linhas.length ? (
              <Vazio>Nenhum gasto lançado.</Vazio>
            ) : (
              <ul className="divide-y divide-slate-100">
                {linhas.map((g) => {
                  const sg = STATUS_GASTO[g.status] ?? STATUS_GASTO.pendente;
                  const pendente = g.status === "pendente";
                  return (
                    <li key={g.id} className="space-y-3 px-4 py-4 sm:px-6">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="font-medium">{g.descricao}</div>
                          <div className="text-xs text-slate-500">{data(g.data_gasto)}</div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold tabular-nums">{moeda(g.valor)}</div>
                          <Selo cor={sg.cor}>{sg.rotulo}</Selo>
                        </div>
                      </div>
                      {g.status === "aprovado" && (
                        <div className="text-xs text-slate-500">Saldo após este gasto: <span className="tabular-nums">{moeda(Math.max(g.saldoApos, 0))}</span></div>
                      )}
                      {g.status === "recusado" && (
                        <Aviso tipo="alerta">Recusado: {g.motivo_recusa}. Não entrou no saldo; lance de novo se for o caso.</Aviso>
                      )}
                      <AnexosGasto
                        gastoId={g.id}
                        fundoId={f.id}
                        anexos={(g.anexos ?? []) as AnexoGasto[]}
                        podeEnviar={minhas && !fechado}
                        podeRemover={minhas && !fechado && g.status === "pendente"}
                        assinaturaUrl={assinaturaUrl}
                        assinaturaMime={assinaturaMime}
                      />
                      {fin && !fechado && (
                        <FormAcao action={excluirGasto.bind(null, f.id, g.id)} enviar="Excluir gasto" variante="fantasma" confirmar="Excluir este gasto? Os comprovantes deixam de estar anexados a ele." />
                      )}
                      {admin && pendente && (
                        <div className="grid gap-3 rounded-md bg-amber-50 p-3 sm:grid-cols-2">
                          <FormAcao action={decidirGasto.bind(null, f.id, g.id, true)} enviar="Aprovar gasto" className="space-y-2" />
                          <FormAcao
                            action={decidirGasto.bind(null, f.id, g.id, false)}
                            enviar="Recusar gasto"
                            variante="perigo"
                            className="space-y-2"
                          >
                            <Campo rotulo="Motivo da recusa" obrigatorio>
                              <input name="motivo" required className="campo" maxLength={300} />
                            </Campo>
                          </FormAcao>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Cartao>
        </div>

        <div className="space-y-6">
          {minhas && !fechado && (
            <Cartao titulo="Lançar gasto">
              <FormAcao action={lancarGasto.bind(null, f.id)} enviar="Lançar gasto" pendente="Lançando…">
                <Campo rotulo="Descrição" obrigatorio>
                  <input name="descricao" required className="campo" maxLength={300} placeholder="Ex.: Combustível da caminhonete" />
                </Campo>
                <div className="grid grid-cols-2 gap-3">
                  <Campo rotulo="Data" obrigatorio>
                    <input type="date" name="data_gasto" required className="campo" />
                  </Campo>
                  <Campo rotulo="Valor (R$)" obrigatorio>
                    <input name="valor" required inputMode="decimal" className="campo" placeholder="0,00" />
                  </Campo>
                </div>
              </FormAcao>
              <p className="mt-3 text-xs text-slate-500">
                {f.obra?.id && "Com administrador na obra, o gasto só abate o saldo depois da aprovação."}
              </p>
            </Cartao>
          )}

          {fin && !fechado && (
            <Cartao titulo="Fechar fundo">
              <div className="mb-3 space-y-1 text-sm text-slate-700">
                {f.status === "esgotado" && (
                  <p>Será criado um pagamento de <strong>{moeda(reposicaoPrevista + reembolsoPrevisto)}</strong>: reposição de {moeda(reposicaoPrevista)} + reembolso de {moeda(reembolsoPrevisto)}.</p>
                )}
                {f.status !== "esgotado" && (
                  <p>{reembolsoPrevisto > 0 ? `Reembolso de ${moeda(reembolsoPrevisto)} será pago. ` : ""}Sem reposição: o saldo de {moeda(Math.max(saldo, 0))} fica registrado para repasse à empresa.</p>
                )}
              </div>
              <FormAcao action={fecharFundo.bind(null, f.id)} enviar="Fechar fundo" variante="perigo" pendente="Fechando…">
                <Campo rotulo="Vencimento do pagamento de reposição/reembolso" ajuda="Deixe em branco para hoje.">
                  <input type="date" name="vencimento" className="campo" />
                </Campo>
              </FormAcao>
              <p className="mt-3 text-xs text-slate-500">Depois de fechar, crie um novo fundo do mesmo valor na listagem de fundos.</p>
            </Cartao>
          )}

          {fechado && (
            <Cartao titulo="Fechamento">
              <div className="space-y-2 text-sm">
                <Dado rotulo="Fechado em">{data(f.fechado_em)}</Dado>
                <Dado rotulo="Reposição">{moeda(f.reposicao ?? 0)}</Dado>
                <Dado rotulo="Reembolso">{moeda(f.reembolso ?? 0)}</Dado>
                <Dado rotulo="Saldo a repassar à empresa">{moeda(f.saldo_repassado ?? 0)}</Dado>
                {f.pagamento_id && (
                  <Link href={`/pagamentos/${f.pagamento_id}`} className="text-marca-700 hover:underline">Ver pagamento de reposição/reembolso</Link>
                )}
              </div>
            </Cartao>
          )}
        </div>
      </div>
    </>
  );
}
