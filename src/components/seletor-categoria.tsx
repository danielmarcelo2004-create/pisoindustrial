"use client";

import { useEffect, useRef, useState } from "react";
import { criarCategoriaRapida } from "@/app/(app)/categorias/actions";

type Categoria = { id: string; nome: string };

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Campo de categoria com busca. Financeiro/administrador master também cadastram uma categoria nova
 * numa janelinha, sem sair da tela; a nova categoria já fica selecionada.
 */
export function SeletorCategoria({
  categorias: iniciais,
  valorInicial = null,
  podeAdicionar = false,
  nome = "categoria_id",
}: {
  categorias: Categoria[];
  valorInicial?: string | null;
  podeAdicionar?: boolean;
  nome?: string;
}) {
  const [categorias, setCategorias] = useState<Categoria[]>(iniciais);
  const [selecionada, setSelecionada] = useState<string>(valorInicial ?? "");
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [limite, setLimite] = useState(8);
  const [novaAberta, setNovaAberta] = useState(false);
  const [novoNome, setNovoNome] = useState("");
  const [erro, setErro] = useState("");
  const [salvando, setSalvando] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto && !novaAberta) return;
    const fora = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) {
        setAberto(false);
        setNovaAberta(false);
      }
    };
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto, novaAberta]);

  const filtradas = categorias.filter((c) => normalizar(c.nome).includes(normalizar(busca.trim())));
  const nomeSelecionado = categorias.find((c) => c.id === selecionada)?.nome;

  async function cadastrar() {
    setErro("");
    if (!novoNome.trim()) {
      setErro("Informe o nome da categoria.");
      return;
    }
    setSalvando(true);
    try {
      const r = await criarCategoriaRapida(novoNome);
      if (r.erro || !r.id) {
        setErro(r.erro ?? "Não foi possível cadastrar.");
        return;
      }
      const nova = { id: r.id, nome: r.nome ?? novoNome.trim() };
      setCategorias((xs) => (xs.some((x) => x.id === nova.id) ? xs : [...xs, nova].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))));
      setSelecionada(nova.id);
      setNovoNome("");
      setNovaAberta(false);
      setAberto(false);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div ref={caixa} className="relative">
      <input type="hidden" name={nome} value={selecionada} />
      <button
        type="button"
        aria-label="Categoria"
        aria-expanded={aberto}
        onClick={() => {
          setAberto((v) => !v);
          setNovaAberta(false);
        }}
        className="campo flex w-full items-center justify-between text-left"
      >
        <span className={nomeSelecionado ? "" : "text-slate-400"}>{nomeSelecionado ?? "Selecione a categoria…"}</span>
        <span aria-hidden className="text-slate-500">▾</span>
      </button>

      {aberto && (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <input
              autoFocus
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                setLimite(8);
              }}
              placeholder="Buscar categoria…"
              aria-label="Buscar categoria"
              className="campo"
            />
          </div>
          <ul role="listbox" className="max-h-64 overflow-y-auto py-1 text-sm">
            {filtradas.length === 0 && <li className="px-3 py-2 text-slate-500">Nenhuma categoria encontrada.</li>}
            {filtradas.slice(0, limite).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={c.id === selecionada}
                  onClick={() => {
                    setSelecionada(c.id);
                    setAberto(false);
                    setBusca("");
                  }}
                  className={`block w-full px-3 py-2 text-left hover:bg-sky-50 ${c.id === selecionada ? "bg-sky-100 font-medium" : ""}`}
                >
                  {c.nome}
                </button>
              </li>
            ))}
          </ul>
          {filtradas.length > limite && (
            <button type="button" onClick={() => setLimite((n) => n + 20)} className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm text-marca-700 hover:bg-slate-50">
              ⌄ Mostrar mais
            </button>
          )}
          {podeAdicionar && (
            <button
              type="button"
              onClick={() => {
                setNovaAberta(true);
                setNovoNome(busca.trim());
                setAberto(false);
              }}
              className="block w-full border-t border-slate-100 px-3 py-2 text-left text-sm font-medium text-marca-700 hover:bg-slate-50"
            >
              + Adicionar nova categoria
            </button>
          )}
        </div>
      )}

      {novaAberta && (
        <div role="dialog" aria-label="Cadastro de categoria" className="absolute z-40 mt-1 w-full max-w-sm rounded-md border border-slate-200 bg-white p-4 shadow-xl">
          <h4 className="mb-3 border-b border-slate-100 pb-2 text-sm font-semibold">Cadastro de categoria</h4>
          <label className="block text-sm text-slate-700">
            Nova categoria <span className="text-red-600">*</span>
            <input
              autoFocus
              value={novoNome}
              onChange={(e) => setNovoNome(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void cadastrar();
                }
              }}
              maxLength={120}
              className="campo mt-1"
              aria-label="Nome da nova categoria"
            />
          </label>
          {erro && <p className="mt-2 text-xs text-red-600">{erro}</p>}
          <div className="mt-4 flex justify-between gap-2">
            <button type="button" onClick={() => setNovaAberta(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
              Cancelar
            </button>
            <button type="button" onClick={cadastrar} disabled={salvando} className="rounded-md bg-marca-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-marca-800 disabled:opacity-60">
              {salvando ? "Cadastrando…" : "Cadastrar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
