import type { Metadata } from "next";
import Link from "next/link";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { STATUS_FUNDO, saldoDoFundo } from "@/lib/fundos";
import { moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { criarFundo } from "./actions";

export const metadata: Metadata = { title: "Fundos fixos" };

export default async function FundosFixosPage({ searchParams }: PageProps<"/fundos-fixos">) {
  const sp = await searchParams;
  const u = await getUsuario();
  const supabase = await createClient();
  const fin = u.perfil === "financeiro";
  const admin = u.perfil === "administrador" || u.perfil === "administrador_master";

  const [{ data: fundos }, { data: aprovados }, { data: pendentes }, { data: obras }, { data: pessoas }] = await Promise.all([
    supabase
      .from("fundos_fixos")
      .select("id, valor, status, fechado_em, reposicao, reembolso, saldo_repassado, obra:obras(id, nome), pessoa:profiles!fundos_fixos_pessoa_id_fkey(id, nome)")
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

  const gastosPorFundo = new Map<string, number[]>();
  for (const g of aprovados ?? []) gastosPorFundo.set(g.fundo_id, [...(gastosPorFundo.get(g.fundo_id) ?? []), g.valor]);
  const fundoPorId = new Map((fundos ?? []).map((f) => [f.id, f]));

  return (
    <>
      <Cabecalho
        titulo="Fundos fixos"
        subtitulo="Cada engenheiro ou Suprimentos tem um fundo por obra. Os gastos aprovados abatem o saldo; o Financeiro fecha o fundo quando ele acaba."
      />
      {sp.fechado && (
        <div className="mb-6">
          <Aviso tipo="sucesso">
            {sp.fechado === "pagamento"
              ? "Fundo fechado. A reposição e o reembolso viraram um pagamento para o Financeiro pagar."
              : "Fundo fechado. Não havia reposição nem reembolso; o saldo fica registrado para repasse à empresa."}
          </Aviso>
        </div>
      )}
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
                <select name="obra_id" required className="campo" defaultValue={sp.obra ?? ""}>
                  <option value="">Selecione…</option>
                  {(obras ?? []).map((o) => (
                    <option key={o.id} value={o.id}>{o.nome}</option>
                  ))}
                </select>
              </Campo>
              <Campo rotulo="Responsável pelo fundo" obrigatorio ajuda="Engenheiro ou Suprimentos que vai gastar e prestar contas.">
                <select name="pessoa_id" required className="campo" defaultValue={sp.pessoa ?? ""}>
                  <option value="">Selecione…</option>
                  {(pessoas ?? []).map((p) => (
                    <option key={p.id} value={p.id}>{p.nome}</option>
                  ))}
                </select>
              </Campo>
              <Campo rotulo="Valor do fundo (R$)" obrigatorio>
                <input name="valor" required inputMode="decimal" className="campo" placeholder="0,00" defaultValue={sp.valor ?? ""} />
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

          <Cartao titulo={`Fundos (${fundos?.length ?? 0})`} semPadding>
            {!fundos?.length ? (
              <Vazio>Nenhum fundo fixo cadastrado.</Vazio>
            ) : (
              <div className="overflow-x-auto">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Centro de custo</th>
                      <th>Responsável</th>
                      <th className="text-right">Valor</th>
                      <th className="text-right">Saldo</th>
                      <th>Situação</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {fundos.map((f) => {
                      const saldo = saldoDoFundo(f.valor, gastosPorFundo.get(f.id) ?? []);
                      const st = STATUS_FUNDO[f.status] ?? STATUS_FUNDO.em_andamento;
                      return (
                        <tr key={f.id}>
                          <td className="font-medium">{f.obra?.nome}</td>
                          <td>{f.pessoa?.nome}</td>
                          <td className="text-right tabular-nums">{moeda(f.valor)}</td>
                          <td className="text-right tabular-nums">{f.status === "fechado" ? "—" : moeda(Math.max(saldo, 0))}</td>
                          <td><Selo cor={st.cor}>{st.rotulo}</Selo></td>
                          <td className="whitespace-nowrap text-xs">
                            <div className="flex flex-col gap-1">
                              <Link href={`/fundos-fixos/${f.id}`} className="text-marca-700 hover:underline">Ver fundo</Link>
                              {fin && f.status === "fechado" && (
                                <Link
                                  href={`/fundos-fixos?obra=${f.obra?.id ?? ""}&pessoa=${f.pessoa?.id ?? ""}&valor=${f.valor}`}
                                  className="text-marca-700 hover:underline"
                                >
                                  Criar novo de mesmo valor
                                </Link>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
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
