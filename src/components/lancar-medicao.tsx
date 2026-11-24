"use client";

import { useActionState, useState } from "react";
import { lancarMedicao } from "@/app/(app)/recebimentos/actions";
import { moeda } from "@/lib/formato";

type Opcao = { id: string; nome: string };
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * Nota de medição › "Lançar receita e impostos": receita com o valor total, imposto retido (total − líquido)
 * a pagar na conta onde o dinheiro cai e imposto devido (alíquota × total − retido) já pago na "Baixa manual".
 */
export function LancarMedicao({
  nota,
  cliente,
  contas,
  categoriasReceita,
  categoriasDespesa,
}: {
  nota: { id: string; numero: string | null; obra: string; valor: number; liquido: number; emissao: string | null };
  cliente: string;
  contas: Opcao[];
  categoriasReceita: Opcao[];
  categoriasDespesa: Opcao[];
}) {
  const [aberta, setAberta] = useState(false);
  const [aliq, setAliq] = useState("14");
  const [estado, acao, enviando] = useActionState(lancarMedicao.bind(null, nota.id), null);
  const fmt = (v: number) => (Number.isFinite(v) ? v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");
  const lerBR = (v: string) => (v.trim() ? Number(v.replace(/\./g, "").replace(",", ".")) : NaN);
  // Valores calculados, editáveis: enquanto o Financeiro não digitar, seguem o cálculo (e a alíquota)
  const [retidoTxt, setRetidoTxt] = useState<string | null>(null);
  const [devidoTxt, setDevidoTxt] = useState<string | null>(null);
  const a = Number(aliq.replace(",", "."));
  const retidoCalc = r2(nota.valor - nota.liquido);
  const retido = retidoTxt === null ? retidoCalc : lerBR(retidoTxt);
  const devidoCalc = Number.isFinite(a) && Number.isFinite(retido) ? r2(r2((nota.valor * a) / 100) - retido) : NaN;
  const devido = devidoTxt === null ? devidoCalc : lerBR(devidoTxt);
  const medicao = categoriasReceita.find((c) => /medi/i.test(c.nome))?.id ?? "";
  const imposto = categoriasDespesa.find((c) => /imposto/i.test(c.nome))?.id ?? "";
  if (!aberta)
    return (
      <button type="button" onClick={() => setAberta(true)} className="rounded-md border border-sky-300 px-2 py-1 text-xs font-medium whitespace-nowrap text-sky-800 hover:bg-sky-50">
        Lançar receita
      </button>
    );
  return (
    <div role="dialog" aria-label="Lançar receita e impostos" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4 text-left whitespace-normal">
      <form action={acao} className="max-h-[92vh] w-full max-w-2xl space-y-3 overflow-x-hidden overflow-y-auto rounded-lg bg-white p-5 text-sm shadow-xl">
        <h3 className="text-base font-semibold text-slate-800">
          Lançar receita e impostos — nota {nota.numero ? `nº ${nota.numero}` : ""} · {nota.obra}
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            Cliente *
            <input name="cliente" required defaultValue={cliente} className="campo mt-1" maxLength={200} />
          </label>
          <label>
            Vencimento (quando deve cair) *
            <input type="date" name="vencimento" required defaultValue={nota.emissao ?? ""} className="campo mt-1" />
          </label>
          <label className="sm:col-span-2">
            Conta onde o dinheiro vai cair *
            <select name="conta_id" required defaultValue={contas.length === 1 ? contas[0].id : ""} className="campo mt-1">
              <option value="">Escolha…</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
          <label>
            Categoria da receita
            <select name="categoria_receita" defaultValue={medicao} className="campo mt-1">
              <option value="">— Sem categoria —</option>
              {categoriasReceita.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
          <label>
            Categoria dos impostos
            <select name="categoria_imposto" defaultValue={imposto} className="campo mt-1">
              <option value="">— Sem categoria —</option>
              {categoriasDespesa.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
          <label>
            Alíquota do imposto devido (%)
            <input name="aliquota" value={aliq} onChange={(e) => setAliq(e.target.value)} inputMode="decimal" className="campo mt-1" aria-label="Alíquota" />
          </label>
        </div>
        <table className="w-full table-fixed text-sm" data-calculo-medicao>
          <colgroup>
            <col />
            <col className="w-28 sm:w-40" />
          </colgroup>
          <tbody className="divide-y divide-slate-100">
            <tr>
              <td className="py-1.5 pr-3">Receita (valor total da nota)</td>
              <td className="text-right font-medium tabular-nums">{moeda(nota.valor)}</td>
            </tr>
            <tr>
              <td className="py-1.5 pr-3 break-words">
                Imposto retido <span className="text-slate-500">(total − líquido)</span>
                <span className="block text-xs text-slate-500">Entra em Contas a pagar; é baixado na conciliação.</span>
                {retidoTxt !== null && (
                  <button type="button" className="text-xs text-sky-700 hover:underline" onClick={() => setRetidoTxt(null)}>
                    voltar ao cálculo ({moeda(retidoCalc)})
                  </button>
                )}
              </td>
              <td className="text-right align-top">
                <input name="retido" value={retidoTxt ?? fmt(retidoCalc)} onChange={(e) => setRetidoTxt(e.target.value)} inputMode="decimal" className="campo py-1 text-right tabular-nums" aria-label="Imposto retido" />
              </td>
            </tr>
            <tr>
              <td className="py-1.5 pr-3 break-words">
                Imposto devido <span className="text-slate-500">({aliq}% × total − retido)</span>
                <span className="block text-xs text-slate-500">Entra em Contas a pagar já pago, na “Baixa manual”.</span>
                {devidoTxt !== null && (
                  <button type="button" className="text-xs text-sky-700 hover:underline" onClick={() => setDevidoTxt(null)}>
                    voltar ao cálculo ({Number.isFinite(devidoCalc) ? moeda(devidoCalc) : "—"})
                  </button>
                )}
              </td>
              <td className="text-right align-top">
                <input name="devido" value={devidoTxt ?? fmt(devidoCalc)} onChange={(e) => setDevidoTxt(e.target.value)} inputMode="decimal" className={`campo py-1 text-right tabular-nums ${devido < 0 ? "text-red-600" : ""}`} aria-label="Imposto devido" />
              </td>
            </tr>
            <tr>
              <td className="py-1.5 pr-3 text-slate-600">O banco deve creditar (receita − retido)</td>
              <td className="text-right tabular-nums text-slate-600">{Number.isFinite(retido) ? moeda(r2(nota.valor - retido)) : "—"}</td>
            </tr>
          </tbody>
        </table>
        {devido <= 0 && <p className="text-xs text-amber-800">Imposto devido zero ou negativo: ele não é lançado.</p>}
        <p className="text-xs text-slate-500">Os impostos entram sem fluxo de aprovação; o engenheiro e o administrador do centro de custo são avisados.</p>
        {estado?.erro && <p className="text-sm text-red-700">{estado.erro}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setAberta(false)} className="rounded-md border border-slate-300 px-3 py-2 text-slate-700">
            Voltar
          </button>
          <button type="submit" disabled={enviando} className="rounded-md bg-marca-700 px-3 py-2 font-semibold text-white disabled:opacity-50">
            {enviando ? "Lançando…" : "Lançar receita e impostos"}
          </button>
        </div>
      </form>
    </div>
  );
}
