import type { Metadata } from "next";
import Link from "next/link";
import { FormAcao } from "@/components/form-acao";
import { Cabecalho, Campo, Cartao, Selo, Vazio } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { data, moeda } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { alterarProvisao, criarProvisao } from "./actions";

export const metadata: Metadata = { title: "Provisões de pagamento" };

const SITUACAO = {
  provisionada: { rotulo: "Provisionada", cor: "amarelo" as const },
  convertida: { rotulo: "Lançada", cor: "verde" as const },
  cancelada: { rotulo: "Cancelada", cor: "cinza" as const },
};

export default async function ProvisoesPage() {
  const u = await getUsuario();
  const supabase = await createClient();
  const [{ data: provisoes }, { data: obras }] = await Promise.all([
    supabase.from("provisoes").select("id, descricao, mes_referencia, vencimento, valor_estimado, status, obra:obras(id, nome)").order("vencimento", { ascending: true, nullsFirst: false }).limit(300),
    supabase.from("obras").select("id, nome").order("nome"),
  ]);
  const fin = u.perfil === "financeiro";
  const podeCriar = u.perfil === "financeiro" || u.perfil === "suprimentos";

  return (
    <>
      <Cabecalho
        titulo="Provisões de pagamento"
        subtitulo="Despesas futuras que ainda não têm valor definido. Não entram nos totais até virarem pagamento. O Financeiro e o Suprimentos registram; o Financeiro lança o pagamento."
      />
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
                <Campo rotulo="Mês de referência">
                  <input type="month" name="mes_referencia" className="campo" />
                </Campo>
                <Campo rotulo="Vencimento">
                  <input type="date" name="vencimento" className="campo" />
                </Campo>
              </div>
              <Campo rotulo="Valor estimado (R$)" ajuda="Pode deixar em branco quando ainda não souber o valor.">
                <input name="valor_estimado" inputMode="decimal" className="campo" placeholder="0,00" />
              </Campo>
              <Campo rotulo="Observações">
                <textarea name="observacoes" rows={2} className="campo" maxLength={1000} />
              </Campo>
            </FormAcao>
          </Cartao>
        )}
        <div className={podeCriar ? "xl:col-span-2" : "xl:col-span-3"}>
          <Cartao titulo={`Provisões (${provisoes?.length ?? 0})`} semPadding>
            {!provisoes?.length ? (
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
                      {fin && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {provisoes.map((p) => (
                      <tr key={p.id}>
                        <td className="min-w-48 font-medium">{p.descricao}</td>
                        <td>{p.obra?.nome}</td>
                        <td className="whitespace-nowrap">{p.mes_referencia ?? "—"}</td>
                        <td className="whitespace-nowrap tabular-nums">{data(p.vencimento)}</td>
                        <td className="text-right tabular-nums">{p.valor_estimado === null ? <span className="text-slate-400">a definir</span> : moeda(p.valor_estimado)}</td>
                        <td>
                          <Selo cor={SITUACAO[p.status as keyof typeof SITUACAO].cor}>{SITUACAO[p.status as keyof typeof SITUACAO].rotulo}</Selo>
                        </td>
                        {fin && (
                          <td className="whitespace-nowrap">
                            {p.status === "provisionada" && (
                              <div className="flex flex-col gap-1 text-xs">
                                <Link
                                  href={`/pagamentos/novo?obra=${p.obra?.id ?? ""}&descricao=${encodeURIComponent(p.descricao)}&vencimento=${p.vencimento ?? ""}${p.valor_estimado !== null ? `&valor=${p.valor_estimado}` : ""}`}
                                  className="text-marca-700 hover:underline"
                                >
                                  Lançar pagamento
                                </Link>
                                <FormAcao action={alterarProvisao.bind(null, p.id, "convertida")} enviar="Marcar como lançada" variante="fantasma" className="" />
                                <FormAcao action={alterarProvisao.bind(null, p.id, "cancelada")} enviar="Cancelar" variante="fantasma" className="" confirmar="Cancelar esta provisão?" />
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
