"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useActionState, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { moeda } from "@/lib/formato";
import type { Candidato, Classificacao, LinhaExtrato, ReceitaAberta, SaidaEstornavel, Sugestao, SugestaoLancamento, SugestaoRecebimento } from "@/lib/consultas/conciliacao";
import { pareceEstorno } from "@/lib/conciliacao-sugestao";
import { criarCategoriaRapida, criarCategoriaReceitaRapida } from "@/app/(app)/categorias/actions";
import { arquivar, conciliar, conciliarAplicacao, conciliarEstorno, conciliarReceita, conciliarTransferencia, criarContaBancaria, desfazer, importarExtrato, novaTransferencia, novoLancamento, novoLancamentoCompleto, novoRecebimento, renomearConta, restaurar } from "./actions";

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

type Opcao = { id: string; nome: string };
export type ListasConciliacao = {
  candidatos: Candidato[];
  categorias: Opcao[];
  categoriasReceita: Opcao[];
  obras: (Opcao & { cliente?: string | null })[];
  fornecedores: Opcao[];
  contas: Opcao[]; // outras contas bancárias da empresa (para transferência)
  contaAtual: string;
  receitas?: ReceitaAberta[]; // receitas em aberto (Contas a receber)
};
const ContextoListas = createContext<ListasConciliacao>({ candidatos: [], categorias: [], categoriasReceita: [], obras: [], fornecedores: [], contas: [], contaAtual: "" });

/** Listas usadas pelas linhas (contas a pagar candidatas, categorias, centros de custo, fornecedores, contas) — uma vez só na página. */
export function ProvedorListas({ listas, children }: { listas: ListasConciliacao; children: ReactNode }) {
  return <ContextoListas.Provider value={listas}>{children}</ContextoListas.Provider>;
}

/** "+ Nova" categoria ao lado do campo, sem sair da conciliação; a nova já fica escolhida. */
function NovaCategoria({ tipo, aoCriar }: { tipo: "despesa" | "receita"; aoCriar: (c: Opcao) => void }) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState("");
  const [erro, setErro] = useState("");
  const [pend, iniciar] = useTransition();
  if (!aberto)
    return (
      <button type="button" className="ml-2 text-[11px] font-medium text-sky-700 hover:underline" onClick={() => (setAberto(true), setErro(""))}>
        + Nova
      </button>
    );
  return (
    <span className="mt-1 flex items-center gap-1" data-nova-categoria={tipo}>
      <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} placeholder={tipo === "receita" ? "Ex.: Medição de obra" : "Ex.: Tarifas bancárias"} className="campo py-1 text-sm" aria-label={`Nome da nova categoria de ${tipo}`} maxLength={120} />
      <button
        type="button"
        disabled={pend || !nome.trim()}
        className="rounded bg-sky-700 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        onClick={() =>
          iniciar(async () => {
            const r = tipo === "receita" ? await criarCategoriaReceitaRapida(nome) : await criarCategoriaRapida(nome);
            if (r.erro || !r.id) return setErro(r.erro ?? "Não foi possível cadastrar.");
            aoCriar({ id: r.id, nome: r.nome ?? nome.trim() });
            setAberto(false);
            setNome("");
          })
        }
      >
        Salvar
      </button>
      <button type="button" className="text-xs text-slate-500" onClick={() => setAberto(false)}>
        ✕
      </button>
      {erro && <span className="text-xs text-red-700">{erro}</span>}
    </span>
  );
}

const raio = <span className="ml-1 rounded bg-sky-100 px-1 text-[10px] font-semibold text-sky-700" title="Sugerido a partir dos lançamentos anteriores">⚡ sugerido</span>;

/**
 * Uma conciliação pendente, como no Conta Azul: "Lançamentos do banco" à esquerda, a sugestão no meio
 * (Encontramos / Quase lá + Conciliar) e "Lançamentos do sistema" à direita. Sem conta a pagar parecida,
 * o lado direito oferece "Novo lançamento" (despesa já paga, sem aprovação) ou "Nova transferência".
 * Nada acontece sem clique.
 */
