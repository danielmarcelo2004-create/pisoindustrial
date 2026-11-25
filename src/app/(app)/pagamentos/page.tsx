import type { Metadata } from "next";
import Link from "next/link";
import { Aviso, Cabecalho, LinkBotao, Selo, Vazio, classeBotao, cx } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { listarContas, type FiltroCartao, type LinhaConta } from "@/lib/consultas/contas-a-pagar";
import { categoriasAtivas } from "@/lib/consultas/categorias";
import { contasBancariasAtivas } from "@/lib/consultas/contas-bancarias";
import { data, hojeISO, moeda } from "@/lib/formato";
import { FORMAS_PAGAMENTO, STATUS_PAGAMENTO } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";
import { lerPeriodo } from "@/lib/periodo";
import { BarraFiltros } from "./filtros-contas";
import { JanelaProvisao } from "@/components/janela-provisao";
import { AcoesLinha, BarraSelecao, MarcarTodas, MemoriaSelecao } from "./lista-interativa";

export const metadata: Metadata = { title: "Contas a pagar" };

const POR_PAGINA = 50;
const CARTOES: FiltroCartao[] = ["vencidos", "hoje", "avencer", "aprovacao", "pagos", "liberados", "abertos"];

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const semRS = (v: number) => moeda(v).replace("R$", "").trim();
function Situacao({ l }: { l: LinhaConta }) {
  if (l.situacao === "provisao") return <span className="rounded-full border border-dashed border-slate-300 px-2.5 py-0.5 text-xs font-medium text-slate-500">Provisão</span>;
  if (l.situacao === "pago") {
    // ✓ = conciliado com o extrato bancário; sem ✓ = baixa manual (ainda não conciliada)
    return l.conciliado ? (
      <span title="Conciliado com o extrato bancário" data-pago-via="conciliado">
        <Selo cor="verde">Pago ✓</Selo>
      </span>
    ) : (
      <span title="Baixa manual: ainda não conciliada com o extrato bancário" data-pago-via="manual">
        <Selo cor="verde">Pago</Selo>
        <span className="mt-0.5 block text-[11px] leading-tight text-slate-500">baixa manual</span>
      </span>
    );
  }
  if (l.situacao === "vencido") return <Selo cor="vermelho">Vencido</Selo>;
  if (l.situacao === "hoje") return <Selo cor="vermelho">Vence hoje</Selo>;
  if (l.situacao === "a_pagar") return <Selo cor="azul">A pagar</Selo>;
  const s = STATUS_PAGAMENTO[l.statusPagamento!];
  return <Selo cor={s.cor}>{s.rotulo}</Selo>;
}

