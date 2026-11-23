import type { Metadata } from "next";
import Link from "next/link";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { data, hojeISO, moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { analisarSeries, numeroParcela } from "@/lib/provisoes-serie";
import { adicionarParcelasProvisao, alterarProvisao, cancelarProximasProvisoes, criarProvisao } from "./actions";

export const metadata: Metadata = { title: "Provisões de pagamento" };

const SITUACAO = {
  provisionada: { rotulo: "Provisionada", cor: "amarelo" as const },
  convertida: { rotulo: "Lançada", cor: "verde" as const },
  cancelada: { rotulo: "Cancelada", cor: "cinza" as const },
};

/** "Deseja adicionar mais parcelas?" — quantidade sugerida = tamanho atual da série. */
function FormAdicionarParcelas({ id, total, compacto = false }: { id: string; total: number; compacto?: boolean }) {
  return (
    <FormAcao action={adicionarParcelasProvisao.bind(null, id)} enviar="Adicionar parcelas" variante={compacto ? "secundario" : "primario"} className={compacto ? "mt-1 flex items-end gap-2" : "mt-2 flex flex-wrap items-end gap-2"}>
      <label className="text-xs text-slate-600">
        Quantas?
        <input type="number" name="quantidade" min={1} max={60} defaultValue={Math.min(total, 60)} required className="campo mt-0.5 w-20 tabular-nums" aria-label="Quantidade de parcelas a adicionar" />
      </label>
    </FormAcao>
  );
}

export default async function ProvisoesPage({ searchParams }: PageProps<"/provisoes">) {
  const sp = await searchParams;
  const u = await getUsuario();
  const supabase = await createClient();
  const [{ data: provisoes }, { data: obras }] = await Promise.all([
    supabase.from("provisoes").select("id, descricao, mes_referencia, vencimento, valor_estimado, status, categoria_id, created_by, pagamento_origem_id, pagamento_id, pagamento:pagamentos!provisoes_pagamento_id_fkey(numero), obra:obras(id, nome)").order("vencimento", { ascending: true, nullsFirst: false }).limit(300),
    supabase.from("obras").select("id, nome").order("nome"),
  ]);
  const fin = u.perfil === "financeiro";
  const sup = u.perfil === "suprimentos";
  // Financeiro age em todas; suprimentos, nas provisões que ele criou
  const podeAgir = (criador: string) => fin || (sup && criador === u.id);
  const podeCriar = u.perfil === "financeiro" || u.perfil === "suprimentos";
  const hoje = hojeISO();
  const vencida = (p: { status: string; vencimento: string | null }) => p.status === "provisionada" && !!p.vencimento && p.vencimento < hoje;
  const soVencidas = sp.situacao === "vencidas";
  const soUltimas = sp.situacao === "ultimas";
  const todas = provisoes ?? [];
  // Última parcela de cada série e séries que chegaram na última parcela em aberto
  const { ultimas, naUltima } = analisarSeries(todas);
  const idsNaUltima = new Set(naUltima.map((x) => x.ultima.id));
  const lista = soVencidas ? todas.filter(vencida) : soUltimas ? todas.filter((p) => idsNaUltima.has(p.id)) : todas;
  // Acabou de lançar a última parcela de uma série?
  const encerrada = sp.aviso === "ultima" && typeof sp.prov === "string" ? todas.find((p) => p.id === sp.prov) : undefined;
  const qtdVencidas = todas.filter(vencida).length;
  // Faz parte de uma série (repetição de pagamento ou provisão de vários meses "(k/N)")?
  const emSerie = (p: { descricao: string; pagamento_origem_id: string | null }) => !!p.pagamento_origem_id || / \(\d+\/\d+\)$/.test(p.descricao);

  return (
    <>
      <Cabecalho
        titulo="Provisões de pagamento"
        subtitulo="Despesas futuras que ainda não têm valor definido. Não entram nos totais até virarem pagamento. O Financeiro e o Suprimentos registram; o Financeiro lança o pagamento."
      />
      {sp.aviso && (
        <div className="mb-6">
          <Aviso tipo="sucesso">
            {sp.aviso === "convertida" || sp.aviso === "ultima"
              ? "Provisão marcada como lançada."
              : sp.aviso === "estendida"
                ? `${sp.qtd ?? ""} parcela(s) adicionada(s) à série. As parcelas foram renumeradas.`
              : sp.aviso === "serie"
                ? `${sp.qtd ?? ""} provisão(ões) canceladas: esta e as próximas da série.`
                : "Provisão cancelada."}
          </Aviso>
        </div>
      )}
      {encerrada && numeroParcela(encerrada.descricao) && (
        <div className="mb-6">
          <Aviso tipo="info">
            <strong>Essa era a última parcela</strong> de “{numeroParcela(encerrada.descricao)!.base}”. Deseja adicionar mais parcelas?
            {podeAgir(encerrada.created_by) && <FormAdicionarParcelas id={encerrada.id} total={numeroParcela(encerrada.descricao)!.total} />}
          </Aviso>
        </div>
      )}
      {naUltima.length > 0 && (
        <div className="mb-6">
          <Aviso tipo="alerta">
            <strong>{naUltima.length === 1 ? "1 série está na última parcela" : `${naUltima.length} séries estão na última parcela`}.</strong> Deseja
            adicionar mais parcelas?
            <ul className="mt-2 space-y-2">
              {naUltima.map((x) => (
                <li key={x.ultima.id} className="rounded-md bg-white/60 px-3 py-2">
                  <span className="font-medium">{x.base}</span> — parcela {x.total}/{x.total}
                  {x.ultima.vencimento ? `, vence em ${data(x.ultima.vencimento)}` : ""} · {x.ultima.obra?.nome}
                  {podeAgir(x.ultima.created_by) && <FormAdicionarParcelas id={x.ultima.id} total={x.total} compacto />}
                </li>
              ))}
            </ul>
            {!soUltimas && naUltima.length > 3 && (
              <Link href="/provisoes?situacao=ultimas" className="mt-2 inline-block font-medium underline">Mostrar só as últimas parcelas</Link>
            )}
          </Aviso>
        </div>
      )}
      {qtdVencidas > 0 && (
        <div className="mb-6">
          <Aviso tipo="alerta">
            {qtdVencidas === 1 ? "1 provisão está vencida" : `${qtdVencidas} provisões estão vencidas`} e ainda não virou pagamento. Lance o
            pagamento ou cancele.{" "}
            {soVencidas ? (
              <Link href="/provisoes" className="font-medium underline">Mostrar todas</Link>
            ) : (
              <Link href="/provisoes?situacao=vencidas" className="font-medium underline">Mostrar só as vencidas</Link>
            )}
          </Aviso>
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {podeCriar && (
          <Cartao titulo="Nova provisão" className="xl:col-span-1">
            <FormAcao action={criarProvisao} enviar="Registrar provisão">
              <Campo rotulo="Centro de custo" obrigatorio>
                <select name="obra_id" required className="campo" defaultValue="">
                  <option value="">Selecione…</option>
                  {(obras ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.nome}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo rotulo="Descrição" obrigatorio>
                <input name="descricao" required className="campo" maxLength={300} placeholder="Ex.: Conta de luz da casa alugada" />
              </Campo>
              <div className="grid grid-cols-2 gap-3">
                <Campo rotulo="Primeiro vencimento" ajuda="Nas demais parcelas, o vencimento é o mesmo dia de cada mês.">
                  <input type="date" name="vencimento" className="campo" />
                </Campo>
                <Campo rotulo="Quantidade de meses" ajuda="Use 1 para uma provisão única. Ex.: 10 para um contrato de 10 meses.">
                  <input type="number" name="meses" min={1} max={60} defaultValue={1} required className="campo" />
                </Campo>
              </div>
              <Campo rotulo="Valor de cada parcela (R$)" ajuda="Pode deixar em branco quando ainda não souber o valor.">
                <input name="valor_estimado" inputMode="decimal" className="campo" placeholder="0,00" />
              </Campo>
              <Campo rotulo="Observações">
                <textarea name="observacoes" rows={2} className="campo" maxLength={1000} />
              </Campo>
            </FormAcao>
          </Cartao>
        )}
        <div className={podeCriar ? "xl:col-span-2" : "xl:col-span-3"}>
          <Cartao titulo={`${soVencidas ? "Provisões vencidas" : soUltimas ? "Últimas parcelas" : "Provisões"} (${lista.length})`} semPadding>
            {!lista.length ? (
              <Vazio>Nenhuma provisão registrada.</Vazio>
            ) : (
              <div className="overflow-x-auto">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Descrição</th>
                      <th>Centro de custo</th>
                      <th>Referência</th>
                      <th>Vencimento</th>
                      <th className="text-right">Valor estimado</th>
                      <th>Situação</th>
                      {(fin || sup) && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {lista.map((p) => (
                      <tr key={p.id} id={`prov-${p.id}`} data-provisao={p.id} className={sp.prov === p.id ? "scroll-mt-24 bg-sky-50 outline outline-2 outline-sky-400" : vencida(p) ? "bg-red-50" : undefined}>
                        <td className="min-w-48 font-medium">
                          {p.descricao}
                          {ultimas.has(p.id) && p.status === "provisionada" && (
                            <div className="mt-1">
                              <Selo cor="roxo">Última parcela</Selo>
                            </div>
                          )}
                        </td>
                        <td>{p.obra?.nome}</td>
                        <td className="whitespace-nowrap">{p.mes_referencia ?? "—"}</td>
                        <td className={vencida(p) ? "whitespace-nowrap tabular-nums font-medium text-red-700" : "whitespace-nowrap tabular-nums"}>{data(p.vencimento)}</td>
                        <td className="text-right tabular-nums">{p.valor_estimado === null ? <span className="text-slate-400">a definir</span> : moeda(p.valor_estimado)}</td>
                        <td>
                          {vencida(p) ? (
                            <Selo cor="vermelho">Vencida</Selo>
                          ) : (
                            <Selo cor={SITUACAO[p.status as keyof typeof SITUACAO].cor}>{SITUACAO[p.status as keyof typeof SITUACAO].rotulo}</Selo>
                          )}
                          {p.status === "convertida" && p.pagamento_id && (
                            <Link href={`/pagamentos/${p.pagamento_id}`} className="mt-1 block text-xs text-marca-700 hover:underline" data-despesa-da-provisao>
                              Despesa nº {(Array.isArray(p.pagamento) ? p.pagamento[0] : p.pagamento)?.numero}
                            </Link>
                          )}
                        </td>
                        {(fin || sup) && (
                          <td className="whitespace-nowrap">
                            {p.status === "provisionada" && podeAgir(p.created_by) && (
                              <div className="flex flex-col gap-1 text-xs">
                                <Link
                                  href={`/pagamentos/novo?provisao=${p.id}`}
                                  className="text-marca-700 hover:underline"
                                >
                                  Lançar pagamento
                                </Link>
                                <FormAcao action={alterarProvisao.bind(null, p.id, "convertida")} enviar="Marcar como lançada" variante="fantasma" className="" />
                                <FormAcao action={alterarProvisao.bind(null, p.id, "cancelada")} enviar={emSerie(p) ? "Cancelar só esta" : "Cancelar"} variante="fantasma" className="" confirmar="Cancelar esta provisão?" />
                                {ultimas.has(p.id) && (
                                  <details>
                                    <summary className="cursor-pointer text-marca-700 hover:underline">Adicionar mais parcelas</summary>
                                    <FormAdicionarParcelas id={p.id} total={numeroParcela(p.descricao)?.total ?? 1} compacto />
                                  </details>
                                )}
                                {emSerie(p) && (
                                  <FormAcao
                                    action={cancelarProximasProvisoes.bind(null, p.id)}
                                    enviar="Cancelar esta e as próximas"
                                    variante="fantasma"
                                    className=""
                                    confirmar="Cancelar esta provisão e as próximas da mesma série?"
                                  />
                                )}
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Cartao>
        </div>
      </div>
    </>
  );
}
