"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { moeda } from "@/lib/formato";
import type { Candidato, Classificacao, LinhaExtrato, Sugestao } from "@/lib/consultas/conciliacao";
import { arquivar, conciliar, criarContaBancaria, desfazer, importarExtrato, renomearConta, restaurar } from "./actions";

const br = (iso: string) => iso.split("-").reverse().join("/");
const botao = "rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";

function Mensagem({ erro }: { erro: string }) {
  return erro ? (
    <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert" data-erro-conciliacao>
      {erro}
    </p>
  ) : null;
}

/** Importar um ou vários extratos OFX (a conta é reconhecida pelo próprio arquivo). */
export function ImportarExtrato({ contaId, rotulo = "Importar extrato OFX" }: { contaId?: string; rotulo?: string }) {
  const [estado, acao, enviando] = useActionState(importarExtrato, null);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <form action={acao} className="flex flex-col items-end">
      {contaId && <input type="hidden" name="conta_id" value={contaId} />}
      <input
        ref={ref}
        type="file"
        name="arquivo"
        accept=".ofx,.OFX"
        multiple
        className="hidden"
        aria-label="Arquivo OFX do extrato"
        onChange={(e) => e.currentTarget.files?.length && e.currentTarget.form?.requestSubmit()}
      />
      <button type="button" disabled={enviando} onClick={() => ref.current?.click()} className={`${botao} bg-marca-700 text-white hover:bg-marca-800`}>
        {enviando ? "Importando…" : rotulo}
      </button>
      {estado?.erro && <Mensagem erro={estado.erro} />}
    </form>
  );
}

export function RenomearConta({ id, nome, aberto = false }: { id: string; nome: string; aberto?: boolean }) {
  const [editando, setEditando] = useState(aberto);
  const [valor, setValor] = useState(nome);
  const [erro, setErro] = useState("");
  const [pend, iniciar] = useTransition();
  const router = useRouter();
  if (!editando)
    return (
      <button type="button" onClick={() => setEditando(true)} className="text-xs text-sky-700 hover:underline">
        Renomear
      </button>
    );
  return (
    <span className="flex flex-wrap items-center gap-1">
      <input value={valor} onChange={(e) => setValor(e.target.value)} className="campo h-8 w-56 py-1" aria-label="Nome da conta bancária" autoFocus />
      <button
        type="button"
        disabled={pend || !valor.trim()}
        onClick={() =>
          iniciar(async () => {
            const r = await renomearConta(id, valor);
            if (r.erro) return setErro(r.erro);
            setEditando(false);
            router.refresh();
          })
        }
        className={`${botao} bg-sky-700 text-white`}
      >
        Salvar
      </button>
      <button type="button" onClick={() => setEditando(false)} className="text-xs text-slate-500">
        Cancelar
      </button>
      {erro && <span className="text-xs text-red-600">{erro}</span>}
    </span>
  );
}

const ROTULOS: Record<Classificacao, string> = {
  tarifa: "Tarifa bancária",
  aplicacao: "Aplicação / resgate",
  entrada: "Entrada recebida",
  transferencia: "Transferência entre contas",
  cartao: "Cartão de crédito",
  imposto: "Imposto / tributo",
  emprestimo: "Empréstimo / consórcio / capitalização",
  outro: "Outro",
};

