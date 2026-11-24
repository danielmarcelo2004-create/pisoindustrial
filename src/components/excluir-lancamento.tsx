"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { excluirLancamento } from "@/app/(app)/pagamentos/actions";

type Escopo = "atual" | "nao_vencidos" | "em_aberto" | "todos";

/**
 * Janela "Excluir lançamento" (como no Conta Azul): só o atual ou também as outras parcelas / repetições.
 * Parcela excluída sai da despesa e o total diminui. Em "Todos", os pagos têm a baixa estornada
 * (e a conciliação desfeita) antes de sair. Tudo fica na auditoria.
 */
export function JanelaExcluirLancamento({
  pagamentoId,
  parcelaId,
  irmaos,
  podeEstornar,
  pago,
  aoFechar,
}: {
  pagamentoId: string;
  parcelaId: string | null;
  /** Tem outras parcelas ou repetições. */
  irmaos: boolean;
  /** Financeiro/master: pode excluir os pagos (estorna a baixa). */
  podeEstornar: boolean;
  pago: boolean;
  aoFechar: () => void;
}) {
  const router = useRouter();
  const [escopo, setEscopo] = useState<Escopo>("atual");
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState("");
  const [pend, iniciar] = useTransition();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && aoFechar();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [aoFechar]);

  const opcoes: { v: Escopo; r: string }[] = [
    { v: "atual", r: "Somente o lançamento atual" },
    ...(irmaos
      ? ([
          { v: "nao_vencidos", r: "Lançamento atual e todos os não vencidos que não possuam baixas" },
          { v: "em_aberto", r: "Lançamento atual e todos os em aberto (vencidos + a vencer) que não possuam baixas" },
          ...(podeEstornar ? [{ v: "todos", r: "Todos os lançamentos" }] : []),
        ] as { v: Escopo; r: string }[])
      : []),
  ];
  const excluir = () =>
    iniciar(async () => {
      const fd = new FormData();
      fd.set("escopo", escopo);
      fd.set("motivo", motivo);
      const r = await excluirLancamento(pagamentoId, parcelaId, null, fd);
      if (r?.erro) return setErro(r.erro);
      aoFechar();
      router.refresh();
    });

  return (
    <div role="dialog" aria-label="Excluir lançamento" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4 whitespace-normal" onMouseDown={(e) => e.target === e.currentTarget && aoFechar()}>
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 text-left shadow-xl">
        <h3 className="text-base font-semibold text-slate-800">Excluir lançamento</h3>
        {irmaos && <p className="mt-1 text-sm text-slate-600">Este lançamento faz parte de {parcelaId ? "um parcelamento" : "uma repetição"}. Quais você quer excluir?</p>}
        <fieldset className="mt-3 space-y-2" aria-label="Quais lançamentos excluir">
          {opcoes.map((o) => (
            <label key={o.v} className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
              <input type="radio" name="escopo" value={o.v} checked={escopo === o.v} onChange={() => setEscopo(o.v)} className="mt-0.5 shrink-0" />
              <span>{o.r}</span>
            </label>
          ))}
        </fieldset>
        {(escopo === "todos" || pago) && (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-aviso-pagos>
            {escopo === "todos" ? "Os já pagos também saem:" : "Este lançamento está pago:"} a baixa é estornada e, se estiver conciliada, a linha do extrato volta para as pendentes.
          </p>
        )}
        {parcelaId && <p className="mt-3 text-xs text-slate-500">Parcela excluída sai da despesa e o total diminui; as que ficam são renumeradas.</p>}
        <label className="mt-3 block text-sm font-medium text-slate-700">
          Motivo
          <input value={motivo} onChange={(e) => setMotivo(e.target.value)} className="campo mt-1" aria-label="Motivo da exclusão" placeholder="Ex.: lançado em duplicidade" maxLength={300} />
        </label>
        {erro && <p className="mt-2 text-sm text-red-700">{erro}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50" onClick={aoFechar}>
            Cancelar
          </button>
          <button type="button" disabled={pend || motivo.trim().length < 3} className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-40" onClick={excluir}>
            {pend ? "Excluindo…" : "Excluir lançamento"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Botão que abre a janela "Excluir lançamento" (usado na página da despesa). */
export function BotaoExcluirLancamento(props: Omit<Parameters<typeof JanelaExcluirLancamento>[0], "aoFechar">) {
  const [aberta, setAberta] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setAberta(true)} className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50">
        Excluir lançamento
      </button>
      {aberta && <JanelaExcluirLancamento {...props} aoFechar={() => setAberta(false)} />}
    </>
  );
}
