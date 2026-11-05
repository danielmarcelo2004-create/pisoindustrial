"use client";

import { useState } from "react";
import { BotaoEnviar, FormAcao } from "@/components/form-acao";
import { Botao, Campo, Cartao } from "@/components/ui";
import type { Estado } from "@/lib/erros";

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
  itens?: ItemPadrao[];
};

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
}: {
  action: (e: Estado, fd: FormData) => Promise<Estado>;
  obras: { id: string; nome: string; cidade: string; uf: string; temAdministrador: boolean }[];
  padrao?: Padrao;
  podeAssinar?: boolean;
  assinarPadrao?: boolean;
}) {
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

  const totais = itens.map((i) => Math.round(num(i.quantidade) * num(i.valor_unitario) * 100) / 100);
  const subtotal = totais.reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);
  const total = subtotal;
  const obraSel = obras.find((o) => o.id === obra);

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
          <Campo rotulo="Vencimento" obrigatorio ajuda="Obrigatório para enviar.">
            <input type="date" name="vencimento" defaultValue={padrao.vencimento ?? ""} className="campo" />
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
          <Campo rotulo="Condição de pagamento (pix ou boleto)">
            <select name="forma_pagamento" defaultValue={padrao.forma_pagamento ?? "pix"} className="campo">
              <option value="pix">PIX</option>
              <option value="boleto">Boleto</option>
            </select>
          </Campo>
          <Campo rotulo="Nº da Nota Fiscal" ajuda="Opcional. Se vazio, o sistema usa o número da OP.">
            <input name="numero_nf" defaultValue={padrao.numero_nf ?? ""} className="campo" maxLength={60} />
          </Campo>
          <Campo rotulo="Dados para pagamento" ajuda="Chave PIX, banco, agência e conta. Uma informação por linha no PDF.">
            <textarea name="dados_bancarios" rows={2} defaultValue={padrao.dados_bancarios ?? ""} className="campo" maxLength={300} />
          </Campo>
          <Campo rotulo="Observações internas" ajuda="Não aparecem no PDF.">
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
