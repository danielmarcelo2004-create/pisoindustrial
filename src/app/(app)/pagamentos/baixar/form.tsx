"use client";

import Link from "next/link";
import { startTransition, useActionState, useMemo, useState } from "react";
import { Aviso, Botao, Campo, Cartao, Selo } from "@/components/ui";
import { data as formatarData, lerValor, moeda, valorParaCampo } from "@/lib/formato";
import { chaveComprovante, lerComprovante, sugerirCasamentos, type Aberto, type Comprovante, type Confianca } from "@/lib/comprovantes-banco";
import { criarOcr, extrairPagina, lerTextoPaginas } from "@/lib/ocr/comprovantes";
import { registrarBaixasLote } from "./actions";

type Pagina = {
  id: string;
  arquivo: File;
  nomeArquivo: string;
  pagina: number;
  comprovante: Comprovante;
  repetidaDe: string | null;
  /** Pagamento marcado ao qual o comprovante foi ligado ("" = não usar). */
  atribuido: string;
  confianca: Confianca;
  motivo: string;
};
type Item = { data: string; valor: string };

const hoje = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const COR: Record<Confianca, "verde" | "azul" | "amarelo" | "cinza"> = { alta: "verde", media: "azul", baixa: "amarelo", ambigua: "amarelo", nenhuma: "cinza" };
const ROTULO: Record<Confianca, string> = { alta: "Reconhecido", media: "Só pelo valor", baixa: "Confira", ambigua: "Escolha", nenhuma: "Sem pagamento" };

