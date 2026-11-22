"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { moeda } from "@/lib/formato";
import { acaoEmLote, alterarContaBancaria, clonarLancamento, voltarParaEmAberto } from "./actions";

const SELETOR = 'input.caixa-baixar[form="form-baixar"]';

/** Envia o formulário de filtros quando um campo muda (mês, centro de custo etc.). */
export function EnviarAoMudar() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const aoMudar = (e: Event) => {
      if ((e.target as HTMLElement).dataset.auto !== undefined) form.requestSubmit();
    };
    form.addEventListener("change", aoMudar);
    return () => form.removeEventListener("change", aoMudar);
  }, []);
  return <span ref={ref} hidden />;
}

export const CHAVE_SELECAO = "contas-a-pagar:selecao";
export const CHAVE_LISTA = "contas-a-pagar:lista";
const EVENTO = "selecao-contas";
type ItemMarcado = { valor: number; baixavel: boolean; pago: boolean; pagamento: string };
type Memoria = Record<string, ItemMarcado>;

const gravar = (k: string, v: string | null) => {
  try {
    if (v === null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, v);
  } catch {
    /* navegador sem armazenamento: só não lembra */
  }
};
/** Contas marcadas nesta aba, inclusive as que não aparecem na lista atual (outra busca, outro filtro, outro mês). */
export function lerMemoria(): Memoria {
  try {
    const m = JSON.parse(sessionStorage.getItem(CHAVE_SELECAO) ?? "{}");
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}
function gravarMemoria(m: Memoria) {
  gravar(CHAVE_SELECAO, Object.keys(m).length ? JSON.stringify(m) : null);
  document.dispatchEvent(new Event(EVENTO));
}
const itemDe = (c: HTMLInputElement): ItemMarcado => ({
  valor: Number(c.dataset.valor ?? 0),
  baixavel: c.dataset.baixavel === "1",
  pago: c.dataset.pago === "1",
  pagamento: c.dataset.pagamento ?? "",
});
/** Seleção atual: a memória com as caixinhas da tela por cima (as da tela valem como estão marcadas). */
function selecaoAtual(): Memoria {
  const m = lerMemoria();
  document.querySelectorAll<HTMLInputElement>(SELETOR).forEach((c) => {
    if (c.checked) m[c.value] = itemDe(c);
    else delete m[c.value];
  });
  return m;
}
/** Desmarca tudo: as da tela e as lembradas de outras buscas. */
export function limparSelecao() {
  document.querySelectorAll<HTMLInputElement>(SELETOR).forEach((c) => (c.checked = false));
  gravarMemoria({});
  document.dispatchEvent(new Event("change"));
}

/**
 * Memória das contas marcadas (nesta aba do navegador). Marcar contas, abrir uma e voltar, ou fazer outra busca
 * com outros filtros, mantém as marcações — as que saem da lista continuam marcadas e entram no Baixar e nas
 * Ações em lote. Também guarda o endereço da lista para o "← Contas a pagar" voltar para ela.
 * Depois de uma baixa concluída, a memória é limpa.
 */
export function MemoriaSelecao({ limpar }: { limpar: boolean }) {
  useEffect(() => {
    gravar(CHAVE_LISTA, window.location.pathname + window.location.search.replace(/([?&])baixados=\d+&?/, "$1").replace(/[?&]$/, ""));
    // Sincroniza: as da tela valem como estão marcadas; as de fora da tela ficam como estavam
    const salvar = () => gravarMemoria(selecaoAtual());
    if (limpar) {
      gravarMemoria({});
    } else {
      const m = lerMemoria();
      document.querySelectorAll<HTMLInputElement>(SELETOR).forEach((c) => {
        c.checked = c.value in m;
      });
      salvar(); // atualiza valor e situação das que estão na tela (podem ter mudado)
      document.dispatchEvent(new Event("change"));
    }
    document.addEventListener("change", salvar);
    return () => document.removeEventListener("change", salvar);
  }, [limpar]);
  return null;
}

/** Caixinha do cabeçalho: marca ou desmarca todas as contas que podem ser baixadas. */
export function MarcarTodas() {
  const [todas, setTodas] = useState(false);
  useEffect(() => {
    const atualizar = () => {
      const caixas = Array.from(document.querySelectorAll<HTMLInputElement>(SELETOR));
      setTodas(caixas.length > 0 && caixas.every((c) => c.checked));
    };
    document.addEventListener("change", atualizar);
    return () => document.removeEventListener("change", atualizar);
  }, []);
  return (
    <input
      type="checkbox"
      aria-label="Marcar todas as contas a pagar"
      checked={todas}
      onChange={(e) => {
        document.querySelectorAll<HTMLInputElement>(SELETOR).forEach((c) => (c.checked = e.target.checked));
        document.dispatchEvent(new Event("change"));
      }}
    />
  );
}

/** Barra acima da tabela: quantas contas marcadas, total e o botão Baixar (1 = individual; várias = em lote). */
type Lote = "categoria" | "conta" | "competencia" | "estornar" | "cancelar";

/**
 * Barra acima da tabela: quantas contas marcadas, total, "Baixar" (1 = individual; várias = em lote)
 * e "Ações em lote" (exportar, alterar categoria/competência, voltar para em aberto, cancelar).
 */
export function BarraSelecao({ podeBaixar, podeAlterar, categorias, contas = [] }: { podeBaixar: boolean; podeAlterar: boolean; categorias: { id: string; nome: string }[]; contas?: { id: string; nome: string }[] }) {
  const router = useRouter();
  const [qtd, setQtd] = useState(0);
  const [total, setTotal] = useState(0);
  const [baixaveis, setBaixaveis] = useState(0);
  const [pagas, setPagas] = useState(0);
  const [menu, setMenu] = useState(false);
  const [dialogo, setDialogo] = useState<Lote | null>(null);
  const [valor, setValor] = useState("");
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [pendente, iniciar] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  const [fora, setFora] = useState<string[]>([]); // marcadas em outra busca/filtro (não estão na tela)

  useEffect(() => {
    // Lê na hora do clique (evento "change") e também quando a memória muda (outra busca, limpar)
    const atualizar = () => {
      const sel = selecaoAtual();
      const m = Object.values(sel);
      const naTela = new Set(Array.from(document.querySelectorAll<HTMLInputElement>(SELETOR)).map((c) => c.value));
      setQtd(m.length);
      setTotal(m.reduce((s, c) => s + Number(c.valor || 0), 0));
      setBaixaveis(m.filter((c) => c.baixavel).length);
      setPagas(m.filter((c) => c.pago).length);
      setFora(Object.keys(sel).filter((k) => !naTela.has(k)));
    };
    document.addEventListener("change", atualizar);
    document.addEventListener(EVENTO, atualizar);
    atualizar();
    return () => {
      document.removeEventListener("change", atualizar);
      document.removeEventListener(EVENTO, atualizar);
    };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const fora = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [menu]);

  const chaves = () => Object.keys(selecaoAtual());
  const exportar = () => {
    const ids = [...new Set(Object.values(selecaoAtual()).map((c) => c.pagamento).filter(Boolean))];
    // Download da planilha (rota de arquivo, não é uma página)
    const link = document.createElement("a");
    link.href = `/pagamentos/exportar?ids=${ids.join(",")}`;
    link.click();
    setMenu(false);
  };
  const abrir = (d: Lote) => {
    setDialogo(d);
    setValor(d === "competencia" ? new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) : "");
    setMenu(false);
    setMsg(null);
  };
  const executar = () =>
    iniciar(async () => {
      const dados = dialogo === "categoria" ? { categoria: valor } : dialogo === "conta" ? { conta: valor } : dialogo === "competencia" ? { competencia: valor } : { motivo: valor };
      const r = await acaoEmLote(dialogo!, chaves(), dados);
      setMsg(r.erro ? { tipo: "erro", texto: r.erro } : { tipo: "ok", texto: r.ok ?? "Feito." });
      setDialogo(null);
      limparSelecao();
      router.refresh();
    });

  const item = "block w-full px-4 py-2 text-left text-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300";
  const titulo: Record<Lote, string> = {
    categoria: "Alterar categoria",
    conta: "Alterar conta bancária",
    competencia: "Alterar data de competência",
    estornar: "Voltar para em aberto",
    cancelar: "Cancelar lançamentos",
  };
  return (
    <div className="border-x border-b border-slate-200">
      <form id="form-baixar" method="get" action="/pagamentos/baixar" className={`flex flex-wrap items-center gap-3 px-4 py-2 text-sm ${qtd ? "bg-sky-50" : "bg-slate-50"}`}>
        <strong className="text-slate-800" role="status">
          {qtd ? `${qtd} selecionada(s) · ${moeda(total)}` : "Nenhuma conta selecionada"}
        </strong>
        {fora.map((k) => (
          <input key={k} type="hidden" name="itens" value={k} />
        ))}
        {fora.length > 0 && (
          <span className="text-xs text-slate-600" data-fora-da-lista>
            {fora.length === 1 ? "1 delas não aparece nesta busca" : `${fora.length} delas não aparecem nesta busca`}
          </span>
        )}
        {qtd > 0 && (
          <button type="button" onClick={limparSelecao} className="text-xs text-sky-700 hover:underline">
            Desmarcar todas
          </button>
        )}
        {podeBaixar && (
          <button
            type="submit"
            disabled={!baixaveis}
            title={qtd && !baixaveis ? "Nenhuma das contas marcadas está liberada para pagamento" : undefined}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Baixar{qtd && baixaveis !== qtd && baixaveis ? ` (${baixaveis})` : ""}
          </button>
        )}
        <div ref={ref} className="relative">
          <button
            type="button"
            disabled={!qtd}
            onClick={() => setMenu((x) => !x)}
            className="rounded-md border border-sky-300 bg-white px-3 py-1.5 text-sm font-medium text-sky-800 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-40"
            aria-haspopup="menu"
            aria-expanded={menu}
          >
            Ações em lote ▾
          </button>
          {menu && (
            <div role="menu" className="absolute left-0 z-30 mt-1 w-64 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
              <button role="menuitem" type="button" className={`${item} text-slate-700`} onClick={exportar}>
                Exportar selecionadas (planilha)
              </button>
              {podeAlterar && (
                <>
                  <button role="menuitem" type="button" className={`${item} text-slate-700`} onClick={() => abrir("categoria")}>
                    Alterar categoria
                  </button>
                  <button role="menuitem" type="button" className={`${item} text-slate-700`} onClick={() => abrir("conta")}>
                    Alterar conta bancária
                  </button>
                  <button role="menuitem" type="button" className={`${item} text-slate-700`} onClick={() => abrir("competencia")}>
                    Alterar data de competência
                  </button>
                </>
              )}
              {podeBaixar && (
                <button role="menuitem" type="button" disabled={!pagas} className={`${item} text-slate-700`} onClick={() => abrir("estornar")}>
                  Voltar para em aberto{pagas ? ` (${pagas})` : ""}
                </button>
              )}
              {podeAlterar && (
                <button role="menuitem" type="button" className={`${item} border-t border-slate-100 text-red-700`} onClick={() => abrir("cancelar")}>
                  Cancelar lançamentos
                </button>
              )}
            </div>
          )}
        </div>
        <span className="text-xs text-slate-500">Marque uma conta para baixa individual ou várias para baixar em lote.</span>
      </form>
      {msg && (
        <div role="alert" data-msg-lote className={`border-t px-4 py-2 text-sm ${msg.tipo === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
          {msg.texto}
        </div>
      )}
      {dialogo && (
        <div role="dialog" aria-label={titulo[dialogo]} className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">{titulo[dialogo]}</h3>
            <p className="mt-1 text-sm text-slate-600">
              {dialogo === "estornar"
                ? `${pagas} conta(s) paga(s) entre as marcadas voltam para “a pagar”. Comprovantes e histórico ficam guardados.`
                : dialogo === "cancelar"
                  ? `Os lançamentos das ${qtd} conta(s) marcadas serão cancelados (numa parcela, o lançamento inteiro). Lançamentos pagos não podem ser cancelados.`
                  : `Vale para os lançamentos das ${qtd} conta(s) marcadas (numa parcela, o lançamento inteiro).`}
            </p>
            <div className="mt-3">
              {dialogo === "categoria" ? (
                <select value={valor} onChange={(e) => setValor(e.target.value)} className="campo" aria-label="Nova categoria">
                  <option value="">Escolha a categoria…</option>
                  {categorias.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nome}
                    </option>
                  ))}
                </select>
              ) : dialogo === "conta" ? (
                <select value={valor} onChange={(e) => setValor(e.target.value)} className="campo" aria-label="Nova conta bancária">
                  <option value="">Escolha a conta bancária…</option>
                  {contas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nome}
                    </option>
                  ))}
                </select>
              ) : dialogo === "competencia" ? (
                <input type="date" value={valor} onChange={(e) => setValor(e.target.value)} className="campo" aria-label="Nova data de competência" />
              ) : (
                <input value={valor} onChange={(e) => setValor(e.target.value)} className="campo" aria-label="Motivo" placeholder="Motivo (obrigatório)" />
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm" onClick={() => setDialogo(null)}>
                Voltar
              </button>
              <button
                type="button"
                disabled={pendente || (dialogo === "cancelar" || dialogo === "estornar" ? valor.trim().length < 3 : !valor)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 ${dialogo === "cancelar" ? "bg-red-600" : dialogo === "estornar" ? "bg-amber-600" : "bg-sky-700"}`}
                onClick={executar}
              >
                {pendente ? "Aplicando…" : "Aplicar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export type AcoesProps = {
  pagamentoId: string;
  chave: string;
  parcelaId: string | null;
  ordemId: string | null;
  numero: number | null;
  qtdParcelas: number;
  pago: boolean;
  baixavel: boolean;
  podeBaixar: boolean;
  podeEditar: boolean;
  /** Financeiro ou quem cadastrou (regra do banco para alterar parcelas). */
  podeEditarParcelas: boolean;
  podeClonar: boolean;
  podeCancelar: boolean;
  /** "Alterar conta bancária" (ex.: foi paga por outra conta). */
  contas?: { id: string; nome: string }[];
  podeAlterarConta?: boolean;
};

/** Menu "Ações" de cada linha. Mostra só o que a pessoa pode fazer naquela situação. */
export function AcoesLinha(a: AcoesProps) {
  const [aberto, setAberto] = useState(false);
  // Posição do menu na tela (fixo, para não ser cortado pela tabela); abre para cima se faltar espaço embaixo
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const botao = useRef<HTMLButtonElement>(null);
  function posicionar() {
    const r = botao.current?.getBoundingClientRect();
    if (!r) return;
    const right = Math.max(8, window.innerWidth - r.right);
    setPos(window.innerHeight - r.bottom < 320 ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right });
  }
  function alternar() {
    if (aberto) return setAberto(false);
    posicionar();
    setAberto(true);
  }
  const [estorno, setEstorno] = useState(false);
  const [trocaConta, setTrocaConta] = useState(false);
  const [novaConta, setNovaConta] = useState("");
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState("");
  const [pendente, iniciar] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setAberto(false);
    };
    // O menu acompanha o botão quando a página rola ou a janela muda de tamanho
    const acompanhar = () => {
      const r = botao.current?.getBoundingClientRect();
      if (!r) return;
      const right = Math.max(8, window.innerWidth - r.right);
      setPos((atual) => (atual?.bottom !== undefined ? { bottom: window.innerHeight - r.top + 4, right } : { top: r.bottom + 4, right }));
    };
    document.addEventListener("mousedown", fora);
    window.addEventListener("scroll", acompanhar, true);
    window.addEventListener("resize", acompanhar);
    return () => {
      document.removeEventListener("mousedown", fora);
      window.removeEventListener("scroll", acompanhar, true);
      window.removeEventListener("resize", acompanhar);
    };
  }, [aberto]);

  const base0 = "block w-full px-4 py-2 text-left text-sm hover:bg-slate-50";
  const item = `${base0} text-slate-700`;
  const base = `/pagamentos/${a.pagamentoId}`;
  return (
    <div ref={ref} className="relative inline-block text-left">
      <button ref={botao} type="button" onClick={alternar} className="whitespace-nowrap rounded-md border border-sky-300 bg-white px-2.5 py-1 text-xs font-medium text-sky-800 hover:bg-sky-50" aria-haspopup="menu" aria-expanded={aberto} aria-label={`Ações do nº ${a.numero ?? ""}`}>
        Ações ▾
      </button>
      {aberto && (
        <div role="menu" style={pos ?? undefined} className="fixed z-50 w-64 rounded-md border border-slate-200 bg-white py-1 text-left shadow-lg">
          <Link role="menuitem" href={`${base}?origem=contas`} className={item}>
            Ver detalhes do lançamento
          </Link>
          {a.podeBaixar && a.baixavel && (
            <Link role="menuitem" href={`/pagamentos/baixar?itens=${a.chave}`} className={`${base0} font-medium text-emerald-700`}>
              Baixar
            </Link>
          )}
          {a.podeBaixar && a.pago && (
            <button role="menuitem" type="button" className={item} onClick={() => { setEstorno(true); setAberto(false); }}>
              Voltar para em aberto
            </button>
          )}
          {a.podeBaixar && (a.baixavel || a.pago) && (
            <a role="menuitem" href={`${base}?origem=contas#anexar`} className={item} onClick={() => setAberto(false)}>
              Anexar comprovante
            </a>
          )}
          {a.podeEditar && a.podeEditarParcelas && a.parcelaId && !a.pago && (
            <Link role="menuitem" href={`${base}/parcelas/${a.parcelaId}`} className={item}>
              Editar parcela
            </Link>
          )}
          {a.podeEditar && (
            <Link role="menuitem" href={`${base}/editar`} className={item}>
              {a.qtdParcelas > 1 && a.podeEditarParcelas ? "Editar lançamento (todas as parcelas)" : "Editar lançamento"}
            </Link>
          )}
          {a.podeAlterarConta && (a.contas?.length ?? 0) > 0 && (
            <button role="menuitem" type="button" className={item} onClick={() => { setTrocaConta(true); setNovaConta(""); setErro(""); setAberto(false); }}>
              Alterar conta bancária
            </button>
          )}
          {a.podeClonar && (
            <button
              role="menuitem"
              type="button"
              className={item}
              disabled={pendente}
              onClick={() => iniciar(async () => { const r = await clonarLancamento(a.pagamentoId); if (r?.erro) setErro(r.erro); })}
            >
              {pendente ? "Clonando…" : "Clonar lançamento"}
            </button>
          )}
          {a.podeCancelar && (
            <a role="menuitem" href={`${base}?origem=contas#cancelar`} className={`${base0} border-t border-slate-100 text-red-700`} onClick={() => setAberto(false)}>
              Cancelar lançamento
            </a>
          )}
        </div>
      )}
      {estorno && (
        <div role="dialog" aria-label="Voltar para em aberto" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 text-left shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">Voltar para em aberto</h3>
            <p className="mt-1 text-sm text-slate-600">
              A baixa {a.parcelaId ? "desta parcela" : "deste pagamento"} é desfeita e a conta volta para “a pagar”. O comprovante e o histórico ficam guardados.
            </p>
            <label className="mt-3 block text-sm font-medium text-slate-700">
              Motivo
              <input value={motivo} onChange={(e) => setMotivo(e.target.value)} className="campo mt-1" aria-label="Motivo da volta para em aberto" placeholder="Ex.: pagamento devolvido pelo banco" />
            </label>
            {erro && <p className="mt-2 text-sm text-red-700">{erro}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm" onClick={() => { setEstorno(false); setErro(""); }}>
                Voltar
              </button>
              <button
                type="button"
                disabled={pendente || motivo.trim().length < 3}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                onClick={() =>
                  iniciar(async () => {
                    const r = await voltarParaEmAberto(a.pagamentoId, a.parcelaId, motivo);
                    if (r.erro) setErro(r.erro);
                    else setEstorno(false);
                  })
                }
              >
                {pendente ? "Salvando…" : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}
      {trocaConta && (
        <div role="dialog" aria-label="Alterar conta bancária" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 text-left shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">Alterar conta bancária</h3>
            <p className="mt-1 text-sm text-slate-600">De qual conta sai (ou saiu) o pagamento nº {a.numero}. A troca fica registrada no histórico.</p>
            <select value={novaConta} onChange={(e) => setNovaConta(e.target.value)} className="campo mt-3" aria-label="Nova conta bancária">
              <option value="">Escolha a conta bancária…</option>
              {(a.contas ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
            {erro && <p className="mt-2 text-sm text-red-700">{erro}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm" onClick={() => { setTrocaConta(false); setErro(""); }}>
                Voltar
              </button>
              <button
                type="button"
                disabled={pendente || !novaConta}
                className="rounded-md bg-sky-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                onClick={() =>
                  iniciar(async () => {
                    const r = await alterarContaBancaria(a.pagamentoId, novaConta);
                    if (r.erro) setErro(r.erro);
                    else setTrocaConta(false);
                  })
                }
              >
                {pendente ? "Salvando…" : "Salvar"}
              </button>
            </div>
          </div>
        </div>
      )}
      {erro && !estorno && !trocaConta && <div className="absolute right-0 z-10 mt-1 w-64 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{erro}</div>}
    </div>
  );
}
