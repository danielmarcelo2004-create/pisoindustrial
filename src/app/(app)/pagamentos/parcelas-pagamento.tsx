"use client";

import { useEffect, useState } from "react";
import { Campo } from "@/components/ui";
import { moeda } from "@/lib/formato";
import { extrairParcelasPorPagina } from "@/lib/boleto-parcelas";
import { lerPaginasBoleto } from "@/lib/ocr/comprovantes";

type Linha = { vencimento: string; valor: string };

/** Soma meses a uma data ISO, mantendo o último dia do mês quando o dia não existe. */
function somarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(d, ultimo)).padStart(2, "0")}`;
}

/** Parcelas iguais (centavos na última) com vencimentos mensais a partir do primeiro. */
function gerar(n: number, primeiro: string, total: number): Linha[] {
  const cents = Math.round((Number.isFinite(total) ? total : 0) * 100);
  const base = Math.floor(cents / n);
  const ultima = cents - base * (n - 1);
  return Array.from({ length: n }, (_, i) => ({
    vencimento: primeiro ? somarMeses(primeiro, i) : "",
    valor: ((i === n - 1 ? ultima : base) / 100).toFixed(2).replace(".", ","),
  }));
}

/** "1.234,56" ou "1234.56" → número */
function num(s: string): number {
  const t = s.trim();
  if (!t) return NaN;
  return t.includes(",") ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t.replace(/^R\$\s*/, ""));
}

const campo = (f: HTMLFormElement, nome: string) => f.querySelector<HTMLInputElement>(`input[name=${nome}]`);

/**
 * Parcelar o pagamento no cadastro. Se o boleto anexado tiver mais de um vencimento,
 * a quantidade e as datas/valores são sugeridos a partir do texto do PDF (confira antes de cadastrar).
 */
export function ParcelasPagamento() {
  const [total, setTotal] = useState(NaN);
  const [primeiro, setPrimeiro] = useState("");
  const [qtd, setQtd] = useState("1");
  const [manual, setManual] = useState<Linha[] | null>(null);
  const [aviso, setAviso] = useState<{ tipo: "info" | "alerta"; texto: string } | null>(null);
  const [ref, setRef] = useState<HTMLDivElement | null>(null);

  const n = Math.min(Math.max(Math.floor(Number(qtd) || 1), 1), 60);
  const exibidas = manual && manual.length === n ? manual : gerar(n, primeiro, total);
  const soma = exibidas.reduce((s, l) => s + (num(l.valor) || 0), 0);
  const bate = n < 2 || (Number.isFinite(total) && Math.abs(soma - total) < 0.005);

  useEffect(() => {
    const f = ref?.closest("form");
    if (!f) return;
    const lerCampos = () => {
      setTotal(num(campo(f, "valor")?.value ?? ""));
      setPrimeiro(campo(f, "vencimento")?.value ?? "");
    };
    const aoMudar = async (e: Event) => {
      const alvo = e.target as HTMLInputElement;
      if (alvo.name === "valor" || alvo.name === "vencimento") lerCampos();
      if (alvo.name === "boleto" && alvo.files?.[0]) {
        lerCampos();
        setAviso({ tipo: "info", texto: "Lendo o boleto anexado…" });
        try {
          const p = extrairParcelasPorPagina(await lerPaginasBoleto(alvo.files[0]));
          if (!p) {
            setAviso({ tipo: "info", texto: "Não identifiquei mais de um boleto neste arquivo. Informe as parcelas manualmente." });
            return;
          }
          setQtd(String(p.vencimentos.length));
          setManual(p.vencimentos.map((v, i) => ({ vencimento: v, valor: p.valores[i].toFixed(2).replace(".", ",") })));
          setAviso({ tipo: "info", texto: `${p.vencimentos.length} boletos identificados no arquivo. Parcelas preenchidas; confira antes de cadastrar.` });
        } catch {
          setAviso({ tipo: "alerta", texto: "Não consegui ler o boleto. Informe as parcelas manualmente." });
        }
      }
    };
    lerCampos();
    f.addEventListener("input", aoMudar);
    f.addEventListener("change", aoMudar);
    return () => {
      f.removeEventListener("input", aoMudar);
      f.removeEventListener("change", aoMudar);
    };
  }, [ref]);

  const alterar = (i: number, campoLinha: keyof Linha, v: string) =>
    setManual(exibidas.map((l, j) => (j === i ? { ...l, [campoLinha]: v } : l)));

  return (
    <div ref={setRef} className="space-y-3 sm:col-span-2">
      <Campo rotulo="Parcelar em" ajuda="1 para pagamento único. O boleto anexado é lido para sugerir as parcelas.">
        <input
          type="number"
          min={1}
          max={60}
          value={qtd}
          onChange={(e) => {
            setQtd(e.target.value);
            setManual(null);
          }}
          className="campo w-32 tabular-nums"
          aria-label="Quantidade de parcelas"
        />
      </Campo>
      {aviso && (
        <div className={aviso.tipo === "alerta" ? "rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" : "rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900"}>
          {aviso.texto}
        </div>
      )}
      {n >= 2 && (
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="px-3 py-2">Parcela</th>
                <th className="px-3 py-2">Vencimento</th>
                <th className="px-3 py-2 text-right">Valor (R$)</th>
              </tr>
            </thead>
            <tbody>
              {exibidas.map((l, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="px-3 py-2 tabular-nums">{i + 1}</td>
                  <td className="px-3 py-2">
                    <input type="date" value={l.vencimento} onChange={(e) => alterar(i, "vencimento", e.target.value)} className="campo" aria-label={`Vencimento da parcela ${i + 1}`} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input inputMode="decimal" value={l.valor} onChange={(e) => alterar(i, "valor", e.target.value)} className="campo w-32 text-right tabular-nums" aria-label={`Valor da parcela ${i + 1}`} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} className="px-3 py-2 text-right text-sm text-slate-600">
                  Soma: <span className="tabular-nums font-semibold">{moeda(soma)}</span> de {moeda(total)}
                </td>
                <td />
              </tr>
              {!bate && (
                <tr>
                  <td colSpan={3} className="px-3 pb-2 text-xs text-red-600">A soma das parcelas precisa ser igual ao valor do pagamento.</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}
      <input type="hidden" name="parcelas_json" value={n >= 2 ? JSON.stringify(exibidas.map((l) => ({ vencimento: l.vencimento, valor: num(l.valor) }))) : "[]"} />
    </div>
  );
}
