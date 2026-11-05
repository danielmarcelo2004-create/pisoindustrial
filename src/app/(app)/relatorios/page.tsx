import type { Metadata } from "next";
import Link from "next/link";
import { GraficoBarras, rotuloMes } from "@/components/grafico-barras";
import { SeloStatus } from "@/components/pagamentos";
import { Cabecalho, Cartao, Indicador, Vazio, classeBotao } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { dadosRelatorio, lerFiltros } from "@/lib/consultas/relatorios";
import { data, moeda } from "@/lib/formato";
import { STATUS_PAGAMENTO } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Relatórios" };

type Linha = { chave: string; rotulo: string; qtd: number; total: number; pago: number; aberto: number; vencido: number };

function TabelaResumo({ linhas, titulo, coluna, link }: { linhas: Linha[]; titulo: string; coluna: string; link?: (l: Linha) => string | null }) {
  return (
    <Cartao titulo={titulo} semPadding>
      {linhas.length === 0 ? (
        <Vazio>Sem dados.</Vazio>
      ) : (
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>{coluna}</th>
                <th className="text-right">Qtd</th>
                <th className="text-right">Total</th>
                <th className="text-right">Pago</th>
                <th className="text-right">Em aberto</th>
                <th className="text-right">Vencido</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => {
                const href = link?.(l);
                return (
                  <tr key={l.chave}>
                    <td className="min-w-40">
                      {href ? (
                        <Link href={href} className="text-marca-700 hover:underline">
                          {l.rotulo}
                        </Link>
                      ) : (
                        l.rotulo
                      )}
                    </td>
                    <td className="text-right tabular-nums">{l.qtd}</td>
                    <td className="text-right font-medium tabular-nums">{moeda(l.total)}</td>
                    <td className="text-right tabular-nums">{moeda(l.pago)}</td>
                    <td className="text-right tabular-nums">{moeda(l.aberto)}</td>
                    <td className="text-right tabular-nums">{l.vencido ? <span className="text-red-700">{moeda(l.vencido)}</span> : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Cartao>
  );
}

export default async function RelatoriosPage({ searchParams }: PageProps<"/relatorios">) {
  await getUsuario();
  const sp = await searchParams;
  const f = lerFiltros((k) => (typeof sp[k] === "string" ? (sp[k] as string) : null));
  const supabase = await createClient();
  const [r, { data: obras }, { data: fornecedores }] = await Promise.all([
    dadosRelatorio(f),
    supabase.from("obras").select("id, nome").order("nome"),
    supabase.from("fornecedores").select("id, nome").order("nome"),
  ]);
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
  const comFiltro = (k: string, v: string) => {
    const q = new URLSearchParams(qs);
    q.set(k, v);
    return `/relatorios?${q}`;
  };
  const baseRotulo = { vencimento: "vencimento", pago_em: "data de pagamento", criacao: "data de cadastro" }[f.base];

  return (
    <>
      <Cabecalho
        titulo="Relatórios"
        subtitulo={`Pagamentos por ${baseRotulo} de ${data(f.de)} a ${data(f.ate)}`}
        acoes={
          <a href={`/relatorios/exportar?${qs}`} className={classeBotao("secundario")}>
            Exportar para Excel
          </a>
        }
      />
      <Cartao className="mb-4">
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <select name="base" defaultValue={f.base} className="campo" aria-label="Período por">
            <option value="vencimento">Por vencimento</option>
            <option value="pago_em">Por data de pagamento</option>
            <option value="criacao">Por data de cadastro</option>
          </select>
          <input type="date" name="de" defaultValue={f.de} className="campo" aria-label="De" />
          <input type="date" name="ate" defaultValue={f.ate} className="campo" aria-label="Até" />
          <select name="obra" defaultValue={f.obra} className="campo" aria-label="Centro de custo">
            <option value="">Todas as obras</option>
            {(obras ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.nome}
              </option>
            ))}
          </select>
          <select name="fornecedor" defaultValue={f.fornecedor} className="campo" aria-label="Fornecedor">
            <option value="">Todos os fornecedores</option>
            {(fornecedores ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.nome}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={f.status} className="campo" aria-label="Situação">
            <option value="">Todas as situações</option>
            <option value="abertos">Em aberto</option>
            {Object.entries(STATUS_PAGAMENTO).map(([v, s]) => (
              <option key={v} value={v}>
                {s.rotulo}
              </option>
            ))}
          </select>
          <div className="flex gap-2 lg:col-span-6">
            <button className={classeBotao("primario", "sm")}>Gerar relatório</button>
            <Link href="/relatorios" className={classeBotao("fantasma", "sm")}>
              Mês atual
            </Link>
          </div>
        </form>
      </Cartao>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Indicador rotulo="Pagamentos" valor={r.totais.qtd} />
        <Indicador rotulo="Valor total" valor={moeda(r.totais.total)} detalhe="exceto cancelados" cor="azul" />
        <Indicador rotulo="Pago" valor={moeda(r.totais.pago)} cor="verde" />
        <Indicador rotulo="Em aberto" valor={moeda(r.totais.aberto)} cor="amarelo" />
        <Indicador rotulo="Vencido" valor={moeda(r.totais.vencido)} cor="vermelho" />
      </div>

      <div className="space-y-6">
        {r.porMes.length > 1 && (
          <Cartao titulo="Valor total por mês">
            <GraficoBarras titulo="Valor total por mês" dados={r.porMes.map((m) => ({ rotulo: rotuloMes(m.chave), valor: m.total, detalhe: `${m.qtd} pagamento(s)` }))} />
          </Cartao>
        )}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <TabelaResumo titulo="Por centro de custo" coluna="Centro de custo" linhas={r.porObra} link={(l) => (l.chave ? comFiltro("obra", l.chave) : null)} />
          <TabelaResumo titulo="Por situação" coluna="Situação" linhas={r.porStatus} link={(l) => comFiltro("status", l.chave)} />
        </div>
        <TabelaResumo
          titulo="Por fornecedor / favorecido"
          coluna="Fornecedor"
          linhas={r.porFornecedor.slice(0, 50)}
          link={(l) => (l.chave.startsWith("fav:") ? null : comFiltro("fornecedor", l.chave))}
        />
        <Cartao titulo={`Pagamentos (${r.itens.length})`} semPadding>
          {r.itens.length === 0 ? (
            <Vazio>Nenhum pagamento no período.</Vazio>
          ) : (
            <div className="overflow-x-auto">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Nº</th>
                    <th>Vencimento</th>
                    <th>Favorecido / descrição</th>
                    <th>Centro de custo</th>
                    <th className="text-right">Valor</th>
                    <th>Situação</th>
                    <th>Pago em</th>
                    <th>Comprovante</th>
                  </tr>
                </thead>
                <tbody>
                  {r.itens.slice(0, 500).map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/pagamentos/${p.id}`} className="text-marca-700 hover:underline">
                          {p.numero}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap tabular-nums">{data(p.vencimento)}</td>
                      <td className="min-w-48">
                        {p.favorecido}
                        <div className="line-clamp-1 text-xs text-slate-500">{p.descricao}</div>
                      </td>
                      <td>{p.obra?.nome}</td>
                      <td className="text-right whitespace-nowrap tabular-nums">{moeda(p.valor)}</td>
                      <td>
                        <SeloStatus status={p.status} />
                      </td>
                      <td className="whitespace-nowrap tabular-nums">{data(p.pago_em)}</td>
                      <td>
                        {p.comprovante ? (
                          <a href={`/documentos/${p.comprovante}`} target="_blank" rel="noopener" className="text-xs text-marca-700 hover:underline">
                            Abrir
                          </a>
                        ) : p.status === "pago" ? (
                          <span className="text-xs text-amber-700">Sem comprovante</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {r.itens.length > 500 && <div className="px-4 py-3 text-xs text-slate-500">Mostrando 500 de {r.itens.length}. Exporte para ver todos.</div>}
            </div>
          )}
        </Cartao>
      </div>
    </>
  );
}