/** Menu "Arquivar ▾": a linha do banco não é conta a pagar; escolha o tipo (tarifa, aplicação, entrada…). */
function MenuIgnorar({ ids, rotulo = "Arquivar ▾", sugerida, aoTerminar, pequeno = false }: { ids: string[]; rotulo?: string; sugerida?: Classificacao | null; aoTerminar: (erro?: string) => void; pequeno?: boolean }) {
  const [aberto, setAberto] = useState(false);
  const [pend, iniciar] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setAberto(false);
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto]);
  const tipos = (Object.keys(ROTULOS) as Classificacao[]).sort((x, y) => Number(y === sugerida) - Number(x === sugerida));
  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={pend || !ids.length} onClick={() => setAberto(!aberto)} className={`${pequeno ? "rounded border px-2 py-0.5 text-xs" : `${botao} border`} border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40`}>
        {pend ? "Arquivando…" : rotulo}
      </button>
      {aberto && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          <div className="px-4 py-1 text-xs text-slate-500">Não é conta a pagar. Arquivar como:</div>
          {tipos.map((c) => (
            <button
              key={c}
              role="menuitem"
              type="button"
              className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() =>
                iniciar(async () => {
                  setAberto(false);
                  aoTerminar((await arquivar(ids, c)).erro);
                })
              }
            >
              {ROTULOS[c]}
              {c === sugerida && <span className="ml-1 text-xs text-slate-400">(sugerido)</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const DIAS = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
const diaSemana = (iso: string) => DIAS[new Date(iso + "T12:00:00Z").getUTCDay()];

/**
 * Uma conciliação pendente, como no Conta Azul: "Lançamentos do banco" à esquerda, a sugestão no meio
 * (Encontramos / Quase lá + Conciliar) e "Lançamentos do sistema" à direita. Nada acontece sem clique.
 */
export function LinhaPendente({ linha, sugestao, candidatos, podeAgir }: { linha: LinhaExtrato; sugestao: Sugestao | null; candidatos: Candidato[]; podeAgir: boolean }) {
  const router = useRouter();
  const [erro, setErro] = useState("");
  const [buscar, setBuscar] = useState(false);
  const [descartada, setDescartada] = useState(false);
  const [inicial, setInicial] = useState<string[]>([]);
  const [pend, iniciar] = useTransition();
  const fim = (e?: string) => (e ? setErro(e) : (setErro(""), router.refresh()));
  const sug = descartada ? null : sugestao;
  const conta = sug?.tipo === "conta" ? sug : null;
  const classe = sug?.tipo === "classificar" ? sug.classificacao : null;
  const saida = linha.valor < 0;
  const abrirBusca = (pre: string[] = []) => (setInicial(pre), setBuscar(true));
  const conciliarAgora = () => conta && iniciar(async () => fim((await conciliar(linha.id, [{ tipo: conta.candidato.tipo, id: conta.candidato.id }], null)).erro));

  return (
    <div className="grid items-stretch gap-3 px-4 py-3 lg:grid-cols-[1fr_8rem_1fr]" data-linha-banco={linha.id}>
      {/* Lançamento do banco */}
      <div className="flex flex-col rounded-md border border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
          <span className="flex items-center gap-2 text-sm">
            {podeAgir && (
              <input
                type="checkbox"
                className="sel-linha h-4 w-4"
                data-linha={linha.id}
                data-conc={conta && conta.diferenca === 0 ? `${conta.candidato.tipo}:${conta.candidato.id}` : ""}
                data-nivel={conta?.nivel ?? ""}
                data-classe={classe ?? ""}
                aria-label={`Selecionar ${linha.descricao} ${moeda(linha.valor)}`}
              />
            )}
            <strong className="tabular-nums">{br(linha.data)}</strong>
            <span className="text-slate-500">{diaSemana(linha.data)}</span>
          </span>
          <span className={`text-base font-semibold tabular-nums ${saida ? "text-red-600" : "text-emerald-700"}`}>{moeda(linha.valor)}</span>
        </div>
        <div className="flex-1 px-3 py-2 text-sm break-words text-slate-800">{linha.descricao || linha.tipo || "—"}</div>
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2">
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Integração bancária (OFX)</span>
          {podeAgir && <MenuIgnorar ids={[linha.id]} sugerida={classe} aoTerminar={fim} pequeno />}
        </div>
      </div>

      {/* Meio: sugestão + conciliar */}
      <div className="flex flex-row items-center justify-center gap-2 lg:flex-col">
        {conta ? (
          <>
            <span className={`rounded px-2 py-0.5 text-xs font-semibold ${conta.nivel === "encontramos" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`} data-sugestao={conta.nivel}>
              {conta.nivel === "encontramos" ? "Encontramos" : "Quase lá"}
            </span>
            {podeAgir && (
              <button
                type="button"
                disabled={pend}
                className={`${botao} w-28 ${conta.diferenca === 0 ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"} text-white`}
                onClick={() => (conta.diferenca === 0 ? conciliarAgora() : abrirBusca([conta.candidato.chave]))}
                title={conta.diferenca === 0 ? undefined : "Valor diferente: confira e diga se foi juros/multa, desconto ou pagamento parcial"}
              >
                {pend ? "…" : "Conciliar"}
              </button>
            )}
          </>
        ) : classe ? (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-center text-xs font-semibold text-slate-600" data-sugestao="classificar">
            Não é conta a pagar?
          </span>
        ) : (
          <span className="text-xs text-slate-400">Sem sugestão</span>
        )}
      </div>

      {/* Lançamento do sistema */}
      <div className="flex flex-col rounded-md border border-slate-200 bg-white">
        {conta ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
              <span className="flex items-center gap-2">
                <span className="text-base font-semibold text-slate-800 tabular-nums">{moeda(conta.candidato.valor)}</span>
                {conta.diferenca !== 0 && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Diferença {moeda(Math.abs(conta.diferenca))}</span>}
              </span>
              <span className="text-sm">
                <strong className="tabular-nums">{br(conta.candidato.data)}</strong> <span className="text-slate-500">{conta.candidato.pago ? "pago" : "vencimento"}</span>
              </span>
            </div>
            <div className="flex-1 space-y-1 px-3 py-2 text-sm">
              <div className="text-slate-800">
                <Link href={`/pagamentos/${conta.candidato.pagamentoId}`} target="_blank" className="font-medium hover:underline">
                  nº {conta.candidato.numero}
                  {conta.candidato.parcela ? ` · parcela ${conta.candidato.parcela}` : ""}
                </Link>{" "}
                · {conta.candidato.descricao}
              </div>
              <div className="grid gap-x-4 gap-y-0.5 text-xs text-slate-600 sm:grid-cols-2">
                <span>
                  <strong>Favorecido:</strong> {conta.candidato.favorecido}
                </span>
                <span>
                  <strong>Categoria:</strong> {conta.candidato.categoria ?? "—"}
                </span>
                <span>
                  <strong>Centro de custo:</strong> {conta.candidato.obra}
                </span>
                <span>
                  <strong>Conta bancária:</strong> {conta.candidato.contaNome ?? "não informada"}
                </span>
                <span>
                  <strong>Situação:</strong> {conta.candidato.pago ? "já baixada (só liga)" : "liberada, em aberto (a conciliação dá a baixa)"}
                </span>
              </div>
              <div className="text-xs text-slate-500">{conta.motivo}</div>
            </div>
            {podeAgir && (
              <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-3 py-2">
                {conta.diferenca !== 0 && (
                  <button type="button" className="rounded bg-sky-700 px-2 py-1 text-xs font-medium text-white hover:bg-sky-800" onClick={() => abrirBusca([conta.candidato.chave])}>
                    Ajustar valores
                  </button>
                )}
                <Link href={`/pagamentos/${conta.candidato.pagamentoId}`} target="_blank" className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">
                  Ver conta
                </Link>
                <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => (setDescartada(true), abrirBusca())}>
                  Desvincular
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-start justify-center gap-2 px-3 py-3 text-sm text-slate-600">
            {classe ? (
              <>
                <span>
                  Parece <strong>{ROTULOS[classe]}</strong> — não é uma conta a pagar.
                </span>
                {podeAgir && (
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={pend} className={`${botao} bg-slate-700 text-white hover:bg-slate-800`} onClick={() => iniciar(async () => fim((await arquivar([linha.id], classe)).erro))}>
                      Arquivar como {ROTULOS[classe]}
                    </button>
                    {saida && (
                      <button type="button" className={`${botao} border border-slate-300 bg-white text-slate-700`} onClick={() => abrirBusca()}>
                        Buscar lançamento
                      </button>
                    )}
                  </div>
                )}
              </>
            ) : saida ? (
              <>
                <span>Nenhuma conta a pagar com valor e data parecidos.</span>
                {podeAgir && (
                  <button type="button" className={`${botao} border border-sky-300 bg-white text-sky-800 hover:bg-sky-50`} onClick={() => abrirBusca()}>
                    🔍 Buscar lançamento
                  </button>
                )}
              </>
            ) : (
              <span>Entrada no banco: não é conta a pagar. Use “Arquivar ▾” e escolha o tipo.</span>
            )}
          </div>
        )}
        <div className="px-3">
          <Mensagem erro={erro} />
        </div>
      </div>
      {buscar && <BuscarConta linha={linha} candidatos={candidatos} inicial={inicial} aoFechar={() => (setBuscar(false), setInicial([]))} aoConciliar={() => (setBuscar(false), router.refresh())} />}
    </div>
  );
}

/** Janela "Buscar conta a pagar": filtra, marca uma ou várias e concilia quando a diferença é zero (ou ajusta). */
function BuscarConta({ linha, candidatos, inicial = [], aoFechar, aoConciliar }: { linha: LinhaExtrato; candidatos: Candidato[]; inicial?: string[]; aoFechar: () => void; aoConciliar: () => void }) {
  const alvo = -linha.valor;
  const [busca, setBusca] = useState("");
  const [marcados, setMarcados] = useState<string[]>(inicial);
  const [diferenca, setDiferenca] = useState<"desconto" | "saldo" | "juros" | "encargos" | "">("");
  const [erro, setErro] = useState("");
  const [pend, iniciar] = useTransition();
  const lista = useMemo(() => {
    const t = busca
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();
    const num = Number(t.replace(/\./g, "").replace(",", "."));
    return candidatos
      .filter((c) => {
        if (!t) return true;
        const texto = `${c.numero} ${c.favorecido} ${c.fornecedor ?? ""} ${c.descricao} ${c.obra}`.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
        return texto.includes(t) || (Number.isFinite(num) && num > 0 && Math.abs(c.valor - num) < 0.005);
      })
      .sort((a, b) => Math.abs(a.valor - alvo) - Math.abs(b.valor - alvo) || Math.abs(new Date(a.data).getTime() - new Date(linha.data).getTime()) - Math.abs(new Date(b.data).getTime() - new Date(linha.data).getTime()))
      .slice(0, t ? 300 : 80);
  }, [busca, candidatos, alvo, linha.data]);
  const escolhidos = candidatos.filter((c) => marcados.includes(c.chave));
  const soma = Math.round(escolhidos.reduce((s, c) => s + c.valor, 0) * 100) / 100;
  const dif = Math.round((alvo - soma) * 100) / 100;
  const um = escolhidos.length === 1 ? escolhidos[0] : null;
  const ajuste = um && !um.pago && dif !== 0;
  const varios = escolhidos.length > 1;
  const pode =
    escolhidos.length > 0 &&
    (dif === 0 || Boolean(ajuste && (dif > 0 ? diferenca === "juros" : diferenca === "desconto" || diferenca === "saldo")) || (varios && dif > 0 && diferenca === "encargos"));
  const grande = Boolean(um && dif > 0 && dif > um.valor * 0.1);

  return (
    <div role="dialog" aria-label="Buscar conta a pagar" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl">
        <div className="border-b border-slate-200 p-4">
          <h3 className="text-base font-semibold text-slate-800">Buscar conta a pagar</h3>
          <p className="text-sm text-slate-600">
            Banco: {br(linha.data)} · {linha.descricao} · <strong className="text-red-600">{moeda(linha.valor)}</strong>
          </p>
          <input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Pesquisar por nº, favorecido, descrição, centro de custo ou valor (ex.: 2.420,00)" className="campo mt-3" aria-label="Pesquisar conta a pagar" />
          <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
            <button
              type="button"
              className="text-sky-700 hover:underline disabled:text-slate-300"
              disabled={!lista.length}
              onClick={() => (setDiferenca(""), setMarcados([...new Set([...marcados, ...lista.map((c) => c.chave)])]))}
            >
              Marcar todas as listadas ({lista.length})
            </button>
            {marcados.length > 0 && (
              <button type="button" className="text-slate-500 hover:underline" onClick={() => (setDiferenca(""), setMarcados([]))}>
                Desmarcar todas
              </button>
            )}
          </div>
        </div>
        <ul className="min-h-40 flex-1 overflow-y-auto">
          {lista.length === 0 && <li className="p-4 text-sm text-slate-500">Nenhuma conta liberada ou paga sem conciliação encontrada.</li>}
          {lista.map((c) => (
            <li key={c.chave} className="border-b border-slate-100">
              <label className="flex cursor-pointer items-start gap-3 px-4 py-2 hover:bg-slate-50">
                <input type="checkbox" className="mt-1" checked={marcados.includes(c.chave)} onChange={(e) => (setDiferenca(""), setMarcados(e.target.checked ? [...marcados, c.chave] : marcados.filter((x) => x !== c.chave)))} aria-label={`Escolher nº ${c.numero}${c.parcela ? ` parcela ${c.parcela}` : ""}`} />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium text-slate-800">
                    nº {c.numero}
                    {c.parcela ? ` · parcela ${c.parcela}` : ""} · {c.favorecido}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {c.descricao} · {c.obra} · {c.pago ? `paga em ${br(c.data)}` : `vence ${br(c.data)} · em aberto`}
                    {c.contaNome ? ` · 🏦 ${c.contaNome}` : ""}
                  </span>
                </span>
                <span className={`text-sm font-semibold tabular-nums ${Math.abs(c.valor - alvo) < 0.005 ? "text-emerald-700" : "text-slate-700"}`}>{moeda(c.valor)}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="space-y-2 border-t border-slate-200 p-4">
          <div className="flex flex-wrap gap-4 text-sm" data-diferenca={dif.toFixed(2)}>
            <span>
              Banco: <strong>{moeda(alvo)}</strong>
            </span>
            <span>
              Selecionado: <strong>{moeda(soma)}</strong>
            </span>
            <span className={dif === 0 ? "text-emerald-700" : "text-amber-700"}>
              Diferença: <strong>{moeda(dif)}</strong>
            </span>
          </div>
          {ajuste && dif > 0 && (
            <div className="space-y-1 text-sm">
              {grande && <p className="text-xs font-medium text-amber-700">Atenção: a diferença é maior que 10% da conta. Se o banco pagou mais de uma conta, marque todas.</p>}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={diferenca === "juros"} onChange={(e) => setDiferenca(e.target.checked ? "juros" : "")} /> O banco pagou {moeda(dif)} a mais: foi juros/multa (a baixa fica com o valor do banco)
              </label>
            </div>
          )}
          {ajuste && dif < 0 && (
            <fieldset className="flex flex-wrap gap-4 text-sm">
              <legend className="mb-1 text-xs text-slate-600">O banco pagou {moeda(-dif)} a menos. O que foi?</legend>
              <label className="flex items-center gap-1">
                <input type="radio" name="diferenca" checked={diferenca === "desconto"} onChange={() => setDiferenca("desconto")} /> Desconto (quita a conta)
              </label>
              {um?.tipo === "pagamento" && (
                <label className="flex items-center gap-1">
                  <input type="radio" name="diferenca" checked={diferenca === "saldo"} onChange={() => setDiferenca("saldo")} /> Pagamento parcial (o resto fica em aberto)
                </label>
              )}
            </fieldset>
          )}
          {varios && dif < 0 && <p className="text-xs text-amber-700">A soma das contas passou do valor do banco: desmarque o que não entrou neste pagamento.</p>}
          {varios && dif > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={diferenca === "encargos"} onChange={(e) => setDiferenca(e.target.checked ? "encargos" : "")} /> O banco pagou {moeda(dif)} a mais que a soma: são encargos (juros, IOF, anuidade, tarifa) — fica registrado na conciliação
            </label>
          )}
          {um?.pago && dif !== 0 && <p className="text-xs text-amber-700">Esta conta já foi baixada com outro valor: corrija a baixa ou escolha outra.</p>}
          <Mensagem erro={erro} />
          <div className="flex justify-end gap-2">
            <button type="button" className={`${botao} border border-slate-300`} onClick={aoFechar}>
              Voltar
            </button>
            <button
              type="button"
              disabled={!pode || pend}
              className={`${botao} bg-emerald-600 text-white hover:bg-emerald-700`}
              onClick={() =>
                iniciar(async () => {
                  const r = await conciliar(
                    linha.id,
                    escolhidos.map((c) => ({ tipo: c.tipo, id: c.id })),
                    (ajuste || (varios && dif > 0)) && diferenca ? (diferenca as "desconto" | "saldo" | "juros" | "encargos") : null,
                  );
                  if (r.erro) return setErro(r.erro);
                  aoConciliar();
                })
              }
            >
              {pend ? "Conciliando…" : escolhidos.length > 1 ? `Conciliar ${escolhidos.length} contas` : "Conciliar"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Desfazer({ linhaId, algumaBaixou }: { linhaId: string; algumaBaixou: boolean }) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [voltar, setVoltar] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState("");
  const [pend, iniciar] = useTransition();
  return (
    <>
      <button type="button" onClick={() => setAberto(true)} className="text-sm text-sky-700 hover:underline">
        Desfazer
      </button>
      {aberto && (
        <div role="dialog" aria-label="Desfazer conciliação" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-800">Desfazer conciliação</h3>
            <p className="mt-1 text-sm text-slate-600">O lançamento do banco volta para as pendentes.</p>
            <div className="mt-3 space-y-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="radio" name="voltar" checked={!voltar} onChange={() => setVoltar(false)} /> <span>Apenas desfazer — as contas continuam pagas</span>
              </label>
              {algumaBaixou && (
                <label className="flex items-start gap-2">
                  <input type="radio" name="voltar" checked={voltar} onChange={() => setVoltar(true)} /> <span>Desfazer e estornar a baixa feita pela conciliação — as contas voltam a ficar a pagar</span>
                </label>
              )}
            </div>
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (obrigatório)" className="campo mt-3" aria-label="Motivo" />
            <Mensagem erro={erro} />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className={`${botao} border border-slate-300`} onClick={() => setAberto(false)}>
                Voltar
              </button>
              <button
                type="button"
                disabled={pend || motivo.trim().length < 3}
                className={`${botao} bg-amber-600 text-white`}
                onClick={() =>
                  iniciar(async () => {
                    const r = await desfazer(linhaId, voltar, motivo);
                    if (r.erro) return setErro(r.erro);
                    setAberto(false);
                    router.refresh();
                  })
                }
              >
                {pend ? "Desfazendo…" : "Desfazer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function Restaurar({ id }: { id: string }) {
  const router = useRouter();
  const [pend, iniciar] = useTransition();
  const [erro, setErro] = useState("");
  return (
    <span>
      <button type="button" disabled={pend} className="text-sm text-sky-700 hover:underline" onClick={() => iniciar(async () => { const r = await restaurar(id); if (r.erro) setErro(r.erro); else router.refresh(); })}>
        {pend ? "Restaurando…" : "Restaurar"}
      </button>
      {erro && <span className="ml-2 text-xs text-red-600">{erro}</span>}
    </span>
  );
}

/**
 * Barra "Selecionar lançamentos ▾ · Conciliar · Arquivar ▾ · Ordenar ▾" (como no Conta Azul).
 * Só age sobre o que VOCÊ marcou. Conciliar vale para as marcadas que têm sugestão com valor igual.
 */
export function BarraLancamentos({ ordem, linkOrdem }: { ordem: string; linkOrdem: Record<string, string> }) {
  const router = useRouter();
  const [sel, setSel] = useState({ total: 0, conc: 0, classe: 0 });
  const [menu, setMenu] = useState<"" | "selecionar" | "ordenar">("");
  const [pend, iniciar] = useTransition();
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const caixas = () => Array.from(document.querySelectorAll<HTMLInputElement>("input.sel-linha"));
  useEffect(() => {
    const contar = () => {
      const m = caixas().filter((c) => c.checked);
      setSel({ total: m.length, conc: m.filter((c) => c.dataset.conc).length, classe: m.filter((c) => c.dataset.classe).length });
    };
    document.addEventListener("change", contar);
    contar();
    return () => document.removeEventListener("change", contar);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const fora = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setMenu("");
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [menu]);
  const marcar = (filtro: (c: HTMLInputElement) => boolean) => {
    caixas().forEach((c) => (c.checked = filtro(c)));
    document.dispatchEvent(new Event("change"));
    setMenu("");
  };
  const marcadas = () => caixas().filter((c) => c.checked);
  const item = "block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50";

  return (
    <div ref={ref} className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm">
      <div className="relative">
        <button type="button" onClick={() => setMenu(menu === "selecionar" ? "" : "selecionar")} className={`${botao} border border-sky-300 bg-white text-sky-800`}>
          Selecionar lançamentos{sel.total ? ` (${sel.total})` : ""} ▾
        </button>
        {menu === "selecionar" && (
          <div role="menu" className="absolute left-0 z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            <button role="menuitem" type="button" className={item} onClick={() => marcar(() => true)}>Todos desta página</button>
            <button role="menuitem" type="button" className={item} onClick={() => marcar((c) => c.dataset.nivel === "encontramos" && Boolean(c.dataset.conc))}>Com sugestão “Encontramos”</button>
            <button role="menuitem" type="button" className={item} onClick={() => marcar((c) => Boolean(c.dataset.conc))}>Com sugestão de valor igual</button>
            <button role="menuitem" type="button" className={item} onClick={() => marcar((c) => Boolean(c.dataset.classe))}>Que não parecem contas a pagar (tarifas, entradas…)</button>
            <button role="menuitem" type="button" className={`${item} border-t border-slate-100`} onClick={() => marcar(() => false)}>Nenhum</button>
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={!sel.conc || pend}
        title={sel.total && !sel.conc ? "Nenhuma das marcadas tem sugestão com valor igual" : undefined}
        className={`${botao} bg-emerald-600 text-white hover:bg-emerald-700`}
        onClick={() =>
          iniciar(async () => {
            let ok = 0;
            const erros: string[] = [];
            for (const c of marcadas().filter((x) => x.dataset.conc)) {
              const [tipo, id] = c.dataset.conc!.split(":");
              const r = await conciliar(c.dataset.linha!, [{ tipo: tipo as "pagamento" | "parcela", id }], null);
              if (r.erro) erros.push(r.erro);
              else ok++;
            }
            setMsg(erros.length ? { tipo: "erro", texto: `${ok} conciliada(s) · ${erros.length} não: ${erros.join(" · ")}` } : { tipo: "ok", texto: `${ok} conciliada(s).` });
            router.refresh();
          })
        }
      >
        {pend ? "Aguarde…" : `Conciliar${sel.conc ? ` (${sel.conc})` : ""}`}
      </button>
      <IgnorarMarcadas habilitado={sel.total > 0} comSugestao={sel.classe} aoTerminar={(r) => (setMsg(r), router.refresh())} />
      <div className="relative ml-auto">
        <button type="button" onClick={() => setMenu(menu === "ordenar" ? "" : "ordenar")} className={`${botao} border border-slate-300 bg-white text-slate-700`}>
          Ordenar ▾
        </button>
        {menu === "ordenar" && (
          <div role="menu" className="absolute right-0 z-30 mt-1 w-56 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            {(
              [
                ["antigas", "Data: mais antigas primeiro"],
                ["recentes", "Data: mais recentes primeiro"],
                ["maior", "Maior valor primeiro"],
              ] as const
            ).map(([v, r]) => (
              <Link key={v} role="menuitem" href={linkOrdem[v]} className={`${item} ${ordem === v ? "font-semibold text-sky-800" : ""}`}>
                {r}
              </Link>
            ))}
          </div>
        )}
      </div>
      {msg && (
        <span className={`w-full text-xs ${msg.tipo === "erro" ? "text-amber-800" : "text-emerald-700"}`} role="status" data-resultado-lote>
          {msg.texto}
        </span>
      )}
    </div>
  );
}

/** "Arquivar ▾" da barra: arquiva as marcadas com o tipo sugerido de cada uma, ou todas com um tipo escolhido. */
function IgnorarMarcadas({ habilitado, comSugestao, aoTerminar }: { habilitado: boolean; comSugestao: number; aoTerminar: (r: { tipo: "ok" | "erro"; texto: string }) => void }) {
  const [aberto, setAberto] = useState(false);
  const [pend, iniciar] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setAberto(false);
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto]);
  const marcadas = () => Array.from(document.querySelectorAll<HTMLInputElement>("input.sel-linha:checked"));
  const executar = (fn: () => Promise<{ n: number; erro?: string }>) =>
    iniciar(async () => {
      setAberto(false);
      const r = await fn();
      aoTerminar(r.erro ? { tipo: "erro", texto: r.erro } : { tipo: "ok", texto: `${r.n} lançamento(s) arquivado(s).` });
    });
  return (
    <div ref={ref} className="relative">
      <button type="button" disabled={!habilitado || pend} onClick={() => setAberto(!aberto)} className={`${botao} border border-slate-300 bg-white text-slate-700`} data-ignorar-marcadas>
        {pend ? "Arquivando…" : "Arquivar ▾"}
      </button>
      {aberto && (
        <div role="menu" className="absolute left-0 z-30 mt-1 w-80 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          <button
            role="menuitem"
            type="button"
            disabled={!comSugestao}
            className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:text-slate-300"
            onClick={() =>
              executar(async () => {
                const grupos = new Map<string, string[]>();
                for (const c of marcadas()) if (c.dataset.classe) grupos.set(c.dataset.classe, [...(grupos.get(c.dataset.classe) ?? []), c.dataset.linha!]);
                let n = 0;
                for (const [classe, ids] of grupos) {
                  const r = await arquivar(ids, classe);
                  if (r.erro) return { n, erro: r.erro };
                  n += ids.length;
                }
                return { n };
              })
            }
          >
            Com o tipo sugerido de cada uma ({comSugestao})
          </button>
          <div className="border-t border-slate-100 px-4 py-1 text-xs text-slate-500">Ou todas as marcadas como:</div>
          {(Object.keys(ROTULOS) as Classificacao[]).map((c) => (
            <button
              key={c}
              role="menuitem"
              type="button"
              className="block w-full px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() =>
                executar(async () => {
                  const ids = marcadas().map((x) => x.dataset.linha!);
                  const r = await arquivar(ids, c);
                  return { n: r.erro ? 0 : ids.length, erro: r.erro };
                })
              }
            >
              {ROTULOS[c]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Ações da conta ▾": importar extrato e renomear. */
export function AcoesDaConta({ contaId, nome }: { contaId: string; nome: string }) {
  const [aberto, setAberto] = useState(false);
  const [renomear, setRenomear] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setAberto(false);
    document.addEventListener("mousedown", fora);
    return () => document.removeEventListener("mousedown", fora);
  }, [aberto]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setAberto(!aberto)} className={`${botao} border border-sky-300 bg-white text-sky-800`}>
        Ações da conta ▾
      </button>
      {aberto && (
        <div role="menu" className="absolute left-0 z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white p-2 shadow-lg">
          <div className="mb-2">
            <ImportarExtrato contaId={contaId} rotulo="Importar extrato desta conta (OFX)" />
          </div>
          {renomear ? (
            <RenomearConta id={contaId} nome={nome} aberto />
          ) : (
            <button role="menuitem" type="button" className="block w-full rounded px-2 py-2 text-left text-sm text-slate-700 hover:bg-slate-50" onClick={() => setRenomear(true)}>
              Renomear conta
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Escolha da conta bancária (como o seletor do Conta Azul). */
export function SeletorConta({ contas, atual }: { contas: { id: string; nome: string; pendentes: number }[]; atual: string }) {
  const router = useRouter();
  return (
    <select value={atual} onChange={(e) => router.push(`/contas-bancarias?conta=${e.target.value}`)} className="campo min-w-72 font-medium" aria-label="Conta bancária">
      {contas.map((c) => (
        <option key={c.id} value={c.id}>
          {c.nome}
          {c.pendentes ? ` — ${c.pendentes} pendente(s)` : ""}
        </option>
      ))}
    </select>
  );
}


/** "Cadastrar conta": nome, banco, agência e conta (o extrato importado depois cai nela). */
export function CadastrarConta({ abertoInicial = false }: { abertoInicial?: boolean }) {
  const [aberto, setAberto] = useState(abertoInicial);
  const [estado, acao, enviando] = useActionState(criarContaBancaria, null);
  const [banco, setBanco] = useState("001");
  if (!aberto)
    return (
      <button type="button" onClick={() => setAberto(true)} className={`${botao} border border-sky-300 bg-white text-sky-800 hover:bg-sky-50`}>
        + Cadastrar conta
      </button>
    );
  return (
    <div role="dialog" aria-label="Cadastrar conta bancária" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <form action={acao} className="w-full max-w-md space-y-3 rounded-lg bg-white p-5 shadow-xl">
        <h3 className="text-base font-semibold text-slate-800">Cadastrar conta bancária</h3>
        <label className="block text-sm">
          Nome
          <input name="nome" required maxLength={80} placeholder="Ex.: Caixa Matriz, BB Parceria" className="campo mt-1" />
        </label>
        <label className="block text-sm">
          Banco
          <select name="banco" value={banco} onChange={(e) => setBanco(e.target.value)} className="campo mt-1">
            <option value="001">001 — Banco do Brasil</option>
            <option value="104">104 — Caixa Econômica Federal</option>
            <option value="237">237 — Bradesco</option>
            <option value="341">341 — Itaú</option>
            <option value="033">033 — Santander</option>
            <option value="756">756 — Sicoob</option>
            <option value="748">748 — Sicredi</option>
            <option value="outro">Outro (informar o código)</option>
          </select>
        </label>
        {banco === "outro" && (
          <label className="block text-sm">
            Código do banco
            <input name="banco_outro" required inputMode="numeric" maxLength={3} className="campo mt-1" />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            Agência
            <input name="agencia" inputMode="numeric" maxLength={10} className="campo mt-1" />
          </label>
          <label className="block text-sm">
            Conta (com dígito)
            <input name="conta" required maxLength={20} placeholder="Ex.: 13970-X" className="campo mt-1" />
          </label>
        </div>
        <p className="text-xs text-slate-500">O extrato OFX importado depois é reconhecido por banco, agência e conta.</p>
        {estado?.erro && <Mensagem erro={estado.erro} />}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${botao} border border-slate-300`} onClick={() => setAberto(false)}>
            Voltar
          </button>
          <button type="submit" disabled={enviando} className={`${botao} bg-marca-700 text-white hover:bg-marca-800`}>
            {enviando ? "Salvando…" : "Cadastrar"}
          </button>
        </div>
      </form>
    </div>
  );
}
