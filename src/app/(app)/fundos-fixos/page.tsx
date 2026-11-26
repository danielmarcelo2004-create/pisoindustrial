import type { Metadata } from "next";
import Link from "next/link";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { STATUS_FUNDO, saldoDoFundo } from "@/lib/fundos";
import { moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { criarFundo } from "./actions";
import { contasBancariasAtivas } from "@/lib/consultas/contas-bancarias";

export const metadata: Metadata = { title: "Fundos fixos" };

function str(v: string | string[] | undefined) {
  return typeof v === "string" ? v : "";
}

export default async function FundosFixosPage({ searchParams }: PageProps<"/fundos-fixos">) {
  const sp = await searchParams;
  const u = await getUsuario();
  const supabase = await createClient();
  const fin = u.perfil === "financeiro";
  const admin = u.perfil === "administrador" || u.perfil === "administrador_master";

  const contas = fin ? await contasBancariasAtivas() : [];
  const [{ data: fundos }, { data: aprovados }, { data: pendentes }, { data: obras }, { data: pessoas }] = await Promise.all([
    supabase
      .from("fundos_fixos")
      .select("id, valor, status, fechamento_solicitado_em, fechado_em, reposicao, reembolso, saldo_repassado, obra:obras(id, nome), pessoa:profiles!fundos_fixos_pessoa_id_fkey(id, nome)")
      .order("created_at", { ascending: false })
      .limit(300),
    supabase.from("fundo_gastos").select("fundo_id, valor").eq("status", "aprovado"),
    admin
      ? supabase.from("fundo_gastos").select("id, descricao, data_gasto, valor, fundo_id").eq("status", "pendente").order("data_gasto")
      : Promise.resolve({ data: [] as { id: string; descricao: string; data_gasto: string; valor: number; fundo_id: string }[] }),
    fin ? supabase.from("obras").select("id, nome").order("nome") : Promise.resolve({ data: [] as { id: string; nome: string }[] }),
    fin
      ? supabase.from("profiles").select("id, nome, perfil").in("perfil", ["engenheiro", "suprimentos"]).eq("ativo", true).order("nome")
      : Promise.resolve({ data: [] as { id: string; nome: string; perfil: string }[] }),
  ]);

  // Filtros da lista (não confundir com os parâmetros que preenchem o formulário de criação)
  const fObra = str(sp.fobra);
  const fPessoa = str(sp.fpessoa);
  const fSit = str(sp.fsit);
  const fBusca = str(sp.fbusca).trim().toLowerCase();
  const centros = [...new Map((fundos ?? []).map((f) => [f.obra?.id ?? "", f.obra?.nome ?? ""])).entries()].filter(([id]) => id).sort((a, b) => a[1].localeCompare(b[1]));
  const responsaveis = [...new Map((fundos ?? []).map((f) => [f.pessoa?.id ?? "", f.pessoa?.nome ?? ""])).entries()].filter(([id]) => id).sort((a, b) => a[1].localeCompare(b[1]));
  const filtrados = (fundos ?? []).filter((f) => {
    if (fObra && f.obra?.id !== fObra) return false;
    if (fPessoa && f.pessoa?.id !== fPessoa) return false;
    if (fSit === "fechado" && f.status !== "fechado") return false;
    if (fSit === "aberto" && f.status === "fechado") return false;
    if (fBusca && !`${f.obra?.nome ?? ""} ${f.pessoa?.nome ?? ""}`.toLowerCase().includes(fBusca)) return false;
    return true;
  });
  const filtroAtivo = !!(fObra || fPessoa || fSit || fBusca);
  // Um bloco por centro de custo (em ordem alfabética); dentro dele, os abertos primeiro
  const grupos = new Map<string, { nome: string; lista: typeof filtrados }>();
  for (const f of filtrados) {
    const g = grupos.get(f.obra?.id ?? "") ?? { nome: f.obra?.nome ?? "Sem centro de custo", lista: [] };
    g.lista.push(f);
    grupos.set(f.obra?.id ?? "", g);
  }
  const porCentro = [...grupos.entries()]
    .map(([id, g]) => [id, g.nome, [...g.lista].sort((a, b) => Number(a.status === "fechado") - Number(b.status === "fechado"))] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));

  const gastosPorFundo = new Map<string, number[]>();
  for (const g of aprovados ?? []) gastosPorFundo.set(g.fundo_id, [...(gastosPorFundo.get(g.fundo_id) ?? []), g.valor]);
  const fundoPorId = new Map((fundos ?? []).map((f) => [f.id, f]));

  return (
    <>
      <Cabecalho
        titulo="Fundos fixos"
        subtitulo="Cada engenheiro ou Suprimentos tem um fundo por obra. Os gastos aprovados abatem o saldo, sem limite de lançamentos; quem tem o fundo solicita o fechamento e só o Financeiro fecha."
      />
      {fin && (fundos ?? []).some((f) => f.status !== "fechado" && f.fechamento_solicitado_em) && (
        <div className="mb-6" data-fechamentos-solicitados>
          <Aviso tipo="alerta">
            <strong>Fechamento solicitado:</strong>{" "}
            {(fundos ?? [])
              .filter((f) => f.status !== "fechado" && f.fechamento_solicitado_em)
              .map((f, i) => (
                <span key={f.id}>
                  {i > 0 && " · "}
                  <Link href={`/fundos-fixos/${f.id}`} className="font-medium underline">
                    {f.pessoa?.nome} ({f.obra?.nome})
                  </Link>
                </span>
              ))}
            . Abra o fundo para fechar e repor ou encerrar.
          </Aviso>
        </div>
      )}
      {sp.fechado && (
        <div className="mb-6">
          <Aviso tipo="sucesso">
            {sp.fechado === "reposto"
              ? "Fundo reposto: os gastos viraram um pagamento (reposição e reembolso) e um novo fundo do mesmo valor já está aberto. A OP em PDF está anexada ao pagamento em Contas a pagar."
              : sp.fechado === "pagamento"
              ? "Fundo encerrado. O reembolso virou um pagamento (com a OP em PDF anexada) e o saldo que sobrou, se houver, está em Contas a receber para a devolução."
              : "Fundo fechado. Não havia reposição nem reembolso; o saldo fica registrado para repasse à empresa."}
          </Aviso>
        </div>
      )}
      {sp.aviso && <Aviso tipo="alerta">{str(sp.aviso)}</Aviso>}
      {sp.decidido && (
        <div className="mb-6">
          <Aviso tipo="sucesso">
            {sp.decidido === "aprovado" ? "Gasto aprovado e somado ao saldo." : "Gasto recusado. Ele não entra no saldo."}
          </Aviso>
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {fin && (
          <Cartao titulo="Novo fundo fixo" className="xl:col-span-1">
            <FormAcao action={criarFundo} enviar="Criar fundo">
              <Campo rotulo="Centro de custo" obrigatorio>
                <select name="obra_id" required className="campo">
                  <option value="">Selecione…</option>
                  {(obras ?? []).map((o) => (
                    <option key={o.id} value={o.id}>{o.nome}</option>
                  ))}
                </select>
              </Campo>
              <Campo rotulo="Responsável pelo fundo" obrigatorio ajuda="Engenheiro ou Suprimentos que vai gastar e prestar contas.">
                <select name="pessoa_id" required className="campo">
                  <option value="">Selecione…</option>
                  {(pessoas ?? []).map((p) => (
                    <option key={p.id} value={p.id}>{p.nome}</option>
                  ))}
                </select>
              </Campo>
              <Campo rotulo="Valor do fundo (R$)" obrigatorio>
                <input name="valor" required inputMode="decimal" className="campo" placeholder="0,00" />
              </Campo>
              <Campo rotulo="Sai da conta" obrigatorio ajuda="O desembolso entra em Contas a pagar (sem aprovação) para pagar e conciliar.">
                <select name="conta_id" required className="campo" defaultValue={contas.length === 1 ? contas[0].id : ""}>
                  <option value="">Selecione…</option>
                  {contas.filter((c) => !/baixa manual/i.test(c.nome)).map((c) => (
                    <option key={c.id} value={c.id}>{c.nome}</option>
                  ))}
                </select>
              </Campo>
              <Campo rotulo="Data do desembolso" ajuda="Em branco = hoje.">
                <input type="date" name="vencimento" className="campo" />
              </Campo>
            </FormAcao>
          </Cartao>
        )}

        <div className={fin ? "space-y-6 xl:col-span-2" : "space-y-6 xl:col-span-3"}>
          {admin && (
            <Cartao titulo={`Gastos aguardando sua aprovação (${pendentes?.length ?? 0})`} semPadding>
              {!pendentes?.length ? (
                <Vazio>Nenhum gasto de fundo fixo aguardando aprovação.</Vazio>
              ) : (
                <div className="overflow-x-auto">
                  <table className="tabela">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Descrição</th>
                        <th>Fundo</th>
                        <th className="text-right">Valor</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {pendentes.map((g) => {
                        const f = fundoPorId.get(g.fundo_id);
                        return (
                          <tr key={g.id}>
                            <td className="whitespace-nowrap tabular-nums">{g.data_gasto.split("-").reverse().join("/")}</td>
                            <td className="font-medium">{g.descricao}</td>
                            <td>{f?.pessoa?.nome} · {f?.obra?.nome}</td>
                            <td className="text-right tabular-nums">{moeda(g.valor)}</td>
                            <td><Link href={`/fundos-fixos/${g.fundo_id}`} className="text-marca-700 hover:underline">Decidir</Link></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Cartao>
          )}

          <Cartao titulo={`Fundos (${filtrados.length}${filtroAtivo ? ` de ${fundos?.length ?? 0}` : ""})`} semPadding>
            <form method="get" className="grid gap-3 border-b border-slate-200 p-4 sm:grid-cols-2 xl:grid-cols-4" role="search">
              <input name="fbusca" defaultValue={fBusca} placeholder="Buscar centro de custo ou responsável…" className="campo" aria-label="Buscar fundo" />
              <select name="fobra" defaultValue={fObra} className="campo" aria-label="Centro de custo">
                <option value="">Todos os centros de custo</option>
                {centros.map(([id, nome]) => (
                  <option key={id} value={id}>{nome}</option>
                ))}
              </select>
              <select name="fpessoa" defaultValue={fPessoa} className="campo" aria-label="Responsável">
                <option value="">Todos os responsáveis</option>
                {responsaveis.map(([id, nome]) => (
                  <option key={id} value={id}>{nome}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <select name="fsit" defaultValue={fSit} className="campo min-w-0 flex-1" aria-label="Situação">
                  <option value="">Todas as situações</option>
                  <option value="aberto">Em aberto</option>
                  <option value="fechado">Fechado</option>
                </select>
                <button type="submit" className="rounded-md bg-marca-700 px-3 text-sm font-medium text-white">Filtrar</button>
              </div>
              {filtroAtivo && (
                <div className="sm:col-span-2 xl:col-span-4">
                  <Link href="/fundos-fixos" className="text-xs text-marca-700 hover:underline">Limpar filtros</Link>
                </div>
              )}
            </form>
            {!fundos?.length ? (
              <Vazio>Nenhum fundo fixo cadastrado.</Vazio>
            ) : !filtrados.length ? (
              <Vazio>Nenhum fundo encontrado com esses filtros.</Vazio>
            ) : (
              <div className="divide-y divide-slate-200" data-fundos-por-centro>
                {porCentro.map(([obraId, nomeCentro, lista]) => (
                  <section key={obraId} data-centro-de-custo={nomeCentro} aria-label={`Fundos de ${nomeCentro}`}>
                    <h3 className="flex flex-wrap items-baseline justify-between gap-2 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-800">
                      <span>{nomeCentro}</span>
                      <span className="text-xs font-normal text-slate-500">
                        {lista.filter((x) => x.status !== "fechado").length} aberto(s) · {lista.length} no total
                      </span>
                    </h3>
                    <div className="overflow-x-auto">
                      <table className="tabela">
                        <thead>
                          <tr>
                            <th>Responsável</th>
                            <th className="hidden text-right sm:table-cell">Valor</th>
                            <th className="text-right">Saldo</th>
                            <th className="hidden text-right sm:table-cell">Reembolso</th>
                            <th>Situação</th>
                            <th className="hidden sm:table-cell" />
                          </tr>
                        </thead>
                        <tbody>
                          {lista.map((f) => {
                            const saldo = saldoDoFundo(f.valor, gastosPorFundo.get(f.id) ?? []);
                            const st = STATUS_FUNDO[f.status] ?? STATUS_FUNDO.em_andamento;
                            // Reembolso: gasto aprovado acima do valor do fundo (fechado: o que foi pago no fechamento)
                            const gasto = Math.round((gastosPorFundo.get(f.id) ?? []).reduce((a, v) => a + v, 0) * 100) / 100;
                            const reembolso = f.status === "fechado" ? Number(f.reembolso ?? 0) : Math.max(Math.round((gasto - f.valor) * 100) / 100, 0);
                            return (
                              <tr key={f.id}>
                                <td className="font-medium">
                                  {f.pessoa?.nome}
                                  <Link href={`/fundos-fixos/${f.id}`} className="block text-xs font-normal text-marca-700 hover:underline sm:hidden">Ver fundo</Link>
                                </td>
                                <td className="hidden text-right tabular-nums sm:table-cell">{moeda(f.valor)}</td>
                                <td className="text-right tabular-nums">
                                  {f.status === "fechado" ? "—" : moeda(Math.max(saldo, 0))}
                                  <div className="text-xs text-slate-500 sm:hidden">de {moeda(f.valor)}</div>
                                  {reembolso > 0 && <div className="text-xs text-amber-700 sm:hidden">Reembolso {moeda(reembolso)}</div>}
                                </td>
                                <td className="hidden text-right tabular-nums sm:table-cell" data-reembolso={reembolso > 0 ? reembolso : undefined}>{reembolso > 0 ? <span className="font-medium text-amber-700">{moeda(reembolso)}</span> : "—"}</td>
                                <td>
                                  <Selo cor={st.cor}>{st.rotulo}</Selo>
                                  {f.status !== "fechado" && f.fechamento_solicitado_em && <div className="mt-1 text-xs text-amber-700" data-fechamento-solicitado>Fechamento solicitado</div>}
                                </td>
                                <td className="hidden whitespace-nowrap text-xs sm:table-cell">
                                  <Link href={`/fundos-fixos/${f.id}`} className="text-marca-700 hover:underline">Ver fundo</Link>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}
              </div>
            )}
          </Cartao>
        </div>
      </div>
    </>
  );
}
