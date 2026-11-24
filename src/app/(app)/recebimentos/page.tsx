import type { Metadata } from "next";
import Link from "next/link";
import { Cabecalho, Selo, Vazio, cx } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { listarRecebimentos, type FiltroCartaoReceber, type LinhaReceber } from "@/lib/consultas/contas-a-receber";
import { categoriasAtivas } from "@/lib/consultas/categorias";
import { createClient } from "@/lib/supabase/server";
import { data, hojeISO, moeda } from "@/lib/formato";
import { lerPeriodo } from "@/lib/periodo";
import { BarraFiltros } from "../pagamentos/filtros-contas";
import { NovaReceita } from "@/components/nova-receita";

export const metadata: Metadata = { title: "Contas a receber" };

const POR_PAGINA = 50;
const CARTOES: FiltroCartaoReceber[] = ["vencidos", "hoje", "avencer", "recebidos"];
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const semRS = (v: number) => moeda(v).replace("R$", "").trim();

function Situacao({ l }: { l: LinhaReceber }) {
  if (l.situacao === "recebido") return <Selo cor="verde">Recebido ✓</Selo>;
  if (l.situacao === "vencido") return <Selo cor="vermelho">Vencido</Selo>;
  if (l.situacao === "hoje") return <Selo cor="vermelho">Vence hoje</Selo>;
  if (l.situacao === "cancelado") return <Selo cor="cinza">Cancelado</Selo>;
  return <Selo cor="azul">A receber</Selo>;
}

/**
 * Contas a receber (como no Conta Azul): vencimento, pesquisa, mais filtros e cartões que também filtram.
 * Os recebimentos nascem na conciliação; transferências entre contas aparecem como recebidas, marcadas
 * e fora dos totais. Todos os perfis veem os centros de custo que já podem ver.
 */
