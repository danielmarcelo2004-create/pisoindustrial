"use client";

import { useState } from "react";
import { criarFornecedorRapido } from "@/app/(app)/fornecedores/actions";

type Fornecedor = { id: string; nome: string };

/**
 * Lista de fornecedores com "+ Novo fornecedor" numa janelinha (nome e CPF/CNPJ), sem sair do formulário.
 * O novo fornecedor já fica selecionado; o cadastro completo (PIX, banco…) fica em Fornecedores.
 */
export function SeletorFornecedor({ fornecedores: iniciais, valorInicial = null, podeAdicionar = false, nome = "fornecedor_id" }: { fornecedores: Fornecedor[]; valorInicial?: string | null; podeAdicionar?: boolean; nome?: string }) {
  const [lista, setLista] = useState(iniciais);
  const [valor, setValor] = useState(valorInicial ?? "");
  const [aberto, setAberto] = useState(false);
  const [novo, setNovo] = useState({ nome: "", doc: "" });
  const [erro, setErro] = useState("");
  const [salvando, setSalvando] = useState(false);
  async function salvar() {
    setErro("");
    setSalvando(true);
    const r = await criarFornecedorRapido(novo.nome, novo.doc);
    setSalvando(false);
    if (r.erro || !r.id) return setErro(r.erro ?? "Não foi possível cadastrar.");
    setLista((xs) => (xs.some((x) => x.id === r.id) ? xs : [...xs, { id: r.id!, nome: r.nome ?? novo.nome }].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))));
    setValor(r.id);
    setAberto(false);
    setNovo({ nome: "", doc: "" });
  }
  return (
    <div className="relative">
      <div className="flex gap-2">
        <select name={nome} value={valor} onChange={(e) => setValor(e.target.value)} className="campo" aria-label="Fornecedor">
          <option value="">— Sem fornecedor cadastrado —</option>
          {lista.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nome}
            </option>
          ))}
        </select>
        {podeAdicionar && (
          <button type="button" onClick={() => (setAberto(!aberto), setErro(""))} className="shrink-0 rounded-md border border-sky-300 px-2 text-sm text-sky-800 hover:bg-sky-50" title="Cadastrar fornecedor">
            + Novo
          </button>
        )}
      </div>
      {aberto && (
        <div role="dialog" aria-label="Novo fornecedor" className="absolute left-0 right-0 top-full z-30 mt-1 space-y-2 rounded-md border border-slate-200 bg-white p-3 shadow-lg">
          <input autoFocus value={novo.nome} onChange={(e) => setNovo({ ...novo, nome: e.target.value })} placeholder="Nome / razão social *" className="campo" aria-label="Nome do novo fornecedor" maxLength={200} />
          <input value={novo.doc} onChange={(e) => setNovo({ ...novo, doc: e.target.value })} placeholder="CPF ou CNPJ (opcional)" inputMode="numeric" className="campo" aria-label="CPF ou CNPJ do novo fornecedor" maxLength={18} />
          {erro && <p className="text-xs text-red-700">{erro}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAberto(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700">
              Voltar
            </button>
            <button type="button" disabled={salvando || !novo.nome.trim()} onClick={salvar} className="rounded-md bg-marca-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              {salvando ? "Salvando…" : "Cadastrar"}
            </button>
          </div>
          <p className="text-[11px] text-slate-500">PIX, banco e contato você completa depois em Fornecedores.</p>
        </div>
      )}
    </div>
  );
}
