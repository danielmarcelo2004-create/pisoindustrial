"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { OPCOES_PERIODO, deslocarPeriodo, paramsPeriodo, periodoDe, type Periodo } from "@/lib/periodo";

type Opcao = { v: string; r: string };
type Chave = "obra" | "categoria" | "fornecedor" | "forma" | "conta";

const FILTROS: { chave: Chave | "cancelados"; rotulo: string }[] = [
  { chave: "obra", rotulo: "Centro de custo" },
  { chave: "categoria", rotulo: "Categoria" },
  { chave: "fornecedor", rotulo: "Fornecedor" },
  { chave: "forma", rotulo: "Forma de pagamento" },
  { chave: "conta", rotulo: "Conta bancária" },
  { chave: "cancelados", rotulo: "Mostrar cancelados" },
];

const Seta = ({ abre }: { abre?: boolean }) => (
  <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${abre ? "rotate-180" : ""}`} fill="currentColor" aria-hidden>
    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
  </svg>
);

/**
 * Barra de filtros da tela "Contas a pagar": período de vencimento, pesquisa e "Mais filtros".
 * Cada filtro aplicado vira uma etiqueta acima dos cartões; a janela fecha ao aplicar.
 */
export function BarraFiltros({
  consulta,
  periodo,
  hoje,
  busca,
  opcoes,
  valores,
}: {
  consulta: string;
  periodo: Periodo;
  hoje: string;
  busca: string;
  opcoes: Record<Chave, Opcao[]>;
  valores: Record<Chave, string> & { cancelados: boolean };
}) {
  const router = useRouter();
  const [carregando, iniciar] = useTransition();
  const [aberto, setAberto] = useState(""); // "periodo" | "mais" | "filtro:<chave>"
  const [editando, setEditando] = useState<Chave | "">(""); // filtro novo ainda sem valor (etiqueta tracejada)
  const [personalizado, setPersonalizado] = useState(periodo.tipo === "personalizado");
  const [de, setDe] = useState(periodo.de);
  const [ate, setAte] = useState(periodo.ate);
  const [pesquisa, setPesquisa] = useState("");
  const [escolha, setEscolha] = useState("");

  // Fecha a janela aberta ao clicar fora dela ou apertar Esc
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(`[data-pop="${aberto}"]`)) fechar();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    document.addEventListener("mousedown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("keydown", esc);
    };
  });

  function fechar() {
    setAberto("");
    setEditando("");
  }

  function ir(mudancas: Record<string, string>) {
    const q = new URLSearchParams(consulta);
    q.delete("pagina");
    for (const [k, v] of Object.entries(mudancas)) {
      if (v) q.set(k, v);
      else q.delete(k);
    }
    fechar();
    iniciar(() => router.push(`/pagamentos?${q}`));
  }

  function abrirFiltro(chave: Chave) {
    setPesquisa("");
    setEscolha(valores[chave]);
    setAberto(`filtro:${chave}`);
  }

  const anterior = deslocarPeriodo(periodo, -1, hoje);
  const seguinte = deslocarPeriodo(periodo, 1, hoje);
  const ativos = FILTROS.filter((f) => (f.chave === "cancelados" ? valores.cancelados : valores[f.chave]));
  const algumFiltro = ativos.length > 0 || Boolean(busca);
  const nomeDe = (chave: Chave, v: string) => opcoes[chave].find((o) => o.v === v)?.r ?? "—";

  const chaveAberta = aberto.startsWith("filtro:") ? (aberto.slice(7) as Chave) : "";
  const lista = useMemo(() => {
    if (!chaveAberta) return [];
    const t = pesquisa.trim().toLocaleLowerCase("pt-BR");
    return opcoes[chaveAberta].filter((o) => !t || o.r.toLocaleLowerCase("pt-BR").includes(t));
  }, [chaveAberta, pesquisa, opcoes]);

  const janelaFiltro = (chave: Chave, rotulo: string) =>
    aberto === `filtro:${chave}` && (
      <div className="absolute left-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-md border border-slate-200 bg-white shadow-lg" role="dialog" aria-label={`Filtrar por ${rotulo}`}>
        <div className="border-b border-slate-100 p-2">
          <input autoFocus value={pesquisa} onChange={(e) => setPesquisa(e.target.value)} placeholder={`Pesquisar ${rotulo.toLowerCase()}`} className="campo" aria-label={`Pesquisar ${rotulo}`} />
        </div>
        <ul className="max-h-60 overflow-y-auto py-1">
          {lista.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Nada encontrado.</li>}
          {lista.map((o) => (
            <li key={o.v}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                <input type="radio" name={`filtro-${chave}`} checked={escolha === o.v} onChange={() => setEscolha(o.v)} />
                {o.r}
              </label>
            </li>
          ))}
        </ul>
        <div className="border-t border-slate-100 p-2">
          <button type="button" disabled={!escolha} onClick={() => ir({ [chave]: escolha })} className="w-full rounded-md bg-marca-700 px-3 py-2 text-sm font-semibold text-white hover:bg-marca-800 disabled:opacity-50">
            Aplicar
          </button>
        </div>
      </div>
    );

  return (
    <div className={`mb-4 ${carregando ? "opacity-70" : ""}`} aria-busy={carregando}>
      <div className="flex flex-wrap items-end gap-3">
        {/* Vencimento */}
        <div>
          <div className="mb-1 text-xs text-slate-600">Vencimento</div>
          <div className="relative flex rounded-md border border-slate-300 bg-white" data-pop="periodo">
            <button type="button" disabled={!anterior} onClick={() => anterior && ir(paramsPeriodo(anterior))} className="px-3 py-2 text-sky-800 hover:bg-slate-50 disabled:text-slate-300" aria-label="Período anterior">
              ‹
            </button>
            <button
              type="button"
              onClick={() => {
                setPersonalizado(periodo.tipo === "personalizado");
                setDe(periodo.de);
                setAte(periodo.ate);
                setAberto(aberto === "periodo" ? "" : "periodo");
              }}
              aria-expanded={aberto === "periodo"}
              aria-label="Período de vencimento"
              className="flex min-w-48 items-center justify-center gap-2 border-x border-slate-200 px-3 py-2 text-sm font-semibold text-sky-800 hover:bg-slate-50"
            >
              <span data-periodo-rotulo>{periodo.rotulo}</span>
              <Seta abre={aberto === "periodo"} />
            </button>
            <button type="button" disabled={!seguinte} onClick={() => seguinte && ir(paramsPeriodo(seguinte))} className="px-3 py-2 text-sky-800 hover:bg-slate-50 disabled:text-slate-300" aria-label="Próximo período">
              ›
            </button>
            {aberto === "periodo" && (
              <div className="absolute left-0 top-full z-30 mt-1 w-full min-w-64 rounded-md border border-slate-200 bg-white py-1 shadow-lg" role="menu">
                {OPCOES_PERIODO.map((o) => (
                  <button
                    key={o.tipo}
                    type="button"
                    role="menuitem"
                    onClick={() => ir(paramsPeriodo(periodoDe(o.tipo, hoje, hoje)))}
                    className={`block w-full px-4 py-2 text-left text-sm hover:bg-slate-50 ${periodo.tipo === o.tipo && !personalizado ? "font-semibold text-sky-800" : "text-slate-700"}`}
                  >
                    {o.rotulo}
                  </button>
                ))}
                <button type="button" role="menuitem" onClick={() => setPersonalizado(!personalizado)} className={`block w-full px-4 py-2 text-left text-sm hover:bg-slate-50 ${personalizado ? "font-semibold text-sky-800" : "text-slate-700"}`}>
                  Período personalizado
                </button>
                {personalizado && (
                  <div className="grid gap-2 border-t border-slate-100 px-4 py-3">
                    <label className="text-xs text-slate-600">
                      De
                      <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className="campo mt-1" aria-label="Vencimento de" />
                    </label>
                    <label className="text-xs text-slate-600">
                      Até
                      <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className="campo mt-1" aria-label="Vencimento até" />
                    </label>
                    {de && ate && de > ate && <p className="text-xs text-red-600">A data inicial é depois da final.</p>}
                    <button
                      type="button"
                      disabled={(!de && !ate) || Boolean(de && ate && de > ate)}
                      onClick={() => ir(paramsPeriodo(periodoDe("personalizado", hoje, hoje, de, ate)))}
                      className="rounded-md bg-marca-700 px-3 py-2 text-sm font-semibold text-white hover:bg-marca-800 disabled:opacity-50"
                    >
                      Aplicar período
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Pesquisa */}
        <form
          key={busca}
          className="min-w-56 flex-1 sm:max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            ir({ busca: String(new FormData(e.currentTarget).get("busca") ?? "").trim() });
          }}
        >
          <div className="mb-1 text-xs text-slate-600">Pesquisar no período</div>
          <div className="flex">
            <input name="busca" defaultValue={busca} placeholder="Favorecido, descrição ou nº" className="campo rounded-r-none" aria-label="Pesquisar" />
            <button type="submit" className="rounded-r-md border border-l-0 border-slate-300 bg-white px-3 text-sky-800 hover:bg-slate-50" aria-label="Pesquisar agora">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 3.47 9.77l3.13 3.13a.75.75 0 1 0 1.06-1.06l-3.13-3.13A5.5 5.5 0 0 0 9 3.5ZM5 9a4 4 0 1 1 8 0 4 4 0 0 1-8 0Z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </form>

        {/* Mais filtros */}
        <div className="relative" data-pop="mais">
          <button
            type="button"
            onClick={() => setAberto(aberto === "mais" ? "" : "mais")}
            aria-expanded={aberto === "mais"}
            className="flex items-center gap-2 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-800 hover:bg-sky-100"
          >
            Mais filtros
            {ativos.length > 0 && <span className="rounded-full bg-sky-800 px-1.5 text-xs text-white">{ativos.length}</span>}
            <Seta abre={aberto === "mais"} />
          </button>
          {aberto === "mais" && (
            <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-md border border-slate-200 bg-white py-1 shadow-lg sm:left-0 sm:right-auto" role="menu">
              {FILTROS.map((f) => {
                const ativo = f.chave === "cancelados" ? valores.cancelados : Boolean(valores[f.chave]);
                return (
                  <button
                    key={f.chave}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      if (f.chave === "cancelados") return ir({ cancelados: valores.cancelados ? "" : "1" });
                      if (!valores[f.chave]) setEditando(f.chave);
                      abrirFiltro(f.chave);
                    }}
                    className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                  >
                    {f.rotulo}
                    {ativo && <span className="text-sky-700">✓</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Filtros selecionados */}
      {(algumFiltro || editando) && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-slate-600">Filtros selecionados</div>
          <div className="flex flex-wrap items-center gap-2">
            {busca && (
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-white px-3 py-1 text-sm text-sky-900" data-filtro="busca">
                Pesquisa: “{busca}”
                <button type="button" onClick={() => ir({ busca: "" })} className="ml-1 text-sky-700 hover:text-red-600" aria-label="Remover filtro Pesquisa">
                  ✕
                </button>
              </span>
            )}
            {FILTROS.map((f) => {
              if (f.chave === "cancelados") {
                return (
                  valores.cancelados && (
                    <span key={f.chave} className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-white px-3 py-1 text-sm text-sky-900" data-filtro="cancelados">
                      Mostrando cancelados
                      <button type="button" onClick={() => ir({ cancelados: "" })} className="ml-1 text-sky-700 hover:text-red-600" aria-label="Remover filtro Mostrar cancelados">
                        ✕
                      </button>
                    </span>
                  )
                );
              }
              const chave = f.chave;
              const valor = valores[chave];
              if (!valor && editando !== chave) return null;
              return (
                <span key={chave} className="relative" data-pop={`filtro:${chave}`}>
                  <span className={`inline-flex items-center gap-1 rounded-full border bg-white px-3 py-1 text-sm text-sky-900 ${valor ? "border-sky-300" : "border-dashed border-sky-400"}`} data-filtro={chave}>
                    <button type="button" onClick={() => (aberto === `filtro:${chave}` ? fechar() : abrirFiltro(chave))} className="hover:underline">
                      {valor ? `${f.rotulo}: ${nomeDe(chave, valor)}` : f.rotulo}
                    </button>
                    {valor && (
                      <button type="button" onClick={() => ir({ [chave]: "" })} className="ml-1 text-sky-700 hover:text-red-600" aria-label={`Remover filtro ${f.rotulo}`}>
                        ✕
                      </button>
                    )}
                  </span>
                  {janelaFiltro(chave, f.rotulo)}
                </span>
              );
            })}
            {algumFiltro && (
              <button type="button" onClick={() => ir({ obra: "", categoria: "", fornecedor: "", forma: "", conta: "", cancelados: "", busca: "" })} className="px-2 py-1 text-sm text-sky-700 hover:underline">
                Limpar filtros
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