export default async function ContasAReceberPage({ searchParams }: PageProps<"/recebimentos">) {
  const sp = await searchParams;
  const u = await getUsuario();
  const hoje = hojeISO();
  const periodo = lerPeriodo({ periodo: str(sp.periodo), mes: str(sp.mes), de: str(sp.de), ate: str(sp.ate) }, hoje, "mes");
  const cartaoParam = str(sp.cartao) as FiltroCartaoReceber;
  const cartao: FiltroCartaoReceber = CARTOES.includes(cartaoParam) ? cartaoParam : "";
  const filtros = {
    periodo: periodo.tipo,
    de: periodo.de,
    ate: periodo.ate,
    busca: str(sp.busca),
    obra: str(sp.obra),
    categoria: str(sp.categoria),
    conta: str(sp.conta),
    cancelados: str(sp.cancelados) === "1",
    semtransf: str(sp.semtransf) === "1",
  };
  const veBanco = u.perfil === "financeiro" || u.perfil === "administrador_master";
  const supabase = await createClient();
  const [{ linhas, totais }, { data: obras }, categorias, { data: contas }] = await Promise.all([
    listarRecebimentos({ ...filtros, cartao }, hoje, veBanco),
    supabase.from("obras").select("id, nome, cliente").order("nome"),
    categoriasAtivas("receita"),
    supabase.from("contas_bancarias").select("id, nome").eq("ativa", true).eq("tipo", "corrente").order("nome"),
  ]);

  const pagina = Math.max(1, Number(str(sp.pagina)) || 1);
  const paginas = Math.max(1, Math.ceil(linhas.length / POR_PAGINA));
  const visiveis = linhas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
  const somaLista = visiveis.filter((l) => l.tipo === "recebimento" && l.situacao !== "cancelado").reduce((s, l) => s + l.valor, 0);
  const base = new URLSearchParams(Object.entries({ ...filtros, cancelados: filtros.cancelados ? "1" : "", semtransf: filtros.semtransf ? "1" : "" }).filter(([, v]) => v) as [string, string][]);
  const link = (mudancas: Record<string, string>) => {
    const q = new URLSearchParams(base);
    if (cartao) q.set("cartao", cartao);
    q.delete("pagina");
    for (const [k, v] of Object.entries(mudancas)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    return `/recebimentos?${q}`;
  };
  const consulta = new URLSearchParams(base);
  if (cartao) consulta.set("cartao", cartao);

  const cartaoInfo: { id: FiltroCartaoReceber; titulo: string; valor: number; cor: string; detalhe: string }[] = [
    { id: "vencidos", titulo: "Vencidos", valor: totais.vencidos.valor, cor: "text-red-600", detalhe: `${totais.vencidos.qtd} conta(s)` },
    { id: "hoje", titulo: "Vencem hoje", valor: totais.hoje.valor, cor: "text-red-600", detalhe: `${totais.hoje.qtd} conta(s)` },
    { id: "avencer", titulo: "A vencer", valor: totais.avencer.valor, cor: "text-sky-700", detalhe: `${totais.avencer.qtd} conta(s)` },
    { id: "recebidos", titulo: "Recebidos", valor: totais.recebidos.valor, cor: "text-emerald-700", detalhe: `${totais.recebidos.qtd} recebimento(s)` },
    { id: "", titulo: "Total do período", valor: totais.total.valor, cor: "text-sky-800", detalhe: totais.transferencias.qtd ? `sem ${totais.transferencias.qtd} transferência(s)` : "sem transferências" },
  ];

  return (
    <>
      <Cabecalho
        titulo="Contas a receber"
        subtitulo={`${periodo.rotulo} · ${linhas.filter((l) => l.tipo === "recebimento").length} recebimento(s)`}
        acoes={
          veBanco ? (
            <div className="flex flex-wrap gap-2">
              {u.perfil === "financeiro" && (
                <Link href="/contas-bancarias?tipo=entradas" className="rounded-md border border-sky-300 bg-white px-3 py-2 text-sm font-medium text-sky-800 hover:bg-sky-50">
                  Lançar pela conciliação
                </Link>
              )}
              <NovaReceita obras={(obras ?? []).map((o) => ({ id: o.id, nome: o.nome, cliente: o.cliente }))} categorias={categorias} contas={contas ?? []} />
            </div>
          ) : undefined
        }
      />

      <BarraFiltros
        caminho="/recebimentos"
        consulta={consulta.toString()}
        periodo={periodo}
        hoje={hoje}
        busca={filtros.busca}
        dicaBusca="Cliente, descrição ou nº"
        itens={veBanco ? ["obra", "categoria", "conta", "semtransf", "cancelados"] : ["obra", "categoria", "cancelados"]}
        valores={{ obra: filtros.obra, categoria: filtros.categoria, conta: filtros.conta, cancelados: filtros.cancelados, semtransf: filtros.semtransf }}
        opcoes={{
          obra: (obras ?? []).map((o) => ({ v: o.id, r: o.nome })),
          categoria: categorias.map((c) => ({ v: c.id, r: c.nome })),
          conta: (contas ?? []).map((c) => ({ v: c.id, r: c.nome })),
        }}
      />

      <div className="grid grid-cols-2 overflow-hidden rounded-t-lg border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-5">
        {cartaoInfo.map((c) => {
          const ativo = cartao === c.id && (c.id !== "" || !cartao);
          return (
            <Link
              key={c.titulo}
              href={link({ cartao: c.id && !ativo ? c.id : "" })}
              aria-current={ativo ? "true" : undefined}
              data-cartao={c.id || "total"}
              className={cx("border-r border-b border-slate-200 px-3 py-3 text-center hover:bg-slate-50 xl:border-b-0", ativo && "bg-sky-50 shadow-[inset_0_-3px_0_#1d4e89]")}
            >
              <div className="text-xs text-slate-600">{c.titulo} (R$)</div>
              <div className={cx("mt-0.5 text-xl font-bold tabular-nums", c.cor)}>{semRS(c.valor)}</div>
              <div className="text-[11px] text-slate-400">{c.detalhe}</div>
            </Link>
          );
        })}
      </div>

      <div className="overflow-x-auto rounded-b-lg border-x border-b border-slate-200 bg-white">
        {visiveis.length === 0 ? (
          <Vazio>
            Nenhum recebimento neste período com esses filtros.
            {u.perfil === "financeiro" && " As entradas do extrato viram recebimento em Contas bancárias › Novo lançamento."}
          </Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>Vencimento</th>
                <th>Recebimento</th>
                <th>Resumo</th>
                <th className="text-right">Total (R$)</th>
                <th className="text-right">A receber (R$)</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => (
                <tr key={l.chave} data-linha={l.chave} className={cx(l.tipo === "transferencia" && "bg-slate-50/60", l.situacao === "cancelado" && "text-slate-400")}>
                  <td className={cx("whitespace-nowrap tabular-nums", l.situacao === "vencido" && "font-medium text-red-700")}>{data(l.vencimento)}</td>
                  <td className="whitespace-nowrap tabular-nums text-slate-600">{l.recebidoEm ? data(l.recebidoEm) : "—"}</td>
                  <td className="min-w-64">
                    <div className="font-medium text-slate-800">
                      {l.tipo === "recebimento" ? (
                        <Link href={`/recebimentos/${l.id}`} className="hover:underline">
                          nº {l.numero} · {l.cliente}
                        </Link>
                      ) : (
                        l.cliente
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {l.descricao && <span className="text-xs text-slate-500">{l.descricao}</span>}
                      {l.tipo === "transferencia" && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-800" data-etiqueta-transferencia>Transferência · fora do total</span>}
                      {[l.categoria, l.obra, l.conta ? `🏦 ${l.conta}` : null, l.lancadoConciliacao ? "Lançado pela conciliação" : null, l.temNota ? "📎 Nota de medição" : null].filter(Boolean).map((t, i) => (
                        <span key={`${t}-${i}`} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="text-right tabular-nums">{semRS(l.valor)}</td>
                  <td className="text-right font-medium tabular-nums">{semRS(l.aReceber)}</td>
                  <td>
                    <Situacao l={l} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {visiveis.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
            <span>
              Mostrando {visiveis.length} de {linhas.length} · Soma dos recebimentos da lista: <strong className="tabular-nums">{moeda(somaLista)}</strong>
            </span>
            {paginas > 1 && (
              <span className="flex items-center gap-3">
                {pagina > 1 && (
                  <Link href={link({ pagina: String(pagina - 1) })} className="hover:underline">
                    ‹ Anterior
                  </Link>
                )}
                Página {pagina} de {paginas}
                {pagina < paginas && (
                  <Link href={link({ pagina: String(pagina + 1) })} className="hover:underline">
                    Próxima ›
                  </Link>
                )}
              </span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
