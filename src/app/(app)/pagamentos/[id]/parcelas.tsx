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
            <div key={i} className="space-y-3 rounded-md border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700">Parcela {i + 1}</span>
                {linhas.length > 2 && (
                  <button type="button" className="text-xs text-red-700 hover:underline" onClick={() => setLinhas((xs) => xs.filter((_, j) => j !== i))}>
                    Remover
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Campo rotulo="Valor (R$)"><input className="campo tabular-nums" inputMode="decimal" placeholder="0,00" value={l.valor} onChange={(e) => alterar(i, "valor", e.target.value)} required /></Campo>
                <Campo rotulo="Vencimento"><input type="date" className="campo" value={l.vencimento} onChange={(e) => alterar(i, "vencimento", e.target.value)} required /></Campo>
                <Campo rotulo="Multa (R$)"><input className="campo tabular-nums" inputMode="decimal" placeholder="0,00" value={l.multa} onChange={(e) => alterar(i, "multa", e.target.value)} /></Campo>
                <Campo rotulo="Juros (R$)"><input className="campo tabular-nums" inputMode="decimal" placeholder="0,00" value={l.juros} onChange={(e) => alterar(i, "juros", e.target.value)} /></Campo>
                <Campo rotulo="Desconto (R$)"><input className="campo tabular-nums" inputMode="decimal" placeholder="0,00" value={l.desconto} onChange={(e) => alterar(i, "desconto", e.target.value)} /></Campo>
                <Campo rotulo="Motivo"><input className="campo" placeholder="se houver multa, juros ou desconto" value={l.motivo} onChange={(e) => alterar(i, "motivo", e.target.value)} /></Campo>
              </div>
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