export function FormBaixar({ abertos }: { abertos: Aberto[] }) {
  const [estado, acao, registrando] = useActionState(registrarBaixasLote, null);
  const [tirados, setTirados] = useState<Set<string>>(new Set());
  // Só o que ainda está em aberto: depois de uma baixa parcial, os já pagos saem da lista e o erro continua visível
  const selecionados = useMemo(() => abertos.filter((a) => !tirados.has(a.chave)), [abertos, tirados]);
  const [itens, setItens] = useState<Record<string, Item>>(() => Object.fromEntries(abertos.map((a) => [a.chave, { data: hoje(), valor: "" }])));
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [paginas, setPaginas] = useState<Pagina[]>([]);
  const [progresso, setProgresso] = useState("");
  const [lendo, setLendo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erroLocal, setErroLocal] = useState("");

  const porChave = useMemo(() => new Map(abertos.map((a) => [a.chave, a])), [abertos]);
  const paginaDe = (chave: string) => paginas.find((p) => !p.repetidaDe && p.atribuido === chave);
  const alterarItem = (chave: string, campo: keyof Item, v: string) => setItens((x) => ({ ...x, [chave]: { ...x[chave], [campo]: v } }));

  async function lerComprovantes() {
    if (!arquivos.length) return setErroLocal("Escolha o(s) PDF(s) com os comprovantes.");
    setErroLocal("");
    setLendo(true);
    setPaginas([]);
    let worker: Awaited<ReturnType<typeof criarOcr>> | null = null;
    try {
      const lidas: Omit<Pagina, "atribuido" | "confianca" | "motivo">[] = [];
      const vistos = new Map<string, string>();
      for (const arq of arquivos) {
        const textos = await lerTextoPaginas(arq, async (n, total) => {
          setProgresso(`Lendo ${arq.name}: página ${n} de ${total}…`);
          if (!worker) worker = await criarOcr();
          return worker;
        });
        textos.forEach((texto, i) => {
          const comprovante = lerComprovante(texto);
          const chave = chaveComprovante(comprovante);
          const repetidaDe = chave && vistos.has(chave) ? vistos.get(chave)! : null;
          if (chave && !repetidaDe) vistos.set(chave, `${arq.name}, página ${i + 1}`);
          lidas.push({ id: `${arq.name}#${i + 1}`, arquivo: arq, nomeArquivo: arq.name, pagina: i + 1, comprovante, repetidaDe });
        });
      }
      // Casa os comprovantes só com os pagamentos marcados
      const unicas = lidas.filter((p) => !p.repetidaDe);
      const sugestoes = sugerirCasamentos(unicas.map((p) => p.comprovante), selecionados);
      const porId = new Map(unicas.map((p, i) => [p.id, sugestoes[i]]));
      const novas = lidas.map((p) => {
        const s = porId.get(p.id);
        return { ...p, atribuido: s?.chave ?? "", confianca: s?.confianca ?? "nenhuma", motivo: s?.motivo ?? "" };
      });
      setPaginas(novas);
      // Data e valor de cada pagamento passam a ser os do seu comprovante
      setItens((x) => {
        const n = { ...x };
        for (const p of novas.filter((q) => q.atribuido)) {
          const a = porChave.get(p.atribuido);
          n[p.atribuido] = {
            data: p.comprovante.data ?? n[p.atribuido].data,
            valor: a && p.comprovante.valor !== null && Math.abs(p.comprovante.valor - a.valor) >= 0.005 ? valorParaCampo(p.comprovante.valor) : "",
          };
        }
        return n;
      });
      const ligados = novas.filter((p) => p.atribuido).length;
      const repetidas = lidas.length - unicas.length;
      setProgresso(`${lidas.length} página(s) lidas${repetidas ? ` (${repetidas} repetida(s) ignorada(s))` : ""}. ${ligados} comprovante(s) ligados aos pagamentos marcados.`);
    } catch (e) {
      setErroLocal(`Não foi possível ler o PDF: ${(e as Error).message}`);
    } finally {
      if (worker) await (worker as { terminate: () => Promise<unknown> }).terminate();
      setLendo(false);
    }
  }

  function ligar(paginaId: string, chave: string) {
    // A conta que perde o comprovante volta à data de hoje e ao valor do lançamento
    const anterior = paginas.find((q) => q.id === paginaId)?.atribuido;
    if (anterior && anterior !== chave) setItens((x) => ({ ...x, [anterior]: { data: hoje(), valor: "" } }));
    setPaginas((ps) => ps.map((p) => (p.id === paginaId ? { ...p, atribuido: chave, confianca: chave ? "alta" : "nenhuma", motivo: chave ? "Escolhido por você." : "" } : p)));
    if (chave) {
      const p = paginas.find((q) => q.id === paginaId);
      const a = porChave.get(chave);
      if (p && a) {
        setItens((x) => ({
          ...x,
          [chave]: { data: p.comprovante.data ?? x[chave].data, valor: p.comprovante.valor !== null && Math.abs(p.comprovante.valor - a.valor) >= 0.005 ? valorParaCampo(p.comprovante.valor) : "" },
        }));
      }
    }
  }

  async function confirmar() {
    if (enviando || registrando) return;
    if (!selecionados.length) return setErroLocal("Nenhum pagamento para baixar.");
    const ligados = paginas.filter((p) => !p.repetidaDe && p.atribuido);
    if (new Set(ligados.map((p) => p.atribuido)).size !== ligados.length) return setErroLocal("Um mesmo pagamento recebeu dois comprovantes. Corrija antes de confirmar.");
    for (const a of selecionados) {
      const it = itens[a.chave];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.data)) return setErroLocal(`Informe a data do pagamento de ${a.rotulo}.`);
      if (it.valor && lerValor(it.valor) === null) return setErroLocal(`Valor pago inválido em ${a.rotulo}.`);
    }
    setErroLocal("");
    setEnviando(true);
    try {
      const fd = new FormData();
      const lista: { chave: string; pago_em: string; valor: number | null; arquivo?: string }[] = [];
      for (const [i, a] of selecionados.entries()) {
        const it = itens[a.chave];
        const p = paginaDe(a.chave);
        let arquivo: string | undefined;
        if (p) {
          arquivo = `arq_${i}`;
          fd.append(arquivo, await extrairPagina(p.arquivo, p.pagina, `comprovante-${a.numero}${a.tipo === "parcela" ? "-parcela" : ""}.pdf`));
        }
        lista.push({ chave: a.chave, pago_em: it.data, valor: it.valor ? lerValor(it.valor) : null, arquivo });
      }
      fd.set("itens", JSON.stringify(lista));
      startTransition(() => acao(fd));
    } finally {
      setEnviando(false);
    }
  }

  const comComprovante = selecionados.filter((a) => paginaDe(a.chave)).length;
  const total = selecionados.reduce((s, a) => s + (lerValor(itens[a.chave]?.valor) ?? a.valor), 0);

  return (
    <div className="space-y-6">
      {estado?.erro && <Aviso tipo="erro">{estado.erro}</Aviso>}
      {selecionados.length === 0 && (
        <Aviso tipo="info">
          Nenhuma conta desta seleção está liberada para baixa agora (já foram baixadas, canceladas ou ainda estão em aprovação).{" "}
          <Link href="/pagamentos?status=aguardando_pagamento" className="underline">
            Voltar para Contas a pagar
          </Link>
        </Aviso>
      )}
      {erroLocal && <Aviso tipo="erro">{erroLocal}</Aviso>}

      <Cartao titulo={`1. ${selecionados.length === 1 ? "Pagamento" : `Pagamentos (${selecionados.length})`}`} semPadding>
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>Pagamento</th>
                <th className="text-right">Valor</th>
                <th>Data do pagamento</th>
                <th>Valor pago (R$)</th>
                <th>Comprovante</th>
                {selecionados.length > 1 && <th />}
              </tr>
            </thead>
            <tbody>
              {selecionados.map((a) => {
                const it = itens[a.chave];
                const p = paginaDe(a.chave);
                return (
                  <tr key={a.chave} data-item={a.chave}>
                    <td className="min-w-64 text-sm">
                      {a.rotulo}
                      <div className="text-xs text-slate-500">venc. {formatarData(a.vencimento)}</div>
                    </td>
                    <td className="text-right tabular-nums whitespace-nowrap">{moeda(a.valor)}</td>
                    <td>
                      <input type="date" value={it.data} onChange={(e) => alterarItem(a.chave, "data", e.target.value)} className="campo w-40" aria-label={`Data do pagamento nº ${a.numero}`} />
                    </td>
                    <td>
                      <input
                        value={it.valor}
                        onChange={(e) => alterarItem(a.chave, "valor", e.target.value)}
                        inputMode="decimal"
                        placeholder={valorParaCampo(a.valor)}
                        className="campo w-32 tabular-nums"
                        aria-label={`Valor pago nº ${a.numero}`}
                      />
                      {it.valor && lerValor(it.valor) !== null && (lerValor(it.valor) as number) < a.valor && (
                        <div className="mt-1 text-xs text-amber-700">Menor que o valor: a diferença fica como saldo em aberto.</div>
                      )}
                    </td>
                    <td className="text-xs">
                      {p ? (
                        <>
                          <div className="font-medium text-slate-700">
                            {p.comprovante.tipo === "pix" ? "PIX" : "Boleto"} {p.comprovante.valor !== null ? moeda(p.comprovante.valor) : ""}
                          </div>
                          <div className="text-slate-500">
                            {p.nomeArquivo}, pág. {p.pagina}
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-500">Sem comprovante</span>
                      )}
                    </td>
                    {selecionados.length > 1 && (
                      <td>
                        <button
                          type="button"
                          className="text-xs text-slate-500 hover:text-red-700 hover:underline"
                          onClick={() => {
                            setTirados((s) => new Set(s).add(a.chave));
                            setPaginas((ps) => ps.map((q) => (q.atribuido === a.chave ? { ...q, atribuido: "", confianca: "nenhuma", motivo: "" } : q)));
                          }}
                        >
                          Tirar
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Cartao>

      <Cartao titulo="2. Comprovantes do banco (opcional)">
        <p className="mb-3 text-sm text-slate-600">
          Envie o(s) PDF(s) do banco (PIX e boletos podem ser arquivos separados). Cada página é um comprovante; o sistema liga cada um ao
          pagamento marcado correspondente e preenche a data e o valor. Páginas repetidas são ignoradas.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Campo rotulo="PDF(s) dos comprovantes" ajuda="A leitura acontece no seu navegador e leva alguns segundos por página.">
              <input
                type="file"
                accept="application/pdf"
                multiple
                className="campo"
                aria-label="PDFs dos comprovantes"
                onChange={(e) => {
                  setArquivos(Array.from(e.target.files ?? []));
                  setPaginas([]);
                  setProgresso("");
                }}
              />
            </Campo>
          </div>
          <Botao type="button" variante="secundario" onClick={lerComprovantes} disabled={lendo || !arquivos.length}>
            {lendo ? "Lendo…" : "Ler comprovantes"}
          </Botao>
        </div>
        {progresso && (
          <p className="mt-3 text-sm text-slate-700" role="status">
            {progresso}
          </p>
        )}
        {paginas.length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-md border border-slate-200">
            <table className="tabela">
              <thead>
                <tr>
                  <th>Comprovante</th>
                  <th className="text-right">Valor</th>
                  <th>Pago para</th>
                  <th className="min-w-72">Ligado a</th>
                </tr>
              </thead>
              <tbody>
                {paginas.map((p) => {
                  const c = p.comprovante;
                  return (
                    <tr key={p.id} data-pagina={p.id} className={p.repetidaDe ? "bg-slate-50 text-slate-400" : undefined}>
                      <td className="text-xs whitespace-nowrap">
                        <div className="font-medium text-slate-700">{c.tipo === "pix" ? "PIX" : c.tipo === "boleto" ? "Boleto" : "Outro"}</div>
                        <div>
                          {p.nomeArquivo}, pág. {p.pagina}
                        </div>
                      </td>
                      <td className="text-right tabular-nums">{c.valor === null ? <span className="text-red-700">não lido</span> : moeda(c.valor)}</td>
                      <td className="text-xs">
                        <div className="font-medium text-slate-700">{c.beneficiario ?? "—"}</div>
                        {c.data && <div>em {formatarData(c.data)}</div>}
                        {c.descricao && <div>“{c.descricao}”</div>}
                      </td>
                      <td>
                        {p.repetidaDe ? (
                          <span className="text-xs">Repetida ({p.repetidaDe}). Ignorada.</span>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <select value={p.atribuido} onChange={(e) => ligar(p.id, e.target.value)} className="campo" aria-label={`Ligar ${p.id}`}>
                                <option value="">Não usar</option>
                                {selecionados
                                  .filter((a) => a.chave === p.atribuido || !paginaDe(a.chave))
                                  .map((a) => (
                                    <option key={a.chave} value={a.chave}>
                                      {a.rotulo}
                                    </option>
                                  ))}
                              </select>
                              <Selo cor={COR[p.confianca]}>{p.atribuido || p.confianca !== "nenhuma" ? ROTULO[p.confianca] : "Não usado"}</Selo>
                            </div>
                            {p.motivo && <div className="mt-1 text-xs text-slate-600">{p.atribuido || p.confianca === "ambigua" ? p.motivo : "Nenhum pagamento marcado com este valor."}</div>}
                            {!p.atribuido && /fundo\s+fixo/i.test(c.descricao ?? "") && (
                              <div className="mt-1 text-xs text-slate-600">Parece reposição de fundo fixo: registre em Fundos fixos.</div>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Cartao>

      <div className="flex flex-wrap items-center gap-3">
        <Botao type="button" variante="sucesso" onClick={confirmar} disabled={enviando || registrando || selecionados.length === 0}>
          {enviando || registrando ? "Registrando…" : selecionados.length === 1 ? "Registrar baixa" : `Registrar ${selecionados.length} baixas`}
        </Botao>
        <span className="text-sm text-slate-600">
          Total {moeda(total)} · {comComprovante} com comprovante
          {selecionados.length - comComprovante > 0 ? ` · ${selecionados.length - comComprovante} sem comprovante` : ""}
        </span>
      </div>
    </div>
  );
}
