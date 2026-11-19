"use client";

import { useEffect, useRef, useState } from "react";
import { lerValor, moeda, valorParaCampo } from "@/lib/formato";

type Parcela = { id: string; numero: number; vencimento: string; valor: number; pago: boolean };

function definir(input: HTMLInputElement | null, valor: string) {
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, valor);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * "Editar lançamento (todas as parcelas)": vencimento e valor de cada parcela em aberto.
 * As pagas ficam travadas. O valor e o vencimento do lançamento acompanham (soma e 1º vencimento).
 */
export function EditorParcelas({ parcelas, somenteLeitura = false }: { parcelas: Parcela[]; somenteLeitura?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [linhas, setLinhas] = useState(parcelas.map((p) => ({ ...p, valorTxt: valorParaCampo(p.valor) })));
  const total = linhas.reduce((s, l) => s + (l.pago ? l.valor : lerValor(l.valorTxt) ?? 0), 0);
  const primeiro = linhas.map((l) => l.vencimento).filter(Boolean).sort()[0] ?? "";

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const valor = form.querySelector<HTMLInputElement>('input[name="valor"]');
    const venc = form.querySelector<HTMLInputElement>('input[name="vencimento"]');
    for (const i of [valor, venc]) if (i) i.readOnly = true;
    definir(valor, valorParaCampo(Math.round(total * 100) / 100));
    definir(venc, primeiro);
  }, [total, primeiro]);

  const alterar = (id: string, campo: "vencimento" | "valorTxt", v: string) => setLinhas((ls) => ls.map((l) => (l.id === id ? { ...l, [campo]: v } : l)));
  const json = JSON.stringify(linhas.filter((l) => !l.pago).map((l) => ({ id: l.id, vencimento: l.vencimento, valor: lerValor(l.valorTxt) })));

  return (
    <div ref={ref} className="space-y-2">
      <p className="text-sm text-slate-600">
        {somenteLeitura
          ? "Somente o Financeiro ou quem cadastrou altera as parcelas. O valor total e o vencimento do lançamento vêm delas e não podem ser mudados aqui."
          : "Altere o vencimento e o valor das parcelas em aberto. O valor total e o vencimento do lançamento são calculados a partir delas."}
      </p>
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="tabela">
          <thead>
            <tr>
              <th>Parcela</th>
              <th>Vencimento</th>
              <th className="text-right">Valor (R$)</th>
              <th>Situação</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.id}>
                <td className="tabular-nums">
                  {l.numero}/{linhas.length}
                </td>
                <td>
                  <input type="date" value={l.vencimento} disabled={l.pago || somenteLeitura} onChange={(e) => alterar(l.id, "vencimento", e.target.value)} className="campo w-40" aria-label={`Vencimento da parcela ${l.numero}`} />
                </td>
                <td className="text-right">
                  <input value={l.valorTxt} disabled={l.pago || somenteLeitura} onChange={(e) => alterar(l.id, "valorTxt", e.target.value)} inputMode="decimal" className="campo w-32 text-right tabular-nums" aria-label={`Valor da parcela ${l.numero}`} />
                  {!l.pago && !somenteLeitura && lerValor(l.valorTxt) === null && <div className="mt-1 text-xs text-red-600">Valor inválido</div>}
                </td>
                <td className="text-xs">{l.pago ? <span className="text-emerald-700">Paga (não muda)</span> : "Em aberto"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2} className="px-3 py-2 text-right text-sm text-slate-600">
                Total
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{moeda(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {!somenteLeitura && <input type="hidden" name="parcelas_editadas" value={json} />}
    </div>
  );
}
