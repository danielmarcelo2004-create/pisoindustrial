import type { Metadata } from "next";
import Link from "next/link";
import { GraficoBarras, rotuloMes } from "@/components/grafico-barras";
import { SeloStatus } from "@/components/pagamentos";
import { Cabecalho, Cartao, Indicador, Vazio, classeBotao, cx } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { dadosRelatorio, lerFiltros, type FiltrosRelatorio } from "@/lib/consultas/relatorios";
import { data, hojeISO, moeda } from "@/lib/formato";
import { STATUS_PAGAMENTO } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Relatórios" };

type Linha = { chave: string; rotulo: string; qtd: number; total: number; pago: number; aberto: number; vencido: number };
type Ver = "resumo" | "centro" | "categoria" | "fornecedor" | "situacao" | "lancamentos";

const ABAS: { id: Ver; rotulo: string }[] = [
  { id: "resumo", rotulo: "Resumo" },
  { id: "centro", rotulo: "Centro de custo" },
  { id: "categoria", rotulo: "Categoria" },
  { id: "fornecedor", rotulo: "Fornecedor" },
  { id: "situacao", rotulo: "Situação" },
  { id: "lancamentos", rotulo: "Lançamentos" },
];

/** Períodos prontos (o relatório abre no mês inteiro, não só até hoje). */
function periodos(hoje: string) {
  const [y, m] = hoje.split("-").map(Number);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const ini = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm - 1, 1)));
  const fim = (yy: number, mm: number) => iso(new Date(Date.UTC(yy, mm, 0)));
  const ant = new Date(Date.UTC(y, m - 2, 1));
  const tres = new Date(Date.UTC(y, m - 3, 1));
  return [
    { id: "mes", rotulo: "Este mês", de: ini(y, m), ate: fim(y, m) },
    { id: "anterior", rotulo: "Mês passado", de: ini(ant.getUTCFullYear(), ant.getUTCMonth() + 1), ate: fim(ant.getUTCFullYear(), ant.getUTCMonth() + 1) },
    { id: "tres", rotulo: "Últimos 3 meses", de: ini(tres.getUTCFullYear(), tres.getUTCMonth() + 1), ate: fim(y, m) },
    { id: "ano", rotulo: "Este ano", de: `${y}-01-01`, ate: `${y}-12-31` },
  ];
}

/** Barra de proporção (parte do total do período). */
function Barra({ parte, cor = "bg-marca-500" }: { parte: number; cor?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden>
      <div className={cx("h-full rounded-full", cor)} style={{ width: `${Math.max(2, Math.min(100, parte * 100))}%` }} />
    </div>
  );
}

