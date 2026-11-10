import type { Metadata } from "next";
import Link from "next/link";
import { TabelaPagamentos } from "@/components/pagamentos";
import { Cabecalho, Cartao, LinkBotao, classeBotao } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { listarPagamentos, POR_PAGINA, somar, type FiltrosPagamento } from "@/lib/consultas/pagamentos";
import { data, moeda } from "@/lib/formato";
import { FORMAS_PAGAMENTO, STATUS_PAGAMENTO } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Pagamentos" };

function str(v: string | string[] | undefined) {
  return typeof v === "string" ? v : "";
}

export default async function PagamentosPage({ searchParams }: PageProps<"/pagamentos">) {
  const sp = await searchParams;
  const u = await getUsuario();
  const filtros: FiltrosPagamento = {
    busca: str(sp.busca),
    obra: str(sp.obra),
    fornecedor: str(sp.fornecedor),
    status: str(sp.status),
    forma: str(sp.forma),
    de: str(sp.de),
    ate: str(sp.ate),
  };
  const pagina = Math.max(1, Number(str(sp.pagina)) || 1);

  const supabase = await createClient();
  const [{ itens, total }, { data: obras }] = await Promise.all([
    listarPagamentos(filtros, pagina),
    supabase.from("obras").select("id, nome").order("nome"),
  ]);

  // Provisões em aberto que casam com os filtros: aparecem para saber o que vence no dia,
  // mas não entram na soma (ainda não são pagamento). Só quando o filtro não é de pagamentos já lançados.
  const mostrarProvisoes = !filtros.status || filtros.status === "abertos";
  let provisoes: { id: string; descricao: string; vencimento: string | null; valor_estimado: number | null; mes_referencia: string | null; obra: { nome: string } | null }[] = [];
  if (mostrarProvisoes) {
    let q = supabase
      .from("provisoes")
      .select("id, descricao, vencimento, valor_estimado, mes_referencia, obra:obras(nome)")
      .eq("status", "provisionada")
      .order("vencimento", { ascending: true, nullsFirst: false })
      .limit(300);
    if (filtros.obra) q = q.eq("obra_id", filtros.obra);
    if (filtros.de) q = q.gte("vencimento", filtros.de);
    if (filtros.ate) q = q.lte("vencimento", filtros.ate);
    if (filtros.busca) q = q.ilike("descricao", `%${filtros.busca}%`);
    const { data: lista } = await q;
    provisoes = (lista ?? []) as typeof provisoes;
  }

  // Parcelas a pagar de pagamentos parcelados, no filtro de datas: cada uma no seu vencimento.
  let parcelasLista: { id: string; numero: number; vencimento: string; valor: number; pagamentoId: string; descricao: string; favorecido: string; obra: string }[] = [];
  if (mostrarProvisoes) {
    let pq = supabase
      .from("pagamento_parcelas")
      .select("id, numero, vencimento, valor_base, multa, juros, desconto, pagamento:pagamentos!inner(id, descricao, favorecido, status, obra_id, obra:obras(nome))")
      .eq("status", "a_pagar")
      .in("pagamento.status", ["aguardando_engenheiro", "aguardando_administrador", "aguardando_pagamento"])
      .order("vencimento", { ascending: true })
      .limit(300);
    if (filtros.de) pq = pq.gte("vencimento", filtros.de);
    if (filtros.ate) pq = pq.lte("vencimento", filtros.ate);
    if (filtros.obra) pq = pq.eq("pagamento.obra_id", filtros.obra);
    if (filtros.busca) pq = pq.or(`descricao.ilike.%${filtros.busca}%,favorecido.ilike.%${filtros.busca}%`, { referencedTable: "pagamentos" });
    const { data: pcs } = await pq;
    parcelasLista = (pcs ?? []).map((pc) => {
      const pg = pc.pagamento as unknown as { id: string; descricao: string; favorecido: string; obra: { nome: string } | null };
      return {
        id: pc.id,
        numero: pc.numero,
        vencimento: pc.vencimento,
        valor: Math.round((Number(pc.valor_base) + Number(pc.multa) + Number(pc.juros) - Number(pc.desconto)) * 100) / 100,
        pagamentoId: pg.id,
        descricao: pg.descricao,
        favorecido: pg.favorecido,
        obra: pg.obra?.nome ?? "",
      };
    });
  }

  const qs = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v) as [string, string][]);
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const linkPagina = (n: number) => {
    const q = new URLSearchParams(qs);
    q.set("pagina", String(n));
    return `/pagamentos?${q}`;
  };

  return (
    <>
      <Cabecalho
        titulo="Pagamentos"
        subtitulo={`${total} pagamento(s) encontrados`}
        acoes={
          <>
            <a href={`/pagamentos/exportar?${qs}`} className={classeBotao("secundario")}>
              Exportar planilha
            </a>
            {(u.perfil === "financeiro" || u.perfil === "administrador_master") && (
              <LinkBotao href="/pagamentos/baixa-lote" variante="secundario">
                Baixa em lote
              </LinkBotao>
            )}
            {(u.perfil === "financeiro" || u.perfil === "suprimentos") && (
              <LinkBotao href="/pagamentos/novo">+ Novo pagamento</LinkBotao>
            )}
          </>
        }
      />

      <Cartao className="mb-4">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6" method="get">
          <input name="busca" defaultValue={filtros.busca} placeholder="Buscar favorecido, descrição, nº…" className="campo lg:col-span-2" />
          <select name="obra" defaultValue={filtros.obra} className="campo">
            <option value="">Todas as obras</option>
            {(obras ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.nome}
              </option>
            ))}
          </select>
          <select name="forma" defaultValue={filtros.forma} className="campo" aria-label="Forma de pagamento">
            <option value="">Todas as formas</option>
            {Object.entries(FORMAS_PAGAMENTO).map(([v, r]) => (
              <option key={v} value={v}>
                {r}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={filtros.status} className="campo">
            <option value="">Todas as situações</option>
            <option value="abertos">Em aberto</option>
            <option value="em_aprovacao">Em aprovação</option>
            {Object.entries(STATUS_PAGAMENTO).map(([v, s]) => (
              <option key={v} value={v}>
                {s.rotulo}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1 lg:col-span-2">
            <input type="date" name="de" defaultValue={filtros.de} className="campo" aria-label="Vencimento de" title="Vencimento de" />
            <span className="text-slate-400">a</span>
            <input type="date" name="ate" defaultValue={filtros.ate} className="campo" aria-label="Vencimento até" title="Vencimento até" />
          </div>
          {filtros.fornecedor && <input type="hidden" name="fornecedor" value={filtros.fornecedor} />}
          <div className="flex gap-2 lg:col-span-6">
            <button type="submit" className={classeBotao("primario", "sm")}>
              Filtrar
            </button>
            <Link href="/pagamentos" className={classeBotao("fantasma", "sm")}>
              Limpar
            </Link>
          </div>
        </form>
      </Cartao>

      {parcelasLista.length > 0 && (
        <Cartao titulo={`Parcelas a pagar no filtro (${parcelasLista.length}) · cada uma no seu vencimento`} semPadding className="mb-4">
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Vencimento</th>
                  <th>Favorecido / descrição</th>
                  <th>Centro de custo</th>
                  <th>Parcela</th>
                  <th className="text-right">Valor</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {parcelasLista.map((pc) => (
                  <tr key={pc.id}>
                    <td className="whitespace-nowrap tabular-nums">{data(pc.vencimento)}</td>
                    <td className="min-w-48"><span className="font-medium">{pc.favorecido}</span><div className="text-xs text-slate-500">{pc.descricao}</div></td>
                    <td>{pc.obra}</td>
                    <td className="whitespace-nowrap">{pc.numero}ª</td>
                    <td className="text-right font-medium tabular-nums">{moeda(pc.valor)}</td>
                    <td><Link href={`/pagamentos/${pc.pagamentoId}`} className="text-marca-700 hover:underline">Ver pagamento</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}

      {provisoes.length > 0 && (
        <Cartao titulo={`Provisões no filtro (${provisoes.length}) · não entram na soma`} semPadding className="mb-4">
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
                </tr>
              </thead>
              <tbody>
                {provisoes.map((pr) => (
                  <tr key={pr.id}>
                    <td className="min-w-48 font-medium">{pr.descricao}</td>
                    <td>{pr.obra?.nome}</td>
                    <td className="whitespace-nowrap">{pr.mes_referencia ?? "—"}</td>
                    <td className="whitespace-nowrap tabular-nums">{pr.vencimento ? data(pr.vencimento) : "—"}</td>
                    <td className="text-right tabular-nums">{pr.valor_estimado === null ? <span className="text-slate-400">a definir</span> : moeda(pr.valor_estimado)}</td>
                    <td>
                      <Link href="/provisoes" className="text-marca-700 hover:underline">
                        Provisionada
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Cartao>
      )}

      <Cartao semPadding>
        <TabelaPagamentos itens={itens} />
        {itens.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-slate-600">
            <span>
              Soma desta página: <strong className="tabular-nums">{moeda(somar(itens))}</strong>
            </span>
            {paginas > 1 && (
              <span className="flex items-center gap-2">
                {pagina > 1 && (
                  <Link href={linkPagina(pagina - 1)} className="hover:underline">
                    ← Anterior
                  </Link>
                )}
                Página {pagina} de {paginas}
                {pagina < paginas && (
                  <Link href={linkPagina(pagina + 1)} className="hover:underline">
                    Próxima →
                  </Link>
                )}
              </span>
            )}
          </div>
        )}
      </Cartao>
    </>
  );
}