export function LinhaPendente({
  linha,
  sugestao,
  sugestaoLancamento,
  podeAgir,
  estornos = [],
  sugestaoRecebimento = null,
}: {
  linha: LinhaExtrato;
  sugestao: Sugestao | null;
  sugestaoLancamento: SugestaoLancamento | null;
  podeAgir: boolean;
  estornos?: SaidaEstornavel[]; // saídas que esta entrada pode devolver
  sugestaoRecebimento?: SugestaoRecebimento | null; // entrada: sugestão do "Novo lançamento" de receita
}) {
  const { candidatos, categorias: catDespesa, categoriasReceita: catReceita, obras, fornecedores, contas, receitas = [] } = useContext(ContextoListas);
  // Categorias criadas aqui mesmo ("+ Nova") entram na lista desta linha
  const [novasCat, setNovasCat] = useState<{ despesa: Opcao[]; receita: Opcao[] }>({ despesa: [], receita: [] });
  const categorias = [...catDespesa, ...novasCat.despesa];
  const categoriasReceita = [...catReceita, ...novasCat.receita];
  const router = useRouter();
  const [erro, setErro] = useState("");
  const [buscar, setBuscar] = useState(false);
  const [descartada, setDescartada] = useState(false);
  const [inicial, setInicial] = useState<string[]>([]);
  const [pend, iniciar] = useTransition();
  const saida = linha.valor < 0;
  const [aba, setAba] = useState<"lancamento" | "transferencia" | "estorno" | "receita">(
    saida ? "lancamento" : estornos.length && pareceEstorno(linha.descricao) ? "estorno" : "lancamento",
  );
  const [estSel, setEstSel] = useState(estornos.length === 1 ? estornos[0].id : "");
  const [recSel, setRecSel] = useState("");
  const [completar, setCompletar] = useState(false);
  const [lanc, setLanc] = useState({
    descricao: sugestaoLancamento?.descricao ?? linha.descricao,
    categoria: sugestaoLancamento?.categoriaId ?? "",
    obra: sugestaoLancamento?.obraId ?? "",
    fornecedor: sugestaoLancamento?.fornecedorId ?? "",
  });
  const [rec, setRec] = useState({
    descricao: sugestaoRecebimento?.descricao ?? linha.descricao,
    categoria: sugestaoRecebimento?.categoriaId ?? "",
    obra: sugestaoRecebimento?.obraId ?? "",
    cliente: sugestaoRecebimento?.cliente ?? "",
  });
  const [transf, setTransf] = useState({ descricao: linha.descricao, conta: "" });
  const fim = (e?: string) => (e ? setErro(e) : (setErro(""), router.refresh()));
  const sug = descartada ? null : sugestao;
  const conta = sug?.tipo === "conta" ? sug : null;
  const classe = sug?.tipo === "classificar" ? sug.classificacao : null;
  const transfSug = sug?.tipo === "transferencia" ? sug.transferencia : null;
  const estornoSug = sug?.tipo === "estorno" ? sug.saida : null;
  const aplicSug = sug?.tipo === "aplicacao";
  const receitaSug = sug?.tipo === "receita" ? sug : null;
  const abrirBusca = (pre: string[] = []) => (setInicial(pre), setBuscar(true));
  const conciliarAgora = () => conta && iniciar(async () => fim((await conciliar(linha.id, [{ tipo: conta.candidato.tipo, id: conta.candidato.id }], null)).erro));
  const semConta = !conta && !transfSug && !estornoSug && !aplicSug && !receitaSug;
  const podeLancar = Boolean(lanc.categoria && lanc.obra && lanc.descricao.trim());
  const acaoMeio = () => {
    if (transfSug) return iniciar(async () => fim((await conciliarTransferencia(linha.id, transfSug.id)).erro));
    if (estornoSug) return iniciar(async () => fim((await conciliarEstorno(linha.id, estornoSug.id)).erro));
    if (aplicSug) return iniciar(async () => fim((await conciliarAplicacao([linha.id])).erro));
    if (receitaSug) return iniciar(async () => fim((await conciliarReceita(linha.id, receitaSug.receita.id)).erro));
    if (aba === "receita") return iniciar(async () => fim((await conciliarReceita(linha.id, recSel)).erro));
    if (aba === "estorno") return iniciar(async () => fim((await conciliarEstorno(linha.id, estSel)).erro));
    if (aba === "lancamento" && !saida) return iniciar(async () => fim((await novoRecebimento(linha.id, { obra: rec.obra, categoria: rec.categoria, cliente: rec.cliente, descricao: rec.descricao })).erro));
    if (aba === "lancamento") return iniciar(async () => fim((await novoLancamento(linha.id, { obra: lanc.obra, categoria: lanc.categoria, descricao: lanc.descricao, fornecedor: lanc.fornecedor })).erro));
    return iniciar(async () => fim((await novaTransferencia(linha.id, transf.conta, transf.descricao)).erro));
  };
  const meioHabilitado = transfSug || estornoSug || aplicSug || receitaSug ? true : aba === "receita" ? Boolean(recSel) : aba === "lancamento" ? (saida ? podeLancar : Boolean(rec.categoria && rec.obra && rec.cliente.trim() && rec.descricao.trim())) : aba === "estorno" ? Boolean(estSel) : Boolean(transf.conta);
  const sugerido = (campo: "categoria" | "obra" | "fornecedor", valor: string) =>
    sugestaoLancamento && valor && valor === (campo === "categoria" ? sugestaoLancamento.categoriaId : campo === "obra" ? sugestaoLancamento.obraId : sugestaoLancamento.fornecedorId);

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
                data-aplic={aplicSug ? "1" : ""}
                aria-label={`Selecionar ${linha.descricao} ${moeda(linha.valor)}`}
              />
            )}
            <strong className="tabular-nums">{br(linha.data)}</strong>
            <span className="text-slate-500">{diaSemana(linha.data)}</span>
          </span>
          <span className={`text-base font-semibold tabular-nums ${saida ? "text-red-600" : "text-emerald-700"}`}>{moeda(linha.valor)}</span>
        </div>
        <div className="flex-1 px-3 py-2 text-sm break-words text-slate-800" data-descricao-banco>
          {linha.descricao || linha.tipo || "—"}
        </div>
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
        ) : (
          <>
            {aplicSug ? (
              <span className="rounded bg-violet-100 px-2 py-0.5 text-center text-xs font-semibold text-violet-800" data-sugestao="aplicacao">
                {saida ? "Aplicação automática" : "Resgate automático"}
              </span>
            ) : transfSug || estornoSug || receitaSug ? (
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800" data-sugestao={transfSug ? "transferencia" : estornoSug ? "estorno" : "receita"}>
                Encontramos
              </span>
            ) : classe ? (
              <span className="rounded bg-slate-100 px-2 py-0.5 text-center text-xs font-semibold text-slate-600" data-sugestao="classificar">
                Não é conta a pagar?
              </span>
            ) : null}
            {podeAgir && (
              <button
                type="button"
                disabled={pend || !meioHabilitado}
                className={`${botao} w-28 bg-sky-700 text-white hover:bg-sky-800`}
                onClick={acaoMeio}
                title={!meioHabilitado ? (aba === "lancamento" ? (saida ? "Escolha a categoria e o centro de custo" : "Escolha a categoria, o centro de custo e o cliente") : aba === "estorno" ? "Escolha a saída estornada" : "Escolha a outra conta") : undefined}
                data-conciliar-novo
              >
                {pend ? "…" : "Conciliar"}
              </button>
            )}
          </>
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
        ) : transfSug ? (
          <div className="flex-1 space-y-1 px-3 py-3 text-sm" data-transferencia-sugerida>
            <div className="font-medium text-slate-800">
              Transferência {saida ? "para" : "de"} {transfSug.outraConta} · <span className="tabular-nums">{moeda(transfSug.valor)}</span>
            </div>
            <div className="text-xs text-slate-600">
              Registrada em {br(transfSug.data)} na outra conta{transfSug.descricao ? ` · ${transfSug.descricao}` : ""}. Ao conciliar, as duas pontas ficam ligadas.
            </div>
            {podeAgir && (
              <button type="button" className="mt-1 text-xs text-sky-700 hover:underline" onClick={() => setDescartada(true)}>
                Não é esta transferência
              </button>
            )}
          </div>
        ) : receitaSug ? (
          <div className="flex-1 space-y-1 px-3 py-3 text-sm" data-receita-sugerida>
            <div className="font-medium text-slate-800">
              <Link href={`/recebimentos/${receitaSug.receita.id}`} target="_blank" className="hover:underline">
                Receita nº {receitaSug.receita.numero}
              </Link>{" "}
              · {receitaSug.receita.cliente} · <span className="tabular-nums">{moeda(receitaSug.receita.valor)}</span>
            </div>
            <div className="text-xs text-slate-600">
              {receitaSug.receita.descricao} · {receitaSug.receita.obra} · vence em {br(receitaSug.receita.vencimento)}
            </div>
            {receitaSug.liquido && (
              <div className="rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-900">
                Total {moeda(receitaSug.receita.valor)} − imposto retido {moeda(receitaSug.receita.retido)} = {moeda(linha.valor)}. Ao conciliar, a receita fica recebida e o imposto retido, pago.
              </div>
            )}
            {podeAgir && (
              <button type="button" className="mt-1 text-xs text-sky-700 hover:underline" onClick={() => setDescartada(true)}>
                Não é esta receita
              </button>
            )}
          </div>
        ) : aplicSug ? (
          <div className="flex-1 space-y-1 px-3 py-3 text-sm" data-aplicacao-sugerida>
            <div className="font-medium text-slate-800">{saida ? "Aplicação automática (BB Rende Fácil)" : "Resgate automático (BB Rende Fácil)"}</div>
            <div className="text-xs text-slate-600">
              O dinheiro continua na conta, {saida ? "aplicado" : "de volta ao saldo"}: não é despesa nem receita. Ao conciliar, o valor aplicado da conta {saida ? "aumenta" : "diminui"} em {moeda(Math.abs(linha.valor))}.
            </div>
            {podeAgir && (
              <button type="button" className="mt-1 text-xs text-sky-700 hover:underline" onClick={() => setDescartada(true)}>
                Não é aplicação/resgate
              </button>
            )}
          </div>
        ) : estornoSug ? (
          <div className="flex-1 space-y-1 px-3 py-3 text-sm" data-estorno-sugerido>
            <div className="font-medium text-slate-800">
              Estorno de: {estornoSug.descricao} · <span className="tabular-nums">{moeda(estornoSug.valor)}</span> ({br(estornoSug.data)})
            </div>
            <div className="text-xs text-slate-600">
              {estornoSug.conciliadaCom ? (
                <>
                  Essa saída já estava conciliada com <strong>{estornoSug.conciliadaCom}</strong>. Ao conciliar o estorno, o pagamento é desfeito: a conta volta para <strong>em aberto</strong> (o lançamento criado pela conciliação é cancelado) e quem responde pelo centro de custo é avisado.
                </>
              ) : (
                "O dinheiro saiu e voltou: as duas linhas são conciliadas juntas, sem lançamento."
              )}
            </div>
            {podeAgir && (
              <button type="button" className="mt-1 text-xs text-sky-700 hover:underline" onClick={() => setDescartada(true)}>
                Não é este estorno
              </button>
            )}
          </div>
        ) : podeAgir ? (
          <div className="flex flex-1 flex-col">
            {classe && (
              <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                Parece <strong>{ROTULOS[classe]}</strong> — não é uma conta a pagar.
                <button type="button" disabled={pend} className="rounded bg-slate-700 px-2 py-1 font-medium text-white hover:bg-slate-800" onClick={() => iniciar(async () => fim((await arquivar([linha.id], classe)).erro))}>
                  Arquivar como {ROTULOS[classe]}
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
              <div className="flex overflow-hidden rounded border border-sky-300 text-xs font-medium" role="tablist">
                <button type="button" role="tab" aria-selected={aba === "lancamento"} className={`px-2 py-1 ${aba === "lancamento" ? "bg-sky-700 text-white" : "bg-white text-sky-800"}`} onClick={() => setAba("lancamento")}>
                  Novo lançamento
                </button>
                <button type="button" role="tab" aria-selected={aba === "transferencia"} className={`px-2 py-1 ${aba === "transferencia" ? "bg-sky-700 text-white" : "bg-white text-sky-800"}`} onClick={() => setAba("transferencia")}>
                  Nova transferência
                </button>
                {!saida && receitas.length > 0 && (
                  <button type="button" role="tab" aria-selected={aba === "receita"} className={`px-2 py-1 ${aba === "receita" ? "bg-sky-700 text-white" : "bg-white text-sky-800"}`} onClick={() => setAba("receita")}>
                    Receita em aberto
                  </button>
                )}
                {!saida && estornos.length > 0 && (
                  <button type="button" role="tab" aria-selected={aba === "estorno"} className={`px-2 py-1 ${aba === "estorno" ? "bg-sky-700 text-white" : "bg-white text-sky-800"}`} onClick={() => setAba("estorno")}>
                    Estorno
                  </button>
                )}
              </div>
              {saida && (
                <button type="button" className="text-xs font-medium text-sky-700 hover:underline" onClick={() => abrirBusca()}>
                  🔍 Buscar lançamento
                </button>
              )}
            </div>
            {aba === "lancamento" && saida ? (
              <div className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-2" data-novo-lancamento>
                <label className="sm:col-span-2">
                  Descrição *
                  <input value={lanc.descricao} onChange={(e) => setLanc({ ...lanc, descricao: e.target.value })} className="campo mt-0.5 py-1 text-sm" aria-label="Descrição do novo lançamento" />
                </label>
                <div>
                  Categoria *{sugerido("categoria", lanc.categoria) && raio}
                  <NovaCategoria tipo="despesa" aoCriar={(c) => (setNovasCat((x) => ({ ...x, despesa: [...x.despesa, c] })), setLanc((l) => ({ ...l, categoria: c.id })))} />
                  <select value={lanc.categoria} onChange={(e) => setLanc({ ...lanc, categoria: e.target.value })} className="campo mt-0.5 py-1 text-sm" aria-label="Categoria do novo lançamento">
                    <option value="">Escolha…</option>
                    {categorias.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </div>
                <label>
                  Centro de custo *{sugerido("obra", lanc.obra) && raio}
                  <select value={lanc.obra} onChange={(e) => setLanc({ ...lanc, obra: e.target.value })} className="campo mt-0.5 py-1 text-sm" aria-label="Centro de custo do novo lançamento">
                    <option value="">Escolha…</option>
                    {obras.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="sm:col-span-2">
                  Fornecedor{sugerido("fornecedor", lanc.fornecedor) && raio}
                  <select value={lanc.fornecedor} onChange={(e) => setLanc({ ...lanc, fornecedor: e.target.value })} className="campo mt-0.5 py-1 text-sm" aria-label="Fornecedor do novo lançamento">
                    <option value="">— Sem fornecedor —</option>
                    {fornecedores.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-center justify-between gap-2 sm:col-span-2">
                  <span className="text-[11px] text-slate-500">Entra como despesa paga, sem aprovação; quem aprova no centro de custo é avisado.</span>
                  <button type="button" className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => setCompletar(true)}>
                    Completar informações
                  </button>
                </div>
              </div>
            ) : aba === "lancamento" && !saida ? (
              <div className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-2" data-novo-recebimento>
                <label className="sm:col-span-2">
                  Descrição *
                  <input value={rec.descricao} onChange={(e) => setRec({ ...rec, descricao: e.target.value })} className="campo mt-0.5 py-1 text-sm" aria-label="Descrição do recebimento" />
                </label>
                <div>
                  Categoria de receita *{sugestaoRecebimento?.categoriaId && rec.categoria === sugestaoRecebimento.categoriaId && raio}
                  <NovaCategoria tipo="receita" aoCriar={(c) => (setNovasCat((x) => ({ ...x, receita: [...x.receita, c] })), setRec((r) => ({ ...r, categoria: c.id })))} />
                  <select value={rec.categoria} onChange={(e) => setRec({ ...rec, categoria: e.target.value })} className="campo mt-0.5 py-1 text-sm" aria-label="Categoria do recebimento">
                    <option value="">{categoriasReceita.length ? "Escolha…" : "Nenhuma: use “+ Nova”"}</option>
                    {categoriasReceita.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </div>
                <label>
                  Centro de custo *{sugestaoRecebimento?.obraId && rec.obra === sugestaoRecebimento.obraId && raio}
                  <select
                    value={rec.obra}
                    onChange={(e) => {
                      const o = obras.find((x) => x.id === e.target.value);
                      setRec({ ...rec, obra: e.target.value, cliente: rec.cliente.trim() ? rec.cliente : (o?.cliente ?? "") });
                    }}
                    className="campo mt-0.5 py-1 text-sm"
                    aria-label="Centro de custo do recebimento"
                  >
                    <option value="">Escolha…</option>
                    {obras.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="sm:col-span-2">
                  Cliente *{sugestaoRecebimento?.cliente && rec.cliente === sugestaoRecebimento.cliente && raio}
                  <input value={rec.cliente} onChange={(e) => setRec({ ...rec, cliente: e.target.value })} placeholder="Quem pagou (o cliente da obra vem preenchido)" className="campo mt-0.5 py-1 text-sm" aria-label="Cliente do recebimento" />
                </label>
                <span className="text-[11px] text-slate-500 sm:col-span-2">Entra em Contas a receber como recebido, com a data e o valor do banco. A nota de medição pode ser anexada depois, no recebimento.</span>
              </div>
            ) : aba === "receita" && !saida ? (
              <div className="grid gap-2 px-3 py-2 text-xs" data-receita-aberta>
                <span className="text-slate-600">Qual receita de Contas a receber entrou? (valor total, ou total − imposto retido)</span>
                <select value={recSel} onChange={(e) => setRecSel(e.target.value)} className="campo py-1 text-sm" aria-label="Receita em aberto">
                  <option value="">Escolha…</option>
                  {receitas.map((r) => (
                    <option key={r.id} value={r.id}>
                      nº {r.numero} · {r.cliente} · {moeda(r.valor)}
                      {r.retido > 0 ? ` (líquido ${moeda(r.valor - r.retido)})` : ""} · vence {br(r.vencimento)}
                    </option>
                  ))}
                </select>
              </div>
            ) : aba === "estorno" && !saida ? (
              <div className="grid gap-2 px-3 py-2 text-xs" data-estorno>
                <span className="text-slate-600">Qual saída desta conta voltou? (mesmo valor, até 30 dias antes)</span>
                {estornos.map((e) => (
                  <label key={e.id} className="flex items-start gap-2 rounded border border-slate-200 px-2 py-1.5 text-sm">
                    <input type="radio" name={`estorno-${linha.id}`} checked={estSel === e.id} onChange={() => setEstSel(e.id)} className="mt-1" />
                    <span>
                      <strong className="tabular-nums">{br(e.data)}</strong> · {e.descricao} · <span className="tabular-nums">{moeda(e.valor)}</span>
                      <span className="block text-xs text-slate-500">{e.conciliadaCom ? `Conciliada com ${e.conciliadaCom}: a conta volta para em aberto` : "Pendente: as duas linhas são conciliadas juntas"}</span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="grid gap-2 px-3 py-2 text-xs" data-nova-transferencia>
                <label>
                  Descrição *
                  <input value={transf.descricao} onChange={(e) => setTransf({ ...transf, descricao: e.target.value })} className="campo mt-0.5 py-1 text-sm" aria-label="Descrição da transferência" />
                </label>
                <label>
                  {saida ? "Destino *" : "Origem *"}
                  <select value={transf.conta} onChange={(e) => setTransf({ ...transf, conta: e.target.value })} className="campo mt-0.5 py-1 text-sm" aria-label={saida ? "Conta de destino" : "Conta de origem"}>
                    <option value="">Escolha a conta…</option>
                    {contas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nome}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="text-[11px] text-slate-500">Transferência entre contas da empresa: não é despesa. {saida ? "A entrada" : "A saída"} na outra conta aparece sugerida quando o extrato dela for importado.</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center px-3 py-3 text-sm text-slate-500">{classe ? `Parece ${ROTULOS[classe]}.` : "Sem conta a pagar parecida."}</div>
        )}
        <div className="px-3">
          <Mensagem erro={erro} />
        </div>
      </div>
      {semConta && completar && (
        <CompletarLancamento linha={linha} inicial={lanc} aoFechar={() => setCompletar(false)} aoConcluir={() => (setCompletar(false), router.refresh())} />
      )}
      {buscar && <BuscarConta linha={linha} candidatos={candidatos} inicial={inicial} aoFechar={() => (setBuscar(false), setInicial([]))} aoConciliar={() => (setBuscar(false), router.refresh())} />}
    </div>
  );
}

/** "Completar informações" do novo lançamento (a tela de nova despesa do Conta Azul, já preenchida e paga). */
function CompletarLancamento({ linha, inicial, aoFechar, aoConcluir }: { linha: LinhaExtrato; inicial: { descricao: string; categoria: string; obra: string; fornecedor: string }; aoFechar: () => void; aoConcluir: () => void }) {
  const { categorias, obras, fornecedores } = useContext(ContextoListas);
  const [estado, acao, enviando] = useActionState(novoLancamentoCompleto.bind(null, linha.id), null);
  const banco = -linha.valor;
  const [v, setV] = useState({ valor: banco.toLocaleString("pt-BR", { minimumFractionDigits: 2 }), juros: "", multa: "", desconto: "" });
  const num = (x: string) => (x.trim() ? Number(x.replace(/\./g, "").replace(",", ".")) : 0);
  const total = Math.round((num(v.valor) + num(v.juros) + num(v.multa) - num(v.desconto)) * 100) / 100;
  const bate = Math.abs(total - banco) < 0.005;
  useEffect(() => {
    if (estado?.ok && !estado.erro) aoConcluir();
  }, [estado, aoConcluir]);
  return (
    <div role="dialog" aria-label="Completar informações do lançamento" className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4">
      <form action={acao} className="max-h-[92vh] w-full max-w-3xl space-y-4 overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-800">Nova despesa (lançada pela conciliação)</h3>
          <button type="button" onClick={aoFechar} className="text-slate-500" aria-label="Fechar">
            ✕
          </button>
        </div>
        <fieldset className="grid gap-3 rounded-md border border-slate-200 p-3 text-sm sm:grid-cols-4">
          <legend className="px-1 text-xs font-semibold text-slate-600">Informações do lançamento</legend>
          <label className="sm:col-span-2">
            Fornecedor
            <select name="fornecedor_id" defaultValue={inicial.fornecedor} className="campo mt-1">
              <option value="">— Sem fornecedor —</option>
              {fornecedores.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
          <label>
            Data de competência *
            <input type="date" name="data_competencia" required defaultValue={linha.data} className="campo mt-1" />
          </label>
          <label>
            Valor *
            <input name="valor" value={v.valor} onChange={(e) => setV({ ...v, valor: e.target.value })} inputMode="decimal" className="campo mt-1 tabular-nums" aria-label="Valor da despesa" />
          </label>
          <label className="sm:col-span-4">
            Descrição *
            <input name="descricao" required defaultValue={inicial.descricao} maxLength={500} className="campo mt-1" />
          </label>
          <label className="sm:col-span-2">
            Categoria *
            <select name="categoria_id" required defaultValue={inicial.categoria} className="campo mt-1">
              <option value="">Escolha…</option>
              {categorias.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="sm:col-span-2">
            Centro de custo *
            <select name="obra_id" required defaultValue={inicial.obra} className="campo mt-1">
              <option value="">Escolha…</option>
              {obras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset className="grid gap-3 rounded-md border border-slate-200 p-3 text-sm sm:grid-cols-4">
          <legend className="px-1 text-xs font-semibold text-slate-600">Condição e informações do pagamento</legend>
          <label>
            Forma de pagamento
            <select name="forma_pagamento" defaultValue="" className="campo mt-1">
              <option value="">—</option>
              <option value="pix">PIX</option>
              <option value="boleto">Boleto</option>
              <option value="transferencia">Transferência bancária</option>
              <option value="dinheiro">Dinheiro</option>
              <option value="cartao">Cartão</option>
              <option value="cheque">Cheque</option>
              <option value="outro">Outro</option>
            </select>
          </label>
          <div>
            Data do pagamento
            <div className="campo mt-1 bg-slate-50">{br(linha.data)}</div>
          </div>
          <div className="sm:col-span-2">
            Valor pago (saiu do banco) · <span className="text-emerald-700">✓ Pago</span>
            <div className="campo mt-1 bg-slate-50 tabular-nums">{moeda(banco)}</div>
          </div>
          {(["juros", "multa", "desconto"] as const).map((k) => (
            <label key={k}>
              {k === "juros" ? "Juros" : k === "multa" ? "Multa" : "Desconto"}
              <input name={k} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} inputMode="decimal" placeholder="0,00" className="campo mt-1 tabular-nums" aria-label={k} />
            </label>
          ))}
          <div className={`text-right text-sm ${bate ? "text-slate-700" : "text-red-600"}`} data-total-lancamento>
            Total: <strong className="tabular-nums">{moeda(total)}</strong>
            {!bate && <div className="text-xs">precisa dar {moeda(banco)}</div>}
          </div>
        </fieldset>
        <label className="block text-sm">
          Observações
          <textarea name="observacoes" rows={2} className="campo mt-1" />
        </label>
        <label className="block text-sm">
          Anexos (comprovante, nota, recibo)
          <input type="file" name="anexos" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.xml" className="campo mt-1" />
        </label>
        <p className="text-xs text-slate-500">
          Entra como despesa paga e conciliada com este lançamento do banco, sem fluxo de aprovação (o valor já saiu da conta). O engenheiro e o administrador do centro de custo recebem um aviso.
        </p>
        {estado?.erro && <Mensagem erro={estado.erro} />}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${botao} border border-slate-300`} onClick={aoFechar}>
            Voltar
          </button>
          <button type="submit" disabled={enviando || !bate} className={`${botao} bg-sky-700 text-white hover:bg-sky-800`}>
            {enviando ? "Salvando…" : "Salvar e conciliar"}
          </button>
        </div>
      </form>
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

export function Desfazer({ linhaId, algumaBaixou, lancado = false, transferencia = false, estorno = false, recebimento = false, aplicacao = false }: { linhaId: string; algumaBaixou: boolean; lancado?: boolean; transferencia?: boolean; estorno?: boolean; recebimento?: boolean; aplicacao?: boolean }) {
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
              {aplicacao ? (
                <p className="text-slate-700">A aplicação/resgate automático volta para as pendentes e sai do valor aplicado da conta.</p>
              ) : recebimento ? (
                <>
                  <label className="flex items-start gap-2">
                    <input type="radio" name="voltar" checked={!voltar} onChange={() => setVoltar(false)} /> <span>Apenas desfazer: o recebimento continua lançado</span>
                  </label>
                  <label className="flex items-start gap-2">
                    <input type="radio" name="voltar" checked={voltar} onChange={() => setVoltar(true)} /> <span>Desfazer e cancelar o recebimento</span>
                  </label>
                </>
              ) : estorno ? (
                <p className="text-slate-700">O estorno é separado da saída: as duas linhas voltam para as pendentes. A conta que foi reaberta pelo estorno continua em aberto.</p>
              ) : transferencia ? (
                <p className="text-slate-700">A transferência é solta desta movimentação{" "}(se a outra ponta também não estiver conciliada, a transferência é apagada).</p>
              ) : (
              <label className="flex items-start gap-2">
                <input type="radio" name="voltar" checked={!voltar} onChange={() => setVoltar(false)} /> <span>Apenas desfazer — as contas continuam pagas</span>
              </label>
              )}
              {lancado && !transferencia && !estorno && (
                <label className="flex items-start gap-2">
                  <input type="radio" name="voltar" checked={voltar} onChange={() => setVoltar(true)} /> <span>Desfazer e cancelar o lançamento criado pela conciliação</span>
                </label>
              )}
              {algumaBaixou && !transferencia && !estorno && (
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
  const [sel, setSel] = useState({ total: 0, conc: 0, classe: 0, aplic: 0 });
  const [menu, setMenu] = useState<"" | "selecionar" | "ordenar">("");
  const [pend, iniciar] = useTransition();
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const caixas = () => Array.from(document.querySelectorAll<HTMLInputElement>("input.sel-linha"));
  useEffect(() => {
    const contar = () => {
      const m = caixas().filter((c) => c.checked);
      setSel({ total: m.length, conc: m.filter((c) => c.dataset.conc).length, classe: m.filter((c) => c.dataset.classe).length, aplic: m.filter((c) => c.dataset.aplic).length });
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
            <button role="menuitem" type="button" className={item} onClick={() => marcar((c) => Boolean(c.dataset.aplic))}>Aplicações e resgates automáticos (Rende Fácil)</button>
            <button role="menuitem" type="button" className={`${item} border-t border-slate-100`} onClick={() => marcar(() => false)}>Nenhum</button>
          </div>
        )}
      </div>
      <button
        type="button"
        disabled={!(sel.conc + sel.aplic) || pend}
        title={sel.total && !(sel.conc + sel.aplic) ? "Nenhuma das marcadas tem sugestão com valor igual" : undefined}
        className={`${botao} bg-emerald-600 text-white hover:bg-emerald-700`}
        onClick={() =>
          iniciar(async () => {
            let ok = 0;
            const erros: string[] = [];
            const aplic = marcadas().filter((x) => x.dataset.aplic).map((x) => x.dataset.linha!);
            if (aplic.length) {
              const r = await conciliarAplicacao(aplic);
              if (r.erro) erros.push(r.erro);
              else ok += r.n ?? 0;
            }
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
        {pend ? "Aguarde…" : `Conciliar${sel.conc + sel.aplic ? ` (${sel.conc + sel.aplic})` : ""}`}
      </button>
      <IgnorarMarcadas habilitado={sel.total > 0} aoTerminar={(r) => (setMsg(r), router.refresh())} />
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

/** "Arquivar ▾" da barra: arquiva as marcadas com o tipo escolhido (só para o que não é dinheiro de verdade). */
function IgnorarMarcadas({ habilitado, aoTerminar }: { habilitado: boolean; aoTerminar: (r: { tipo: "ok" | "erro"; texto: string }) => void }) {
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
<div className="px-4 py-1 text-xs text-slate-500">Arquivar as marcadas como (não é dinheiro de verdade, ex.: lançamento duplicado do banco):</div>
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
