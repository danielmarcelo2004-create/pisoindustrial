"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { criarReceita } from "@/app/(app)/recebimentos/actions";

type Opcao = { id: string; nome: string };

/** "+ Nova receita" (Contas a receber): recebimento em aberto, numa janela sem sair da lista. */
export function NovaReceita({ obras, categorias, contas }: { obras: (Opcao & { cliente: string | null })[]; categorias: Opcao[]; contas: Opcao[] }) {
  const router = useRouter();
  const [aberta, setAberta] = useState(false);
  const [estado, acao, enviando] = useActionState(criarReceita, null);
  const [cliente, setCliente] = useState("");
  useEffect(() => {
    if (estado?.ok && estado.dados?.id) router.push(`/recebimentos/${estado.dados.id}?criada=1`);
  }, [estado, router]);
  if (!aberta)
    return (
      <button type="button" onClick={() => setAberta(true)} className="rounded-md bg-marca-700 px-3 py-2 text-sm font-semibold text-white hover:bg-marca-800">
        + Nova receita
      </button>
    );
  return (
    <div role="dialog" aria-label="Nova receita" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <form action={acao} className="max-h-[92vh] w-full max-w-2xl space-y-3 overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <h3 className="text-base font-semibold text-slate-800">Nova receita</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm sm:col-span-2">
            Descrição *
            <input name="descricao" required maxLength={300} placeholder="Ex.: 3ª medição — Galpão Camaçari" className="campo mt-1" />
          </label>
          <label className="text-sm">
            Centro de custo *
            <select
              name="obra_id"
              required
              defaultValue=""
              className="campo mt-1"
              onChange={(e) => !cliente.trim() && setCliente(obras.find((o) => o.id === e.target.value)?.cliente ?? "")}
            >
              <option value="">Escolha…</option>
              {obras.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Cliente *
            <input name="cliente" required value={cliente} onChange={(e) => setCliente(e.target.value)} maxLength={200} className="campo mt-1" placeholder="O cliente da obra vem preenchido" />
          </label>
          <label className="text-sm">
            Categoria de receita
            <select name="categoria_id" defaultValue="" className="campo mt-1">
              <option value="">— Sem categoria —</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Valor (R$) *
            <input name="valor" required inputMode="decimal" placeholder="0,00" className="campo mt-1" />
          </label>
          <label className="text-sm">
            Vencimento *
            <input type="date" name="vencimento" required className="campo mt-1" />
          </label>
          <label className="text-sm">
            Competência
            <input type="date" name="competencia" className="campo mt-1" />
          </label>
          <label className="text-sm sm:col-span-2">
            Conta onde deve cair
            <select name="conta_id" defaultValue="" className="campo mt-1">
              <option value="">— A definir (a conciliação ajusta) —</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm sm:col-span-2">
            Observações
            <textarea name="observacoes" rows={2} className="campo mt-1" />
          </label>
        </div>
        <p className="text-xs text-slate-500">Fica em aberto até a entrada aparecer no extrato: a conciliação sugere esta receita e dá o recebimento.</p>
        {estado?.erro && <p className="text-sm text-red-700">{estado.erro}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setAberta(false)} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700">
            Voltar
          </button>
          <button type="submit" disabled={enviando} className="rounded-md bg-marca-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {enviando ? "Salvando…" : "Lançar receita"}
          </button>
        </div>
      </form>
    </div>
  );
}
