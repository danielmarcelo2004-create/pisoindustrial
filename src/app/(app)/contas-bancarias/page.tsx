import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Aviso, Cabecalho, Vazio, cx } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import {
  CLASSIFICACOES,
  candidatos as buscarCandidatos,
  contagemPorSituacao,
  contasBancarias,
  datasDaConta,
  itensConciliados,
  linhasDaConta,
  sugerir,
  type FiltroLinhas,
  type LinhaExtrato,
} from "@/lib/consultas/conciliacao";
import { data, dataHora, moeda } from "@/lib/formato";
import { AcoesDaConta, BarraLancamentos, CadastrarConta, Desfazer, ImportarExtrato, LinhaPendente, Restaurar, SeletorConta } from "./interativo";

export const metadata: Metadata = { title: "Contas bancárias" };

const MESES = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const nomeMes = (m: string) => (m === "todos" ? "Todos os meses" : `${MESES[Number(m.slice(5, 7)) - 1]} de ${m.slice(0, 4)}`);
const deslocar = (m: string, d: number) => {
  const [a, mm] = m.split("-").map(Number);
  const x = new Date(Date.UTC(a, mm - 1 + d, 1));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
};

export default async function ConciliacaoPage({ searchParams }: PageProps<"/contas-bancarias">) {
  const u = await getUsuario();
  if (u.perfil !== "financeiro" && u.perfil !== "administrador_master") redirect("/");
  const podeAgir = u.perfil === "financeiro";
  const sp = await searchParams;
  const contas = await contasBancarias();
  const conta = contas.find((c) => c.id === str(sp.conta)) ?? contas[0];
  const situacao = (["pendente", "conciliada", "arquivada"].includes(str(sp.ver)) ? str(sp.ver) : "pendente") as LinhaExtrato["situacao"];
  const importado = str(sp.importado);

  if (!conta) {
    return (
      <>
        <Cabecalho
          titulo="Contas bancárias"
          subtitulo="Contas da empresa, extratos e conciliação com as contas a pagar."
          acoes={
            podeAgir ? (
              <div className="flex flex-wrap items-start gap-2">
                <CadastrarConta />
                <ImportarExtrato />
              </div>
            ) : undefined
          }
        />
        <Vazio>
          Nenhuma conta bancária cadastrada.{" "}
          {podeAgir
            ? "Cadastre as contas da empresa (ex.: Banco do Brasil, Caixa Matriz) — elas aparecem para escolher em cada nova despesa — ou importe direto o extrato OFX, que a conta é reconhecida pelo arquivo."
            : "O Financeiro cadastra as contas."}
        </Vazio>
      </>
    );
  }

  const mesParam = str(sp.mes);
  const filtro: FiltroLinhas = {
    mes: /^\d{4}-(0[1-9]|1[0-2])$/.test(mesParam) ? mesParam : "todos",
    busca: str(sp.busca).slice(0, 100),
    tipo: "",
    ordem: (["antigas", "recentes", "maior"].includes(str(sp.ordem)) ? str(sp.ordem) : "antigas") as FiltroLinhas["ordem"],
  };
  const tipo = (["entradas", "saidas"].includes(str(sp.tipo)) ? str(sp.tipo) : "") as FiltroLinhas["tipo"];
  const [todasLinhas, cont, datas] = await Promise.all([linhasDaConta(conta.id, situacao, filtro), contagemPorSituacao(conta.id), datasDaConta(conta.id)]);
  const linhas = todasLinhas.filter((l) => (tipo === "entradas" ? l.valor > 0 : tipo === "saidas" ? l.valor < 0 : true));
  const periodo = linhas.length ? { de: linhas.reduce((m, l) => (l.data < m ? l.data : m), linhas[0].data), ate: linhas.reduce((m, l) => (l.data > m ? l.data : m), linhas[0].data) } : null;
  const cands = situacao === "pendente" ? await buscarCandidatos(periodo) : [];
  const sugestoes = situacao === "pendente" ? sugerir(linhas, cands, conta.id) : new Map();
  const itens = situacao === "conciliada" ? await itensConciliados(linhas.map((l) => l.id)) : new Map();

  const base = { conta: conta.id, ...(filtro.mes !== "todos" ? { mes: filtro.mes } : {}), ...(filtro.busca ? { busca: filtro.busca } : {}), ...(tipo ? { tipo } : {}), ...(filtro.ordem !== "antigas" ? { ordem: filtro.ordem } : {}), ...(situacao !== "pendente" ? { ver: situacao } : {}) };
  const link = (mud: Record<string, string>) => {
    const q = new URLSearchParams(base as Record<string, string>);
    for (const [k, v] of Object.entries(mud)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    return `/contas-bancarias?${q}`;
  };
  const refMes = datas.ultimoLancamento?.slice(0, 7) ?? new Date().toISOString().slice(0, 7);
  const qtdTodos = todasLinhas.length, qtdEntradas = todasLinhas.filter((l) => l.valor > 0).length, qtdSaidas = todasLinhas.filter((l) => l.valor < 0).length;

  return (
    <>
      <Cabecalho
        titulo="Contas bancárias"
        subtitulo="Conciliação: extrato do banco × contas a pagar. O sistema só sugere — nada é conciliado sem o seu clique."
        acoes={
          podeAgir ? (
            <div className="flex flex-wrap items-start gap-2">
              <CadastrarConta />
              <ImportarExtrato />
            </div>
          ) : undefined
        }
      />
      {typeof sp.criada === "string" && (
        <div className="mb-4">
          <Aviso tipo="sucesso">Conta bancária cadastrada. Ela já aparece para escolher nas novas despesas.</Aviso>
        </div>
      )}
      {importado && (
        <div className="mb-4">
          <Aviso tipo="sucesso">Extrato importado — {importado}</Aviso>
        </div>
      )}

      {/* Conta, ações, mês, datas, saldo e pendente (como no Conta Azul) */}
      <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SeletorConta contas={contas.map((c) => ({ id: c.id, nome: c.nome, pendentes: c.pendentes }))} atual={conta.id} />
            {podeAgir && <AcoesDaConta contaId={conta.id} nome={conta.nome} />}
          </div>
          <div className="flex overflow-hidden rounded-md border border-slate-300 bg-white" aria-label="Mês">
            <Link href={link({ mes: filtro.mes === "todos" ? refMes : deslocar(filtro.mes, -1) })} className="px-3 py-2 text-sky-800 hover:bg-slate-50" aria-label="Mês anterior">
              ‹
            </Link>
            <span className="min-w-44 border-x border-slate-200 px-3 py-2 text-center text-sm font-semibold text-sky-800" data-mes-rotulo>
              {nomeMes(filtro.mes)}
            </span>
            <Link href={link({ mes: filtro.mes === "todos" ? refMes : deslocar(filtro.mes, 1) })} className="px-3 py-2 text-sky-800 hover:bg-slate-50" aria-label="Próximo mês">
              ›
            </Link>
            {filtro.mes !== "todos" && (
              <Link href={link({ mes: "" })} className="border-l border-slate-200 px-3 py-2 text-xs text-sky-700 hover:bg-slate-50">
                Todos
              </Link>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3 text-sm" data-conta-bancaria={conta.id}>
          <div className="space-y-0.5 text-slate-600">
            <div>
              Data da última importação: <strong className="text-slate-800">{datas.importadoEm ? dataHora(datas.importadoEm) : "—"}</strong>
            </div>
            <div>
              Data do último lançamento importado: <strong className="text-slate-800">{datas.ultimoLancamento ? data(datas.ultimoLancamento) : "—"}</strong>
            </div>
          </div>
          <div className="flex gap-6 text-right">
            <div>
              <div className="text-xs text-slate-500">Saldo no banco{conta.saldo_em ? ` em ${data(conta.saldo_em)}` : ""}</div>
              <div className="font-semibold tabular-nums">{conta.saldo !== null ? moeda(conta.saldo) : "—"}</div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Valor pendente de conciliação</div>
              <div className="font-semibold tabular-nums" data-valor-pendente>
                {moeda(conta.valorPendente)} <span className="text-xs font-normal text-slate-500">({conta.pendentes})</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        {/* Abas */}
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-slate-200 px-4">
          <nav className="flex gap-1 text-sm">
            <Link href={link({ ver: "" })} aria-current={situacao === "pendente" ? "page" : undefined} className={cx("-mb-px border-b-2 px-3 py-3", situacao === "pendente" ? "border-sky-700 font-semibold text-sky-800" : "border-transparent text-slate-600 hover:text-slate-800")}>
              Conciliações pendentes <span className="ml-1 rounded bg-slate-100 px-1.5 text-xs">{cont.pendente}</span>
            </Link>
            <Link href={link({ ver: "conciliada" })} aria-current={situacao === "conciliada" ? "page" : undefined} className={cx("-mb-px border-b-2 px-3 py-3", situacao === "conciliada" ? "border-sky-700 font-semibold text-sky-800" : "border-transparent text-slate-600 hover:text-slate-800")}>
              Movimentações <span className="ml-1 rounded bg-slate-100 px-1.5 text-xs">{cont.conciliada}</span>
            </Link>
          </nav>
          <Link href={link({ ver: situacao === "arquivada" ? "" : "arquivada" })} className={cx("mb-2 rounded-md border px-3 py-1.5 text-sm", situacao === "arquivada" ? "border-sky-700 bg-sky-50 font-semibold text-sky-800" : "border-sky-300 text-sky-800 hover:bg-sky-50")}>
            {situacao === "arquivada" ? `Lançamentos arquivados (${cont.arquivada})` : `Ver lançamentos arquivados (${cont.arquivada})`}
          </Link>
        </div>

        {/* Pesquisa */}
        <form method="get" className="flex flex-wrap items-end gap-3 px-4 pt-4">
          <input type="hidden" name="conta" value={conta.id} />
          {filtro.mes !== "todos" && <input type="hidden" name="mes" value={filtro.mes} />}
          {situacao !== "pendente" && <input type="hidden" name="ver" value={situacao} />}
          {tipo && <input type="hidden" name="tipo" value={tipo} />}
          <label className="min-w-64 flex-1 sm:max-w-md">
            <div className="mb-1 text-xs text-slate-600">Pesquise o lançamento bancário</div>
            <div className="flex">
              <input name="busca" defaultValue={filtro.busca} placeholder="Descrição ou valor" className="campo rounded-r-none" aria-label="Pesquisar lançamento bancário" />
              <button type="submit" className="rounded-r-md border border-l-0 border-slate-300 bg-white px-3 text-sky-800 hover:bg-slate-50" aria-label="Pesquisar">
                🔍
              </button>
            </div>
          </label>
          {(filtro.busca || tipo || filtro.mes !== "todos") && (
            <Link href={`/contas-bancarias?conta=${conta.id}${situacao !== "pendente" ? `&ver=${situacao}` : ""}`} className="pb-2 text-sm text-sky-700 hover:underline">
              Limpar filtros
            </Link>
          )}
        </form>

        {/* Todos / Recebimentos / Pagamentos */}
        <div className="mx-4 mt-4 grid grid-cols-3 overflow-hidden rounded-t-md border border-slate-200 text-center">
          {(
            [
              ["", "Todos", qtdTodos, "text-sky-800"],
              ["entradas", "Recebimentos", qtdEntradas, "text-emerald-700"],
              ["saidas", "Pagamentos", qtdSaidas, "text-red-600"],
            ] as const
          ).map(([v, r, n, cor]) => (
            <Link key={r} href={link({ tipo: v })} aria-current={tipo === v ? "true" : undefined} data-tipo={v || "todos"} className={cx("border-r border-slate-200 py-2 last:border-r-0 hover:bg-slate-50", tipo === v && "bg-sky-50 shadow-[inset_0_-3px_0_#1d4e89]")}>
              <div className="text-xs text-slate-600">{r}</div>
              <div className={cx("text-lg font-semibold tabular-nums", cor)}>{n}</div>
            </Link>
          ))}
        </div>

        <div className="mx-4 mb-4 rounded-b-md border-x border-b border-slate-200">
          {situacao === "pendente" && (
            <>
              {podeAgir && <BarraLancamentos ordem={filtro.ordem} linkOrdem={{ antigas: link({ ordem: "" }), recentes: link({ ordem: "recentes" }), maior: link({ ordem: "maior" }) }} />}
              <div className="hidden grid-cols-[1fr_8rem_1fr] gap-3 px-4 pt-3 text-sm font-semibold text-slate-700 lg:grid">
                <span>🏦 Lançamentos do banco</span>
                <span />
                <span>📋 Lançamentos do sistema</span>
              </div>
              {linhas.length === 0 && <div className="p-6 text-center text-sm text-emerald-700">Nenhuma conciliação pendente{filtro.busca || tipo || filtro.mes !== "todos" ? " com estes filtros" : " nesta conta"}.</div>}
              {linhas.map((l) => (
                <LinhaPendente key={l.id} linha={l} sugestao={sugestoes.get(l.id) ?? null} candidatos={cands} podeAgir={podeAgir} />
              ))}
            </>
          )}

          {situacao === "conciliada" && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="px-4 py-2">Data</th>
                    <th className="px-4 py-2">Lançamento do banco</th>
                    <th className="px-4 py-2 text-right">Valor</th>
                    <th className="px-4 py-2">Lançamentos do sistema</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {linhas.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-500">
                        Nenhuma movimentação conciliada{filtro.busca || tipo || filtro.mes !== "todos" ? " com estes filtros" : ""}.
                      </td>
                    </tr>
                  )}
                  {linhas.map((l) => {
                    const its = itens.get(l.id) ?? [];
                    return (
                      <tr key={l.id} className="border-t border-slate-100 align-top" data-conciliada={l.id}>
                        <td className="px-4 py-2 whitespace-nowrap tabular-nums">{data(l.data)}</td>
                        <td className="px-4 py-2">{l.descricao}</td>
                        <td className="px-4 py-2 text-right whitespace-nowrap text-red-600 tabular-nums">{moeda(l.valor)}</td>
                        <td className="px-4 py-2">
                          {its.map((i: { pagamentoId: string; numero: number; favorecido: string; parcela: number | null; valor: number; baixou: boolean }) => (
                            <div key={i.pagamentoId + (i.parcela ?? "")}>
                              <Link href={`/pagamentos/${i.pagamentoId}`} className="text-marca-700 hover:underline">
                                nº {i.numero}
                                {i.parcela ? ` · parcela ${i.parcela}` : ""}
                              </Link>{" "}
                              · {i.favorecido} · <span className="tabular-nums">{moeda(i.valor)}</span>
                              {i.baixou && <span className="ml-1 text-xs text-slate-500">(baixa pela conciliação)</span>}
                            </div>
                          ))}
                          {l.encargos !== null && <div className="text-xs text-amber-800" data-encargos>+ {moeda(l.encargos)} de encargos (juros, IOF, anuidade, tarifa)</div>}
                        </td>
                        <td className="px-4 py-2 text-right">{podeAgir && <Desfazer linhaId={l.id} algumaBaixou={its.some((i: { baixou: boolean }) => i.baixou)} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {situacao === "arquivada" && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500 uppercase">
                  <tr>
                    <th className="px-4 py-2">Data</th>
                    <th className="px-4 py-2">Lançamento do banco</th>
                    <th className="px-4 py-2 text-right">Valor</th>
                    <th className="px-4 py-2">Arquivado como</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {linhas.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-6 text-center text-slate-500">
                        Nenhum lançamento arquivado.
                      </td>
                    </tr>
                  )}
                  {linhas.map((l) => (
                    <tr key={l.id} className="border-t border-slate-100" data-arquivada={l.id}>
                      <td className="px-4 py-2 whitespace-nowrap tabular-nums">{data(l.data)}</td>
                      <td className="px-4 py-2">{l.descricao}</td>
                      <td className={cx("px-4 py-2 text-right whitespace-nowrap tabular-nums", l.valor < 0 ? "text-red-600" : "text-emerald-700")}>{moeda(l.valor)}</td>
                      <td className="px-4 py-2">{l.classificacao ? CLASSIFICACOES[l.classificacao] : "—"}</td>
                      <td className="px-4 py-2 text-right">{podeAgir && <Restaurar id={l.id} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
