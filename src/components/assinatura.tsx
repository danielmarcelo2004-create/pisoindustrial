"use client";

import Link from "next/link";
import { useActionState, useMemo, useState, startTransition } from "react";
import { decidir } from "@/app/(app)/aprovacoes/actions";
import { Aviso, Botao, Campo, Selo, Vazio, cx } from "@/components/ui";
import { data, moeda } from "@/lib/formato";

export type ItemAssinavel = {
  id: string;
  numero: number;
  versao: number;
  favorecido: string;
  descricao: string;
  valor: number;
  vencimento: string;
  obra: string;
  etapa: string;
  documentos: number;
};

/** Formulário de decisão (aprovar e assinar / rejeitar) para um ou vários pagamentos. */
export function FormDecisao({
  itens,
  aoConcluir,
  retorno,
}: {
  itens: ItemAssinavel[];
  aoConcluir?: () => void;
  /** Página para onde voltar após a decisão (assinatura individual). */
  retorno?: string;
}) {
  const [estado, acao, enviando] = useActionState(decidir, null);
  const [decisao, setDecisao] = useState<"aprovado" | "rejeitado">("aprovado");
  const total = itens.reduce((s, i) => s + Number(i.valor), 0);
  const lote = itens.length > 1;

  if (estado?.ok) {
    return (
      <div className="space-y-3">
        <Aviso tipo="sucesso">{estado.ok}</Aviso>
        {aoConcluir && (
          <Botao variante="secundario" onClick={aoConcluir}>
            Fechar
          </Botao>
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("itens", JSON.stringify(itens.map((i) => ({ id: i.id, versao: i.versao }))));
        if (retorno) fd.set("retorno", retorno);
        startTransition(() => acao(fd));
      }}
    >
      {lote && (
        <div className="max-h-48 overflow-y-auto rounded-md border border-slate-200">
          <table className="tabela">
            <tbody>
              {itens.map((i) => (
                <tr key={i.id}>
                  <td className="text-slate-500">nº {i.numero}</td>
                  <td>
                    {i.favorecido}
                    <div className="text-xs text-slate-500">{i.obra}</div>
                  </td>
                  <td className="text-right tabular-nums">{moeda(i.valor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-sm text-slate-700">
        {lote ? (
          <>
            <strong>{itens.length} documentos</strong> selecionados · total <strong>{moeda(total)}</strong>. Cada documento
            receberá seu próprio registro de assinatura.
          </>
        ) : (
          itens[0] && (
            <>
              Pagamento nº {itens[0].numero} · versão {itens[0].versao} · {moeda(itens[0].valor)}
            </>
          )
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(["aprovado", "rejeitado"] as const).map((d) => (
          <label
            key={d}
            className={cx(
              "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
              decisao === d
                ? d === "aprovado"
                  ? "border-emerald-500 bg-emerald-50 text-emerald-900"
                  : "border-red-500 bg-red-50 text-red-900"
                : "border-slate-300",
            )}
          >
            <input type="radio" name="decisao" value={d} checked={decisao === d} onChange={() => setDecisao(d)} />
            {d === "aprovado" ? "Aprovar e assinar" : "Rejeitar"}
          </label>
        ))}
      </div>

      <Campo rotulo={decisao === "rejeitado" ? "Motivo da rejeição" : "Comentário (opcional)"} obrigatorio={decisao === "rejeitado"}>
        <textarea name="comentario" rows={2} className="campo" required={decisao === "rejeitado"} />
      </Campo>

      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" name="conferi" required className="mt-0.5" />
        <span>
          Conferi {lote ? "os documentos e os dados de todos os pagamentos selecionados" : "os documentos e os dados deste pagamento"}{" "}
          e confirmo minha decisão.
        </span>
      </label>

      <Campo rotulo="Sua senha" ajuda="A senha confirma que é você quem está assinando.">
        <input name="senha" type="password" autoComplete="current-password" required className="campo" />
      </Campo>

      {estado?.erro && <Aviso tipo="erro">{estado.erro}</Aviso>}

      <Botao type="submit" variante={decisao === "aprovado" ? "sucesso" : "perigo"} disabled={enviando || itens.length === 0}>
        {enviando
          ? "Registrando…"
          : decisao === "aprovado"
            ? lote
              ? `Assinar ${itens.length} documentos`
              : "Assinar e aprovar"
            : lote
              ? `Rejeitar ${itens.length} documentos`
              : "Rejeitar"}
      </Botao>
    </form>
  );
}

/** Lista de pendências com seleção para assinatura em lote. */
export function SelecaoLote({ itens }: { itens: ItemAssinavel[] }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  // Itens "congelados" no momento em que o usuário abre a revisão: a lista pode
  // ser atualizada pelo servidor depois da assinatura sem fechar a confirmação.
  const [revisando, setRevisando] = useState<ItemAssinavel[] | null>(null);
  const selecionados = useMemo(() => itens.filter((i) => sel.has(i.id)), [itens, sel]);
  const todos = itens.length > 0 && sel.size === itens.length;

  function alternar(id: string) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function fechar() {
    setRevisando(null);
    setSel(new Set());
  }

  return (
    <div>
      {itens.length === 0 ? (
        <Vazio>Nenhum documento aguardando sua assinatura.</Vazio>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
            <span className="text-sm text-slate-600">
              {sel.size} de {itens.length} selecionado(s) · {moeda(selecionados.reduce((s, i) => s + Number(i.valor), 0))}
            </span>
            <Botao disabled={selecionados.length === 0} onClick={() => setRevisando(selecionados)}>
              Revisar e assinar selecionados
            </Botao>
          </div>
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead>
                <tr>
                  <th className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos"
                      checked={todos}
                      onChange={() => setSel(todos ? new Set() : new Set(itens.map((i) => i.id)))}
                    />
                  </th>
                  <th>Nº</th>
                  <th>Vencimento</th>
                  <th>Favorecido / descrição</th>
                  <th>Centro de custo</th>
                  <th>Etapa</th>
                  <th className="text-right">Valor</th>
                </tr>
              </thead>
              <tbody>
                {itens.map((i) => (
                  <tr key={i.id} className={cx(sel.has(i.id) && "bg-marca-50/60")}>
                    <td>
                      <input type="checkbox" aria-label={`Selecionar nº ${i.numero}`} checked={sel.has(i.id)} onChange={() => alternar(i.id)} />
                    </td>
                    <td className="text-slate-500 tabular-nums">{i.numero}</td>
                    <td className="whitespace-nowrap tabular-nums">{data(i.vencimento)}</td>
                    <td>
                      <Link href={`/pagamentos/${i.id}`} className="font-medium text-marca-700 hover:underline">
                        {i.favorecido}
                      </Link>
                      <div className="line-clamp-1 text-xs text-slate-500">{i.descricao}</div>
                      <div className="text-xs text-slate-400">
                        {i.documentos} documento(s) · versão {i.versao}
                      </div>
                    </td>
                    <td>{i.obra}</td>
                    <td>
                      <Selo cor="amarelo">{i.etapa}</Selo>
                    </td>
                    <td className="text-right font-medium tabular-nums">{moeda(i.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {revisando && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal>
          <div className="max-h-[95vh] w-full max-w-xl overflow-y-auto rounded-t-lg bg-white p-5 shadow-xl sm:rounded-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Assinatura em lote</h2>
              <button type="button" onClick={fechar} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Fechar">
                ✕
              </button>
            </div>
            <Aviso tipo="info">
              Antes de assinar, abra e confira cada documento. A assinatura fica vinculada ao seu usuário, à versão de cada
              pagamento e aos arquivos anexados.
            </Aviso>
            <div className="mt-4">
              <FormDecisao itens={revisando} aoConcluir={fechar} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
