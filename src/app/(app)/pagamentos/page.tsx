import type { Metadata } from "next";
import Link from "next/link";
import { TabelaPagamentos } from "@/components/pagamentos";
import { Cabecalho, Cartao, LinkBotao, classeBotao } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { listarPagamentos, POR_PAGINA, somar, type FiltrosPagamento } from "@/lib/consultas/pagamentos";
import { moeda } from "@/lib/formato";
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
