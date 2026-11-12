"use client";

import { useRef, useState } from "react";
import { BotaoEnviar, FormAcao } from "@/components/form-acao";
import { Aviso, Botao, Campo, Cartao } from "@/components/ui";
import type { Estado } from "@/lib/erros";
import { FORMAS_PAGAMENTO, FORMAS_PAGAMENTO_ATUAIS, type FormaPagamento } from "@/lib/rotulos";
import { criarClienteNavegador } from "@/lib/supabase/navegador";
import { salvarRascunhoAjax } from "./actions";
import { AnexosOP, type AnexoOP } from "./anexos-op";
import { AssinarOP } from "./assinar-op";

type Item = { descricao: string; unidade: string; quantidade: string; valor_unitario: string };
type ItemPadrao = {
  descricao: string;
  unidade: string | null;
  quantidade: number | string;
  valor_unitario: number | string;
};
type Padrao = {
  obra_id?: string;
  favorecido?: string;
  cpf_cnpj?: string | null;
  descricao?: string;
  vencimento?: string | null;
  forma_pagamento?: string;
  dados_bancarios?: string | null;
  observacoes?: string | null;
  numero_nf?: string | null;
  desconto?: number | string | null;
  parcelas?: number;
  parcelasValores?: { vencimento: string; valor: number }[];
  itens?: ItemPadrao[];
};

type Parcela = { vencimento: string; valor: string };

/** Lê banco, agência e conta de um texto gravado no formato "BANCO: x / AGÊNCIA: y / CONTA: z". */
function lerDadosTransferencia(texto: string | null | undefined) {
  const linhas = (texto ?? "").split(/\r?\n/);
  const pega = (re: RegExp) => linhas.map((l) => l.match(re)?.[1]?.trim()).find(Boolean) ?? "";
  return { banco: pega(/^BANCO:\s*(.*)$/i), agencia: pega(/^AG[ÊE]NCIA:\s*(.*)$/i), conta: pega(/^CONTA:\s*(.*)$/i) };
}

