"use client";

import { useActionState, startTransition, useState } from "react";
import { Aviso, Botao, Campo, Cartao } from "@/components/ui";
import { moeda } from "@/lib/formato";
import type { Estado } from "@/lib/erros";

type Linha = { valor: string; vencimento: string; multa: string; juros: string; desconto: string; motivo: string };
const vazia = (): Linha => ({ valor: "", vencimento: "", multa: "", juros: "", desconto: "", motivo: "" });
const num = (s: string) => {
  const t = s.trim();
  if (!t) return 0;
  const n = t.includes(",") ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t);
  return Number.isFinite(n) ? n : 0;
};

export function FormParcelas({
  pagamentoId,
  valorTotal,
  action,
}: {
  pagamentoId: string;
  valorTotal: number;
  action: (id: string, e: Estado, fd: FormData) => Promise<Estado>;
}) {
  const [linhas, setLinhas] = useState<Linha[]>([vazia(), vazia()]);
  const [estado, acao, enviando] = useActionState(action.bind(null, pagamentoId), null);
  const somaBase = linhas.reduce((s, l) => s + num(l.valor), 0);
  const diferenca = Math.round((somaBase - valorTotal) * 100) / 100;
  const alterar = (i: number, campo: keyof Linha, v: string) =>
    setLinhas((xs) => xs.map((x, j) => (j === i ? { ...x, [campo]: v } : x)));

  return (
    <Cartao titulo="Dividir em parcelas">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData();
          fd.set("parcelas", JSON.stringify(linhas.map((l) => ({
            valor: num(l.valor), vencimento: l.vencimento, multa: num(l.multa), juros: num(l.juros), desconto: num(l.desconto), motivo: l.motivo,
          }))));
          startTransition(() => acao(fd));
        }}
      >
        <p className="text-xs text-slate-600">
          Valor do pagamento: <strong>{moeda(valorTotal)}</strong>. A soma das parcelas deve dar esse valor. Multa e juros são lançados à parte, em cada parcela, com motivo; o desconto também.
        </p>
        <div className="space-y-2">
          {linhas.map((l, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-6">
              <Campo rotulo={`Parcela ${i + 1} · valor`}><input className="campo tabular-nums" inputMode="decimal" value={l.valor} onChange={(e) => alterar(i, "valor", e.target.value)} required /></Campo>
              <Campo rotulo="Vencimento"><input type="date" className="campo" value={l.vencimento} onChange={(e) => alterar(i, "vencimento", e.target.value)} required /></Campo>
              <Campo rotulo="Multa (R$)"><input className="campo tabular-nums" inputMode="decimal" value={l.multa} onChange={(e) => alterar(i, "multa", e.target.value)} /></Campo>
              <Campo rotulo="Juros (R$)"><input className="campo tabular-nums" inputMode="decimal" value={l.juros} onChange={(e) => alterar(i, "juros", e.target.value)} /></Campo>
              <Campo rotulo="Desconto (R$)"><input className="campo tabular-nums" inputMode="decimal" value={l.desconto} onChange={(e) => alterar(i, "desconto", e.target.value)} /></Campo>
              <Campo rotulo="Motivo (se houver multa, juros ou desconto)"><input className="campo" value={l.motivo} onChange={(e) => alterar(i, "motivo", e.target.value)} /></Campo>
              {linhas.length > 2 && (
                <button type="button" className="text-xs text-red-700 hover:underline sm:col-span-6 sm:justify-self-end" onClick={() => setLinhas((xs) => xs.filter((_, j) => j !== i))}>
                  Remover parcela {i + 1}
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className="text-marca-700 hover:underline" onClick={() => setLinhas((xs) => [...xs, vazia()])}>+ Adicionar parcela</button>
          <span className={diferenca === 0 ? "text-emerald-700" : "text-amber-700"}>
            Soma das parcelas: {moeda(somaBase)} {diferenca === 0 ? "· confere" : `· diferença de ${moeda(diferenca)}`}
          </span>
        </div>
        {estado?.erro && <Aviso tipo="erro">{estado.erro}</Aviso>}
        {estado?.ok && <Aviso tipo="sucesso">{estado.ok}</Aviso>}
        <Botao type="submit" disabled={enviando}>{enviando ? "Salvando…" : "Definir parcelas"}</Botao>
      </form>
    </Cartao>
  );
}