export default async function ContasAPagarPage({ searchParams }: PageProps<"/pagamentos">) {
  const sp = await searchParams;
  const u = await getUsuario();
  const hoje = hojeISO();

  // Endereços antigos (?status=…) continuam funcionando
  const legado: Record<string, { cartao: FiltroCartao; todos: boolean }> = {
    aguardando_pagamento: { cartao: "liberados", todos: true },
    em_aprovacao: { cartao: "aprovacao", todos: true },
    abertos: { cartao: "abertos", todos: true },
    pago: { cartao: "pagos", todos: false },
  };
  const mapa = legado[str(sp.status)];
  const periodo = lerPeriodo({ periodo: str(sp.periodo), mes: str(sp.mes), de: str(sp.de), ate: str(sp.ate) }, hoje, mapa?.todos ? "todos" : "mes");
  const cartaoParam = str(sp.cartao) as FiltroCartao;
  const cartao: FiltroCartao = CARTOES.includes(cartaoParam) ? cartaoParam : mapa?.cartao ?? "";
  const filtros = {
    periodo: periodo.tipo,
    de: periodo.de,
    ate: periodo.ate,
    busca: str(sp.busca),
    obra: str(sp.obra),
    forma: str(sp.forma),
    categoria: str(sp.categoria),
    conta: str(sp.conta),
    fornecedor: str(sp.fornecedor),
    cancelados: str(sp.cancelados) === "1",
    lancados: str(sp.lancados) === "1",
  };

  const supabase = await createClient();
  const [{ linhas, totais }, { data: obras }, categorias, { data: fornecedores }, { data: rascunhos }, contasBanc] = await Promise.all([
    listarContas({ ...filtros, mes: periodo.tipo === "todos" ? "todos" : periodo.de.slice(0, 7), cartao }),
    supabase.from("obras").select("id, nome").order("nome"),
    categoriasAtivas(),
    supabase.from("fornecedores").select("id, nome").order("nome").limit(500),
    supabase.from("ordens_pagamento").select("id, favorecido").eq("solicitante_id", u.id).eq("status", "em_elaboracao").order("created_at", { ascending: false }),
    contasBancariasAtivas(),
  ]);
  // Quantas parcelas tem cada lançamento (para "Editar lançamento (todas as parcelas)")
  const idsPag = [...new Set(linhas.map((l) => l.pagamentoId).filter(Boolean))] as string[];
  const { data: contagem } = idsPag.length ? await supabase.from("pagamento_parcelas").select("pagamento_id").in("pagamento_id", idsPag) : { data: [] };
  const qtdParcelas = new Map<string, number>();
  for (const c of contagem ?? []) qtdParcelas.set(c.pagamento_id, (qtdParcelas.get(c.pagamento_id) ?? 0) + 1);

  const podeBaixar = u.perfil === "financeiro" || u.perfil === "administrador_master";
  const podeCadastrar = u.perfil === "financeiro" || u.perfil === "suprimentos" || u.perfil === "engenheiro";
  const pagina = Math.max(1, Number(str(sp.pagina)) || 1);
  const paginas = Math.max(1, Math.ceil(linhas.length / POR_PAGINA));
  const visiveis = linhas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
  const somaLista = visiveis.filter((l) => l.tipo !== "provisao").reduce((s, l) => s + l.valor, 0);

  const base = new URLSearchParams(Object.entries({ ...filtros, cancelados: filtros.cancelados ? "1" : "", lancados: filtros.lancados ? "1" : "" }).filter(([, v]) => v) as [string, string][]);
  const link = (mudancas: Record<string, string>) => {
    const q = new URLSearchParams(base);
    if (cartao) q.set("cartao", cartao);
    q.delete("pagina");
    for (const [k, v] of Object.entries(mudancas)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    return `/pagamentos?${q}`;
  };
  const periodoTexto = periodo.rotulo;
  const consulta = new URLSearchParams(base);
  if (cartao) consulta.set("cartao", cartao);
  // Exportar planilha = exatamente a lista da tela (mesmo mês, cartão e filtros)
  const exportQs = new URLSearchParams(base);
  exportQs.set("lista", "contas");
  if (cartao) exportQs.set("cartao", cartao);

  const cartaoInfo: { id: FiltroCartao; titulo: string; valor: number; cor: string; detalhe: string }[] = [
    { id: "vencidos", titulo: "Vencidos", valor: totais.vencidos.valor, cor: "text-red-600", detalhe: `${totais.vencidos.qtd} conta(s)` },
    { id: "hoje", titulo: "Vencem hoje", valor: totais.hoje.valor, cor: "text-red-600", detalhe: `${totais.hoje.qtd} conta(s)` },
    { id: "avencer", titulo: "A vencer", valor: totais.avencer.valor, cor: "text-sky-700", detalhe: `${totais.avencer.qtd} liberada(s) para pagar` },
    { id: "aprovacao", titulo: "Em aprovação", valor: totais.aprovacao.valor, cor: "text-amber-700", detalhe: `${totais.aprovacao.qtd} aguardando assinatura` },
    { id: "pagos", titulo: "Pagos", valor: totais.pagos.valor, cor: "text-emerald-700", detalhe: `${totais.pagos.qtd} conta(s)` },
    { id: "", titulo: "Total do período", valor: totais.total.valor, cor: "text-sky-800", detalhe: "sem provisões" },
  ];

  return (
    <>
      <Cabecalho
        titulo="Contas a pagar"
        subtitulo={`${periodoTexto} · ${linhas.filter((l) => l.tipo !== "provisao").length} conta(s)`}
        acoes={
          <>
            <a href={`/pagamentos/exportar?${exportQs}`} className={classeBotao("secundario")}>
              Exportar planilha
            </a>
            {podeCadastrar && <LinkBotao href="/pagamentos/novo">+ Nova despesa</LinkBotao>}
          </>
        }
      />

      {typeof sp.baixados === "string" && (
        <div className="mb-4">
          <Aviso tipo="sucesso">{sp.baixados} conta(s) baixada(s) com sucesso.</Aviso>
        </div>
      )}
      {sp.excluida && (
        <div className="mb-4">
          <Aviso tipo="info">Rascunho excluído.</Aviso>
        </div>
      )}
      {(rascunhos ?? []).length > 0 && (
        <p className="mb-4 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
          Você tem {(rascunhos ?? []).length === 1 ? "1 rascunho" : `${(rascunhos ?? []).length} rascunhos`} de Ordem de Pagamento:{" "}
          {(rascunhos ?? []).map((r, i) => (
            <span key={r.id}>
              {i > 0 && ", "}
              <a href={`/ops/${r.id}/editar`} className="text-marca-700 hover:underline">
                {r.favorecido}
              </a>
            </span>
          ))}
          .
        </p>
      )}

      <BarraFiltros
        consulta={consulta.toString()}
        periodo={periodo}
        hoje={hoje}
        busca={filtros.busca}
        valores={{ obra: filtros.obra, categoria: filtros.categoria, fornecedor: filtros.fornecedor, forma: filtros.forma, conta: filtros.conta, cancelados: filtros.cancelados, lancados: filtros.lancados }}
        opcoes={{
          conta: contasBanc.map((c) => ({ v: c.id, r: c.nome })),
          obra: (obras ?? []).map((o) => ({ v: o.id, r: o.nome })),
          categoria: categorias.map((c) => ({ v: c.id, r: c.nome })),
          fornecedor: (fornecedores ?? []).map((f) => ({ v: f.id, r: f.nome })),
          forma: Object.entries(FORMAS_PAGAMENTO).map(([v, r]) => ({ v, r })),
        }}
      />

      {/* Cartões de totais: também são filtros */}
      <div className="grid grid-cols-2 overflow-hidden rounded-t-lg border border-slate-200 bg-white sm:grid-cols-3 xl:grid-cols-6">
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
      {(cartao === "liberados" || cartao === "abertos") && (
        <div className="border-x border-b border-slate-200 bg-sky-50 px-4 py-2 text-sm text-sky-900">
          Mostrando {cartao === "liberados" ? "todas as contas liberadas para pagamento" : "todas as contas em aberto"}.{" "}
          <Link href={link({ cartao: "" })} className="underline">
            Ver todas
          </Link>
        </div>
      )}

      <BarraSelecao podeBaixar={podeBaixar} podeAlterar={u.perfil === "financeiro" || u.perfil === "suprimentos"} categorias={categorias} contas={contasBanc} />

      <div className="overflow-x-auto rounded-b-lg border-x border-b border-slate-200 bg-white">
        {visiveis.length === 0 ? (
          <Vazio>Nenhuma conta neste período com esses filtros.</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th className="w-8">
                  <MarcarTodas />
                </th>
                <th>Vencimento</th>
                <th>Pagamento</th>
                <th>Resumo</th>
                <th className="text-right">Valor (R$)</th>
                <th className="text-right">A pagar (R$)</th>
                <th>Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visiveis.map((l) => {
                const atrasada = l.tipo !== "provisao" && !["pago", "cancelado"].includes(l.situacao) && !!l.vencimento && l.vencimento < hoje;
                const podeEditar = l.tipo !== "provisao" && !["pago", "cancelado"].includes(l.statusPagamento ?? "") && (u.perfil === "financeiro" || u.perfil === "suprimentos" || l.criadoPor === u.id);
                const faixa = atrasada ? "shadow-[inset_4px_0_0_#dc2626]" : "";
                return (
                  <tr key={l.chave} data-linha={l.chave} className={cx(l.tipo === "provisao" && "text-slate-400")}>
                    <td className={faixa}>
                      {l.tipo !== "provisao" && (
                        <input
                          type="checkbox"
                          name="itens"
                          value={l.chave}
                          form="form-baixar"
                          data-valor={l.tipo === "pagamento" || l.tipo === "parcela" ? (l.aPagar || l.valor) : 0}
                          data-baixavel={l.baixavel ? "1" : "0"}
                          data-pago={l.situacao === "pago" ? "1" : "0"}
                          data-pagamento={l.pagamentoId ?? ""}
                          className="caixa-baixar"
                          aria-label={`Marcar nº ${l.numero}${l.parcela ? ` parcela ${l.parcela.n}` : ""}`}
                        />
                      )}
                    </td>
                    <td className={cx("whitespace-nowrap tabular-nums", atrasada && "font-medium text-red-700")}>{data(l.vencimento)}</td>
                    <td className="whitespace-nowrap tabular-nums text-slate-600">{l.pagoEm ? data(l.pagoEm) : "—"}</td>
                    <td className="min-w-64">
                      <div className="font-medium text-slate-800">
                        {l.parcela && (
                          <span className="mr-1.5 font-normal text-slate-500">
                            parcela {l.parcela.n}/{l.parcela.total}
                          </span>
                        )}
                        {l.repeticao && <span className="mr-1.5 font-normal">↻ {l.repeticao}</span>}
                        {l.pagamentoId ? (
                          <Link href={`/pagamentos/${l.pagamentoId}?origem=contas`} className="hover:underline">
                            nº {l.numero} · {l.favorecido}
                          </Link>
                        ) : (
                          l.favorecido
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {l.descricao && <span className="text-xs text-slate-500">{l.descricao}</span>}
                        {[l.categoria, l.obra, l.forma ? FORMAS_PAGAMENTO[l.forma] : null, l.conta ? `🏦 ${l.conta}` : null, l.lancadoConciliacao ? "Lançado pela conciliação" : null].filter(Boolean).map((t, i) => (
                          <span key={`${t}-${i}`} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                            {t}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="text-right tabular-nums">{l.tipo === "provisao" ? (l.valor ? `≈ ${semRS(l.valor)}` : "a definir") : semRS(l.valor)}</td>
                    <td className="text-right font-medium tabular-nums">{l.tipo === "provisao" ? "—" : semRS(l.aPagar)}</td>
                    <td>
                      <Situacao l={l} />
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {l.temAnexo && (
                        <span className="mr-2 text-slate-400" title="Tem anexo">
                          📎
                        </span>
                      )}
                      {l.tipo === "provisao" ? (
                        <JanelaProvisao provisao={l.provisao!} podeAgir={u.perfil === "financeiro" || (u.perfil === "suprimentos" && l.criadoPor === u.id)} />
                      ) : (
                        <AcoesLinha
                          pagamentoId={l.pagamentoId!}
                          chave={l.chave}
                          parcelaId={l.parcelaId}
                          ordemId={l.ordemId}
                          numero={l.numero}
                          qtdParcelas={qtdParcelas.get(l.pagamentoId!) ?? 0}
                          pago={l.situacao === "pago"}
                          baixavel={l.baixavel}
                          podeBaixar={podeBaixar}
                          podeEditar={podeEditar}
                          podeEditarParcelas={u.perfil === "financeiro" || l.criadoPor === u.id}
                          podeClonar={l.ordemId ? podeCadastrar : u.perfil === "financeiro" || u.perfil === "suprimentos"}
                          podeCancelar={podeEditar}
                          cancelado={l.situacao === "cancelado"}
                          serie={l.serie}
                          contas={contasBanc}
                          podeAlterarConta={l.situacao !== "cancelado" && (u.perfil === "financeiro" || (l.situacao !== "pago" && (l.criadoPor === u.id || podeEditar)))}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <MemoriaSelecao key={`${consulta}&p=${pagina}`} limpar={typeof sp.baixados === "string"} />
        {visiveis.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
            <span>
              Mostrando {visiveis.length} de {linhas.length} · Soma da lista: <strong className="tabular-nums">{moeda(somaLista)}</strong>
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