/** Soma meses a uma data ISO, mantendo o último dia do mês quando o dia não existe (31/01 + 1 = 28/02). */
function somarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  const dia = Math.min(d, ultimo);
  return `${alvo.getUTCFullYear()}-${String(alvo.getUTCMonth() + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** Gera N parcelas: valores iguais (centavos sobram na última) e vencimentos mensais a partir do primeiro. */
function gerarParcelas(n: number, primeiro: string, total: number): Parcela[] {
  if (n < 2) return [];
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const ultima = cents - base * (n - 1);
  return Array.from({ length: n }, (_, i) => ({
    vencimento: primeiro ? somarMeses(primeiro, i) : "",
    valor: ((i === n - 1 ? ultima : base) / 100).toFixed(2).replace(".", ","),
  }));
}

/** "1.234,56" ou "1234.56" → número (NaN se vazio/inválido) */
function num(s: string): number {
  const t = s.trim();
  if (!t) return NaN;
  return t.includes(",") ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t);
}
const moeda = (v: number) => (Number.isFinite(v) ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—");
const paraCampo = (v: number | string, casas: number) =>
  Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: casas, useGrouping: false });
const itemVazio = (): Item => ({ descricao: "", unidade: "", quantidade: "1", valor_unitario: "" });

export function FormOP({
  action,
  obras,
  padrao = {},
  podeAssinar = false,
  assinarPadrao = false,
  ordemId: ordemIdInicial = null,
  anexosIniciais = [],
  assinaturaUrl = null,
  ehEngenheiro = false,
  assinaturaCriador = null,
}: {
  action: (e: Estado, fd: FormData) => Promise<Estado>;
  obras: { id: string; nome: string; cidade: string; uf: string; temAdministrador: boolean }[];
  padrao?: Padrao;
  podeAssinar?: boolean;
  assinarPadrao?: boolean;
  ordemId?: string | null;
  anexosIniciais?: AnexoOP[];
  assinaturaUrl?: string | null;
  ehEngenheiro?: boolean;
  assinaturaCriador?: { pos: { fx: number; fy: number; fw: number }; atual: boolean } | null;
}) {
  // Rascunho: na criação ele nasce ao clicar em "Salvar rascunho para anexar", sem sair da tela.
  const [ordemId, setOrdemId] = useState<string | null>(ordemIdInicial);
  const [obraSalva, setObraSalva] = useState(padrao.obra_id ?? "");
  const [anexos, setAnexos] = useState<AnexoOP[]>(anexosIniciais);
  const [erroRascunho, setErroRascunho] = useState("");
  const [salvandoRascunho, setSalvandoRascunho] = useState(false);
  const botaoRef = useRef<HTMLButtonElement>(null);
  // Estado da assinatura do engenheiro: atualizado na hora ao assinar (sem esperar recarregar a página).
  const [assinaturaLocal, setAssinaturaLocal] = useState(assinaturaCriador);

  async function salvarParaAnexar() {
    setErroRascunho("");
    setSalvandoRascunho(true);
    try {
      const formulario = botaoRef.current?.closest("form") ?? undefined;
      const r = await salvarRascunhoAjax(new FormData(formulario));
      if (r.erro || !r.id) {
        setErroRascunho(r.erro ?? "Não foi possível salvar o rascunho.");
        return;
      }
      setOrdemId(r.id);
      setObraSalva(obra);
    } catch {
      setErroRascunho("Não foi possível salvar o rascunho. Tente de novo.");
    } finally {
      setSalvandoRascunho(false);
    }
  }

  async function recarregarAnexos() {
    if (!ordemId) return;
    const { data } = await criarClienteNavegador()
      .from("ordem_anexos")
      .select("id, storage_path, nome_arquivo, mime_type, assinado")
      .eq("ordem_id", ordemId)
      .order("created_at");
    setAnexos((data ?? []) as AnexoOP[]);
  }

  const [itens, setItens] = useState<Item[]>(
    padrao.itens?.length
      ? padrao.itens.map((i) => ({
          descricao: i.descricao,
          unidade: i.unidade ?? "",
          quantidade: paraCampo(i.quantidade, 3),
          valor_unitario: paraCampo(i.valor_unitario, 2),
        }))
      : [itemVazio()],
  );
  const [obra, setObra] = useState(padrao.obra_id ?? "");
  const [forma, setForma] = useState<FormaPagamento>(
    FORMAS_PAGAMENTO_ATUAIS.includes(padrao.forma_pagamento as FormaPagamento) ? (padrao.forma_pagamento as FormaPagamento) : "pix",
  );
  const bancoPadrao = lerDadosTransferencia(padrao.dados_bancarios);
  const [desconto, setDesconto] = useState(padrao.desconto ? paraCampo(padrao.desconto, 2) : "");
  const [venc1, setVenc1] = useState(padrao.vencimento ?? "");
  const [qtdParc, setQtdParc] = useState(String(padrao.parcelas ?? 1));
  const [parcelas, setParcelas] = useState<Parcela[]>(() =>
    padrao.parcelasValores?.length && (padrao.parcelas ?? 1) > 1
      ? padrao.parcelasValores.map((p) => ({ vencimento: p.vencimento, valor: paraCampo(p.valor, 2) }))
      : [],
  );

  const totais = itens.map((i) => Math.round(num(i.quantidade) * num(i.valor_unitario) * 100) / 100);
  const subtotal = totais.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  // Desconto opcional: abate do subtotal. Não pode ser negativo nem maior que o subtotal.
  const descontoNum = desconto.trim() ? num(desconto) : 0;
  const descontoValido = Number.isFinite(descontoNum) && descontoNum >= 0 && descontoNum <= subtotal;
  const total = subtotal - (descontoValido ? descontoNum : 0);
  const obraSel = obras.find((o) => o.id === obra);

  const nParc = Math.min(Math.max(Math.floor(Number(qtdParc) || 1), 1), 60);
  const parcelasAtivas = nParc > 1;
  // A tabela de parcelas sempre acompanha a quantidade e o primeiro vencimento; a primeira linha espelha o vencimento da OP.
  const parcelasExibidas: Parcela[] = parcelasAtivas
    ? parcelas.length === nParc
      ? parcelas.map((p, i) => (i === 0 ? { ...p, vencimento: venc1 } : p))
      : gerarParcelas(nParc, venc1, total)
    : [];
  const somaParcelas = parcelasExibidas.reduce((s, p) => s + num(p.valor), 0);
  const parcelasBatem = !parcelasAtivas || Math.abs(somaParcelas - total) < 0.005;
  const parcelasJson = JSON.stringify(
    parcelasAtivas ? parcelasExibidas.map((p) => ({ vencimento: p.vencimento, valor: num(p.valor) })) : [],
  );

  const mudarQuantidade = (v: string) => {
    setQtdParc(v);
    const n = Math.min(Math.max(Math.floor(Number(v) || 1), 1), 60);
    setParcelas(n > 1 ? gerarParcelas(n, venc1, total) : []);
  };
  const mudarVencimento = (v: string) => {
    setVenc1(v);
    if (parcelasAtivas) setParcelas(gerarParcelas(nParc, v, total));
  };
  const mudarParcela = (i: number, campo: keyof Parcela, v: string) =>
    setParcelas(parcelasExibidas.map((p, j) => (j === i ? { ...p, [campo]: v } : p)));

  const alterar = (i: number, campo: keyof Item, v: string) =>
    setItens((xs) => xs.map((x, j) => (j === i ? { ...x, [campo]: v } : x)));

  const itensJson = JSON.stringify(
    itens.map((i) => ({
      descricao: i.descricao,
      unidade: i.unidade,
      quantidade: num(i.quantidade),
      valor_unitario: num(i.valor_unitario),
    })),
  );

  return (
    <FormAcao action={action} semBotao className="space-y-6">
      <input type="hidden" name="itens" value={itensJson} />
      <Cartao titulo="Dados da solicitação">
        <div className="grid gap-4 sm:grid-cols-2">
          <Campo
            rotulo="Centro de custo"
            obrigatorio
            ajuda={
              obraSel &&
              (obraSel.temAdministrador
                ? "A OP seguirá direto para o administrador desta obra."
                : "Esta obra não tem administrador: a OP seguirá direto ao Financeiro.")
            }
          >
            <select name="obra_id" required className="campo" value={obra} onChange={(e) => setObra(e.target.value)}>
              <option value="">Selecione…</option>
              {obras.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.nome} — {o.cidade}/{o.uf}
                </option>
              ))}
            </select>
          </Campo>
          <Campo rotulo="Vencimento" obrigatorio ajuda={parcelasAtivas ? "Vencimento da 1ª parcela. As demais podem ser ajustadas na tabela abaixo." : "Obrigatório para enviar."}>
            <input type="date" name="vencimento" value={venc1} onChange={(e) => mudarVencimento(e.target.value)} className="campo" />
          </Campo>
          <Campo rotulo="Quantidade de parcelas" ajuda="Use 1 para pagamento único. Você pode ajustar vencimento e valor de cada parcela.">
            <input type="number" name="parcelas" min={1} max={60} value={qtdParc} onChange={(e) => mudarQuantidade(e.target.value)} required className="campo" />
          </Campo>
          <Campo rotulo="Favorecido (fornecedor)" obrigatorio>
            <input name="favorecido" required defaultValue={padrao.favorecido ?? ""} className="campo" maxLength={200} />
          </Campo>
          <Campo rotulo="CPF / CNPJ do favorecido">
            <input name="cpf_cnpj" defaultValue={padrao.cpf_cnpj ?? ""} inputMode="numeric" className="campo" maxLength={18} />
          </Campo>
          <Campo rotulo="Observação (motivo)" obrigatorio className="sm:col-span-2" ajuda="Aparece no campo OBSERVAÇÃO do PDF.">
            <input name="descricao" required defaultValue={padrao.descricao ?? ""} className="campo" maxLength={500} placeholder="Ex.: Adiantamento de salário" />
          </Campo>
          <Campo rotulo="Forma de pagamento">
            <select name="forma_pagamento" value={forma} onChange={(e) => setForma(e.target.value as FormaPagamento)} className="campo">
              {FORMAS_PAGAMENTO_ATUAIS.map((v) => (
                <option key={v} value={v}>
                  {FORMAS_PAGAMENTO[v]}
                </option>
              ))}
            </select>
          </Campo>
          <Campo rotulo="Nº da Nota Fiscal" ajuda="Opcional. Se vazio, o sistema usa o número da OP.">
            <input name="numero_nf" defaultValue={padrao.numero_nf ?? ""} className="campo" maxLength={60} />
          </Campo>
          {forma === "transferencia" ? (
            <>
              <Campo rotulo="Banco" obrigatorio ajuda="Obrigatório para gerar a OP.">
                <input name="banco" defaultValue={bancoPadrao.banco} className="campo" maxLength={80} />
              </Campo>
              <Campo rotulo="Agência" obrigatorio ajuda="Obrigatório para gerar a OP.">
                <input name="agencia" defaultValue={bancoPadrao.agencia} className="campo" maxLength={20} />
              </Campo>
              <Campo rotulo="Conta" obrigatorio ajuda="Número da conta com o dígito. Obrigatório para gerar a OP.">
                <input name="conta" defaultValue={bancoPadrao.conta} className="campo" maxLength={30} />
              </Campo>
            </>
          ) : (
            <Campo rotulo="Banco e chave PIX" obrigatorio ajuda="Primeira linha: instituição bancária (aparece como BANCO no PDF). Demais linhas: chave PIX. Obrigatório para gerar a OP.">
              <textarea name="dados_bancarios" rows={2} defaultValue={padrao.dados_bancarios ?? ""} className="campo" maxLength={300} />
            </Campo>
          )}
          <Campo rotulo="Observação" ajuda="Opcional. Aparece no PDF, abaixo do favorecido.">
            <textarea name="observacoes" rows={2} defaultValue={padrao.observacoes ?? ""} className="campo" maxLength={2000} />
          </Campo>
        </div>
      </Cartao>

      {podeAssinar && (
        <Cartao titulo="Assinatura do cadastro">
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" name="assinar" defaultChecked={assinarPadrao} className="mt-0.5" />
            <span>Assinar como quem solicitou. É só uma marca na OP, não é etapa de aprovação.</span>
          </label>
        </Cartao>
      )}
      <Cartao titulo="Itens" semPadding>
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th className="min-w-56">Nome do produto / serviço / material</th>
                <th className="w-24">Unidade</th>
                <th className="w-24">Quantidade</th>
                <th className="w-32">Valor unit. (R$)</th>
                <th className="w-32 text-right">Total</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {itens.map((it, i) => (
                <tr key={i}>
                  <td className="pt-4 text-slate-500">{i + 1}</td>
                  <td>
                    <input aria-label={`Descrição do item ${i + 1}`} value={it.descricao} onChange={(e) => alterar(i, "descricao", e.target.value)} className="campo" required />
                  </td>
                  <td>
                    <input aria-label={`Unidade do item ${i + 1}`} value={it.unidade} onChange={(e) => alterar(i, "unidade", e.target.value)} className="campo" placeholder="UNID., m², dia" />
                  </td>
                  <td>
                    <input aria-label={`Quantidade do item ${i + 1}`} value={it.quantidade} onChange={(e) => alterar(i, "quantidade", e.target.value)} className="campo tabular-nums" inputMode="decimal" required />
                  </td>
                  <td>
                    <input aria-label={`Valor unitário do item ${i + 1}`} value={it.valor_unitario} onChange={(e) => alterar(i, "valor_unitario", e.target.value)} className="campo tabular-nums" inputMode="decimal" placeholder="0,00" required />
                  </td>
                  <td className="pt-4 text-right font-medium tabular-nums">{moeda(totais[i])}</td>
                  <td className="pt-3">
                    {itens.length > 1 && (
                      <button type="button" onClick={() => setItens((xs) => xs.filter((_, j) => j !== i))} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label={`Remover item ${i + 1}`}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="px-3 py-3">
                  <Botao type="button" variante="secundario" tamanho="sm" onClick={() => setItens((xs) => [...xs, itemVazio()])}>
                    + Adicionar item
                  </Botao>
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  <div className="text-xs text-slate-500">Subtotal</div>
                  {moeda(subtotal)}
                </td>
                <td />
              </tr>
              <tr>
                <td colSpan={5} className="px-3 py-2 text-right text-sm text-slate-600">
                  Desconto (R$) <span className="text-xs text-slate-400">opcional</span>
                </td>
                <td className="px-3 py-2 text-right">
                  <input
                    name="desconto"
                    inputMode="decimal"
                    placeholder="0,00"
                    value={desconto}
                    onChange={(e) => setDesconto(e.target.value)}
                    aria-label="Desconto"
                    className="campo w-32 text-right tabular-nums"
                  />
                  {!descontoValido && (
                    <div className="mt-1 text-xs text-red-600">O desconto deve estar entre zero e o total dos itens.</div>
                  )}
                </td>
                <td />
              </tr>
              <tr>
                <td colSpan={5} className="px-3 py-3 text-right font-semibold">
                  Total da OP
                </td>
                <td className="px-3 py-3 text-right text-base font-semibold tabular-nums">{moeda(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Cartao>

      <input type="hidden" name="parcelas_json" value={parcelasJson} />
      <input type="hidden" name="ordem_id" value={ordemId ?? ""} />
      {ehEngenheiro && (
        <Cartao titulo="Assinatura do engenheiro">
          {ordemId ? (
            <AssinarOP
              ordemId={ordemId}
              assinaturaUrl={assinaturaUrl}
              posSalva={assinaturaLocal?.pos ?? null}
              assinada={!!assinaturaLocal?.atual}
              desatualizada={!!assinaturaLocal && !assinaturaLocal.atual}
              onAssinada={(pos) => setAssinaturaLocal({ pos, atual: true })}
            />
          ) : (
            <p className="text-sm text-slate-600">Salve o rascunho para assinar a OP. A assinatura entra no PDF quando a solicitação for enviada.</p>
          )}
        </Cartao>
      )}
      <Cartao titulo="Comprovantes, recibos e notas">
        {ordemId ? (
          <AnexosOP
            ordemId={ordemId}
            obraId={obraSalva}
            anexos={anexos}
            podeAssinar={ehEngenheiro}
            assinaturaUrl={assinaturaUrl}
            onMudou={recarregarAnexos}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Salve o rascunho para anexar comprovantes, recibos ou notas aqui mesmo. Engenheiro e administrador assinam cada arquivo antes de anexar.
            </p>
            {erroRascunho && <Aviso tipo="erro">{erroRascunho}</Aviso>}
            <Botao ref={botaoRef} type="button" variante="secundario" onClick={salvarParaAnexar} disabled={salvandoRascunho}>
              {salvandoRascunho ? "Salvando rascunho…" : "Salvar rascunho para anexar"}
            </Botao>
          </div>
        )}
      </Cartao>
      {parcelasAtivas && (
        <Cartao titulo={`Parcelas (${nParc})`} semPadding>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="px-4 py-2">Nº</th>
                <th className="px-4 py-2">Vencimento</th>
                <th className="px-4 py-2 text-right">Valor (R$)</th>
              </tr>
            </thead>
            <tbody>
              {parcelasExibidas.map((p, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="px-4 py-2 tabular-nums">{i + 1}</td>
                  <td className="px-4 py-2">
                    {i === 0 ? (
                      <span className="tabular-nums">{venc1 ? venc1.split("-").reverse().join("/") : "—"}</span>
                    ) : (
                      <input type="date" value={p.vencimento} onChange={(e) => mudarParcela(i, "vencimento", e.target.value)} className="campo" aria-label={`Vencimento da parcela ${i + 1}`} />
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <input inputMode="decimal" value={p.valor} onChange={(e) => mudarParcela(i, "valor", e.target.value)} className="campo w-32 text-right tabular-nums" aria-label={`Valor da parcela ${i + 1}`} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2} className="px-4 py-3 text-right text-sm text-slate-600">
                  Soma das parcelas: <span className="tabular-nums font-semibold">{moeda(somaParcelas)}</span> de {moeda(total)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Botao type="button" variante="secundario" tamanho="sm" onClick={() => setParcelas(gerarParcelas(nParc, venc1, total))}>
                    Dividir igualmente
                  </Botao>
                </td>
              </tr>
              {!parcelasBatem && (
                <tr>
                  <td colSpan={3} className="px-4 pb-3 text-xs text-red-600">
                    A soma das parcelas precisa ser igual ao total da OP ({moeda(total)}). Ajuste os valores ou use &quot;Dividir igualmente&quot;.
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </Cartao>
      )}

      <div className="flex flex-wrap gap-2">
        <BotaoEnviar name="acao" value="salvar" variante="secundario">
          Salvar rascunho
        </BotaoEnviar>
        <BotaoEnviar name="acao" value="enviar" pendente="Enviando…">
          Salvar e enviar
        </BotaoEnviar>
      </div>
    </FormAcao>
  );
}
