"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { marcarProvisao } from "@/app/(app)/provisoes/actions";
import { data, moeda } from "@/lib/formato";

export type ProvisaoJanela = { id: string; descricao: string; obra: string | null; vencimento: string | null; valor: number | null; serie: boolean };

/**
 * "Lançar despesa" de uma provisão sem sair da tela: mostra a provisão e oferece lançar a despesa
 * (abre a nova despesa já preenchida; ao salvar, a provisão é marcada como lançada sozinha),
 * marcar como lançada (quando a despesa já existe), cancelar ou abrir na tela de Provisões.
 */
export function JanelaProvisao({ provisao, podeAgir, rotulo = "Lançar despesa", classe }: { provisao: ProvisaoJanela; podeAgir: boolean; rotulo?: string; classe?: string }) {
  const router = useRouter();
  const [aberta, setAberta] = useState(false);
  const [confirmarCancelar, setConfirmarCancelar] = useState(false);
  const [msg, setMsg] = useState<{ erro?: string; ok?: string } | null>(null);
  const [pend, iniciar] = useTransition();
  useEffect(() => {
    if (!aberta) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAberta(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [aberta]);
  const marcar = (status: "convertida" | "cancelada") =>
    iniciar(async () => {
      const r = await marcarProvisao(provisao.id, status);
      setMsg(r ?? null);
      if (r?.ok) {
        setAberta(false);
        router.refresh();
      }
    });

  return (
    <>
      <button type="button" onClick={() => (setAberta(true), setMsg(null), setConfirmarCancelar(false))} className={classe ?? "rounded-md border border-sky-300 px-2.5 py-1 text-xs font-medium text-sky-800 hover:bg-sky-50"}>
        {rotulo}
      </button>
      {aberta && (
        <div role="dialog" aria-label="Lançar despesa da provisão" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4 whitespace-normal" onMouseDown={(e) => e.target === e.currentTarget && setAberta(false)}>
          <div className="w-full max-w-md rounded-lg bg-white p-5 text-left shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">Provisão: {provisao.descricao}</h3>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Centro de custo</dt>
                <dd className="text-slate-800">{provisao.obra ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Vencimento</dt>
                <dd className="text-slate-800 tabular-nums">{provisao.vencimento ? data(provisao.vencimento) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Valor estimado</dt>
                <dd className="text-slate-800 tabular-nums">{provisao.valor === null ? "a definir" : moeda(provisao.valor)}</dd>
              </div>
            </dl>
            {podeAgir ? (
              <>
                <p className="mt-4 text-sm text-slate-600">Lance a despesa com o valor real e o boleto (ou a Ordem de Pagamento). Ao salvar, esta provisão é marcada como lançada sozinha.</p>
                <div className="mt-3 flex flex-col gap-2">
                  <Link href={`/pagamentos/novo?provisao=${provisao.id}`} className="rounded-md bg-marca-700 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-marca-800" data-lancar-provisao>
                    Lançar despesa agora
                  </Link>
                  <button type="button" disabled={pend} onClick={() => marcar("convertida")} className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                    Já foi lançada: marcar como lançada
                  </button>
                  {confirmarCancelar ? (
                    <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-900">
                      Cancelar {provisao.serie ? "só esta parcela da série" : "esta provisão"}?
                      <div className="mt-2 flex gap-2">
                        <button type="button" disabled={pend} onClick={() => marcar("cancelada")} className="rounded bg-red-600 px-2 py-1 text-xs font-semibold text-white hover:bg-red-700">
                          Sim, cancelar
                        </button>
                        <button type="button" onClick={() => setConfirmarCancelar(false)} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700">
                          Não
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirmarCancelar(true)} className="rounded-md px-3 py-2 text-sm text-red-700 hover:bg-red-50">
                      Cancelar {provisao.serie ? "só esta" : "provisão"}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-4 text-sm text-slate-600">Quem lança é o Financeiro (ou o Suprimentos que cadastrou a provisão).</p>
            )}
            {msg?.erro && <p className="mt-3 text-sm text-red-700">{msg.erro}</p>}
            <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-sm">
              <Link href={`/provisoes?prov=${provisao.id}#prov-${provisao.id}`} className="text-sky-700 hover:underline">
                Ver em Provisões
              </Link>
              <button type="button" onClick={() => setAberta(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50">
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