function TabelaResumo({ linhas, coluna, totalGeral, link }: { linhas: Linha[]; coluna: string; totalGeral: number; link?: (l: Linha) => string | null }) {
  if (linhas.length === 0) return <Vazio>Sem dados neste período.</Vazio>;
  return (
    <table className="tabela" data-resumo={coluna}>
      <thead>
        <tr>
          <th>{coluna}</th>
          <th className="text-right">Total</th>
          <th className="hidden text-right sm:table-cell">Pago</th>
          <th className="text-right">Em aberto</th>
          <th className="hidden text-right sm:table-cell">Vencido</th>
        </tr>
      </thead>
      <tbody>
        {linhas.map((l) => {
          const href = link?.(l);
          return (
            <tr key={l.chave}>
              <td className="min-w-0">
                {href ? (
                  <Link href={href} className="text-marca-700 hover:underline">
                    {l.rotulo}
                  </Link>
                ) : (
                  l.rotulo
                )}
                <div className="mt-1 flex items-center gap-2">
                  <div className="w-full max-w-40">
                    <Barra parte={totalGeral > 0 ? l.total / totalGeral : 0} />
                  </div>
                  <span className="text-xs text-slate-500 tabular-nums">{totalGeral > 0 ? `${Math.round((l.total / totalGeral) * 100)}%` : ""}</span>
                </div>
              </td>
              <td className="text-right font-medium tabular-nums">{moeda(l.total)}</td>
              <td className="hidden text-right tabular-nums sm:table-cell">{moeda(l.pago)}</td>
              <td className="text-right tabular-nums">
                {moeda(l.aberto)}
                {l.vencido > 0 && <div className="text-xs text-red-700 sm:hidden">{moeda(l.vencido)} vencido</div>}
              </td>
              <td className="hidden text-right tabular-nums sm:table-cell">{l.vencido ? <span className="text-red-700">{moeda(l.vencido)}</span> : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Lista curta (os maiores) com barra, para o Resumo. */
function Maiores({ titulo, linhas, totalGeral, verTodos, link }: { titulo: string; linhas: Linha[]; totalGeral: number; verTodos: string; link?: (l: Linha) => string | null }) {
  return (
    <Cartao titulo={titulo} acoes={<Link href={verTodos} className="text-xs font-medium text-marca-700 hover:underline">Ver todos</Link>}>
      {linhas.length === 0 ? (
        <p className="text-sm text-slate-500">Sem dados neste período.</p>
      ) : (
        <ul className="space-y-3">
          {linhas.slice(0, 5).map((l) => {
            const href = link?.(l);
            return (
              <li key={l.chave}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  {href ? (
                    <Link href={href} className="min-w-0 truncate text-slate-800 hover:text-marca-700 hover:underline">
                      {l.rotulo}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate text-slate-800">{l.rotulo}</span>
                  )}
                  <span className="shrink-0 font-medium tabular-nums">{moeda(l.total)}</span>
                </div>
                <div className="mt-1">
                  <Barra parte={totalGeral > 0 ? l.total / totalGeral : 0} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Cartao>
  );
}

export default async function RelatoriosPage({ searchParams }: PageProps<"/relatorios">) {
  await getUsuario();
  const sp = await searchParams;
  const texto = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const hoje = hojeISO();
  const prontos = periodos(hoje);
  // Sem período escolhido, abre no mês inteiro
  const f: FiltrosRelatorio = lerFiltros(texto);
  if (!texto("de")) f.de = prontos[0].de;
  if (!texto("ate")) f.ate = prontos[0].ate;
  const ver = (ABAS.find((a) => a.id === texto("ver"))?.id ?? "resumo") as Ver;

  const supabase = await createClient();
  const [r, { data: obras }, { data: fornecedores }, { data: categorias }] = await Promise.all([
    dadosRelatorio(f),
    supabase.from("obras").select("id, nome").order("nome"),
    supabase.from("fornecedores").select("id, nome").order("nome"),
    supabase.from("categorias").select("id, nome").eq("tipo", "despesa").order("nome"),
  ]);

  const filtros = Object.entries(f).filter(([, v]) => v) as [string, string][];
  const qs = new URLSearchParams(filtros);
  const url = (mudar: Record<string, string | null>, destino = ver) => {
    const q = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(mudar)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    if (destino !== "resumo") q.set("ver", destino);
    else q.delete("ver");
    return `/relatorios?${q}`;
  };
  const baseRotulo = { vencimento: "vencimento", pago_em: "data de pagamento", criacao: "data de cadastro", data_competencia: "competência" }[f.base];
  const periodoAtivo = prontos.find((p) => p.de === f.de && p.ate === f.ate)?.id ?? null;

  // Filtros ativos (além do período), cada um com o "x" para tirar
  const ativos: { rotulo: string; sem: Record<string, string | null> }[] = [];
  if (f.obra) ativos.push({ rotulo: `Centro de custo: ${(obras ?? []).find((o) => o.id === f.obra)?.nome ?? "—"}`, sem: { obra: null } });
  if (f.fornecedor) ativos.push({ rotulo: `Fornecedor: ${(fornecedores ?? []).find((o) => o.id === f.fornecedor)?.nome ?? "—"}`, sem: { fornecedor: null } });
  if (f.categoria) ativos.push({ rotulo: `Categoria: ${f.categoria === "sem" ? "sem categoria" : ((categorias ?? []).find((o) => o.id === f.categoria)?.nome ?? "—")}`, sem: { categoria: null } });
  if (f.status) ativos.push({ rotulo: `Situação: ${f.status === "abertos" ? "em aberto" : (STATUS_PAGAMENTO[f.status as keyof typeof STATUS_PAGAMENTO]?.rotulo ?? f.status)}`, sem: { status: null } });
  const linkObra = (l: Linha) => (l.chave ? url({ obra: l.chave }, "resumo") : null);
  const linkCategoria = (l: Linha) => url({ categoria: l.chave }, "resumo");

  const exportar = new URLSearchParams(qs);
  const totalGeral = r.totais.total;

  return (
    <>
      <Cabecalho
        titulo="Relatórios"
        subtitulo={`Despesas por ${baseRotulo} · ${data(f.de)} a ${data(f.ate)}`}
        acoes={
          <>
            <a href={`/relatorios/exportar?${exportar}`} className={classeBotao("secundario")}>
              Exportar para Excel
            </a>
            <a href={`/relatorios/exportar?${exportar}&formato=pdf`} target="_blank" rel="noopener" className={classeBotao("secundario")}>
              Imprimir
            </a>
          </>
        }
      />

      {/* Período e filtros: linha única de períodos prontos; o resto fica recolhido */}
      <div className="mb-5 space-y-3" data-filtros-relatorio>
        <div className="flex flex-wrap items-center gap-2">
          {prontos.map((p) => (
            <Link
              key={p.id}
              href={url({ de: p.de, ate: p.ate })}
              aria-current={periodoAtivo === p.id ? "true" : undefined}
              className={cx(
                "rounded-full border px-3 py-1.5 text-sm transition-colors",
                periodoAtivo === p.id ? "border-marca-600 bg-marca-600 font-medium text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
              )}
            >
              {p.rotulo}
            </Link>
          ))}
          <details className="group relative">
            <summary className={cx("cursor-pointer list-none rounded-full border px-3 py-1.5 text-sm", periodoAtivo ? "border-slate-300 bg-white text-slate-700" : "border-marca-600 bg-marca-50 font-medium text-marca-800")}>
              Outro período e filtros ▾
            </summary>
            <form method="get" className="mt-2 grid gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:w-[44rem] lg:grid-cols-3">
              <label className="text-xs font-medium text-slate-600">
                Considerar a data de
                <select name="base" defaultValue={f.base} className="campo mt-1">
                  <option value="vencimento">Vencimento</option>
                  <option value="pago_em">Pagamento</option>
                  <option value="criacao">Cadastro</option>
                  <option value="data_competencia">Competência</option>
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                De
                <input type="date" name="de" defaultValue={f.de} className="campo mt-1" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Até
                <input type="date" name="ate" defaultValue={f.ate} className="campo mt-1" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Centro de custo
                <select name="obra" defaultValue={f.obra} className="campo mt-1">
                  <option value="">Todos</option>
                  {(obras ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.nome}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                Fornecedor
                <select name="fornecedor" defaultValue={f.fornecedor} className="campo mt-1">
                  <option value="">Todos</option>
                  {(fornecedores ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.nome}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                Categoria
                <select name="categoria" defaultValue={f.categoria} className="campo mt-1">
                  <option value="">Todas</option>
                  <option value="sem">Sem categoria</option>
                  {(categorias ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.nome}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                Situação
                <select name="status" defaultValue={f.status} className="campo mt-1">
                  <option value="">Todas</option>
                  <option value="abertos">Em aberto</option>
                  {Object.entries(STATUS_PAGAMENTO).map(([v, s]) => (
                    <option key={v} value={v}>
                      {s.rotulo}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-2">
                <button className={classeBotao("primario", "sm")}>Aplicar</button>
                <Link href="/relatorios" className={classeBotao("fantasma", "sm")}>
                  Limpar
                </Link>
              </div>
            </form>
          </details>
        </div>
        {ativos.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" data-filtros-ativos>
            {ativos.map((a) => (
              <Link key={a.rotulo} href={url(a.sem)} className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-200" aria-label={`Tirar filtro: ${a.rotulo}`}>
                <span className="truncate">{a.rotulo}</span>
                <span aria-hidden>×</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" data-indicadores-relatorio>
        <Indicador rotulo="Valor total" valor={moeda(r.totais.total)} detalhe={`${r.totais.qtd} pagamento(s), exceto cancelados`} cor="azul" />
        <Indicador rotulo="Pago" valor={moeda(r.totais.pago)} cor="verde" />
        <Indicador rotulo="Em aberto" valor={moeda(r.totais.aberto)} cor="amarelo" />
        <Indicador rotulo="Vencido" valor={moeda(r.totais.vencido)} cor="vermelho" />
      </div>

      <nav className="mb-4 flex flex-wrap gap-1 border-b border-slate-200" aria-label="Visões do relatório" data-abas-relatorio>
        {ABAS.map((a) => (
          <Link
            key={a.id}
            href={url({}, a.id)}
            aria-current={ver === a.id ? "page" : undefined}
            className={cx(
              "-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors",
              ver === a.id ? "border-marca-600 font-semibold text-marca-800" : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900",
            )}
          >
            {a.rotulo}
          </Link>
        ))}
      </nav>

      {r.totais.qtd === 0 ? (
        <Cartao>
          <Vazio>Nenhum pagamento neste período. Escolha outro período ou tire algum filtro.</Vazio>
        </Cartao>
      ) : ver === "resumo" ? (
        <div className="space-y-6">
          {r.porMes.length > 1 && (
            <Cartao titulo="Valor total por mês">
              <div className="mx-auto max-w-3xl">
                <GraficoBarras titulo="Valor total por mês" dados={r.porMes.map((m) => ({ rotulo: rotuloMes(m.chave), valor: m.total, detalhe: `${m.qtd} pagamento(s)` }))} />
              </div>
            </Cartao>
          )}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Maiores titulo="Maiores centros de custo" linhas={r.porObra} totalGeral={totalGeral} verTodos={url({}, "centro")} link={linkObra} />
            <Maiores titulo="Maiores categorias" linhas={r.porCategoria} totalGeral={totalGeral} verTodos={url({}, "categoria")} link={linkCategoria} />
          </div>
        </div>
      ) : ver === "centro" ? (
        <Cartao titulo="Por centro de custo" semPadding>
          <TabelaResumo coluna="Centro de custo" linhas={r.porObra} totalGeral={totalGeral} link={linkObra} />
        </Cartao>
      ) : ver === "categoria" ? (
        <Cartao titulo="Por categoria" semPadding>
          <TabelaResumo coluna="Categoria" linhas={r.porCategoria} totalGeral={totalGeral} link={linkCategoria} />
        </Cartao>
      ) : ver === "fornecedor" ? (
        <Cartao titulo="Por fornecedor / favorecido" semPadding>
          <TabelaResumo coluna="Fornecedor" linhas={r.porFornecedor.slice(0, 50)} totalGeral={totalGeral} link={(l) => (l.chave.startsWith("fav:") ? null : url({ fornecedor: l.chave }, "resumo"))} />
          {r.porFornecedor.length > 50 && <div className="px-4 py-3 text-xs text-slate-500">Mostrando os 50 maiores de {r.porFornecedor.length}. Exporte para ver todos.</div>}
        </Cartao>
      ) : ver === "situacao" ? (
        <Cartao titulo="Por situação" semPadding>
          <TabelaResumo coluna="Situação" linhas={r.porStatus} totalGeral={totalGeral} link={(l) => url({ status: l.chave }, "resumo")} />
        </Cartao>
      ) : (
        <Cartao titulo={`Lançamentos (${r.itens.length})`} semPadding>
          <table className="tabela" data-lancamentos>
            <thead>
              <tr>
                <th className="hidden sm:table-cell">Nº</th>
                <th className="hidden sm:table-cell">Vencimento</th>
                <th>Favorecido</th>
                <th className="text-right">Valor</th>
                <th className="hidden sm:table-cell">Situação</th>
              </tr>
            </thead>
            <tbody>
              {r.itens.slice(0, 100).map((p) => (
                <tr key={p.id}>
                  <td className="hidden sm:table-cell">
                    <Link href={`/pagamentos/${p.id}`} className="text-marca-700 hover:underline">
                      {p.numero}
                    </Link>
                  </td>
                  <td className="hidden whitespace-nowrap tabular-nums sm:table-cell">{data(p.vencimento)}</td>
                  <td className="min-w-0">
                    <Link href={`/pagamentos/${p.id}`} className="font-medium text-slate-800 hover:text-marca-700 hover:underline">
                      {p.favorecido}
                    </Link>
                    <div className="line-clamp-1 text-xs text-slate-500">{p.descricao}</div>
                    <div className="text-xs text-slate-500">
                      {p.obra?.nome}
                      <span className="sm:hidden"> · nº {p.numero} · venc. {data(p.vencimento)}</span>
                    </div>
                    <div className="mt-1 sm:hidden">
                      <SeloStatus status={p.status} />
                    </div>
                  </td>
                  <td className="text-right whitespace-nowrap tabular-nums">{moeda(p.valor)}</td>
                  <td className="hidden sm:table-cell">
                    <SeloStatus status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.itens.length > 100 && <div className="px-4 py-3 text-xs text-slate-500">Mostrando 100 de {r.itens.length}. Exporte para o Excel para ver todos, com competência, categoria e comprovante.</div>}
        </Cartao>
      )}
    </>
  );
}
