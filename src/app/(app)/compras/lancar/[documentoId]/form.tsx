"use client";

import { useState } from "react";
import { FormAcao } from "@/components/form-acao";
import { Botao, Campo, Cartao } from "@/components/ui";
import type { Estado } from "@/lib/erros";
import { UFS } from "@/lib/rotulos";

type Item = { descricao: string; unidade: string; quantidade: string; valor_unitario: string };
const num = (s: string) => (s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s));
const moeda = (v: number) => (Number.isFinite(v) ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—");

export function FormLancarNF({
  action,
  padrao,
}: {
  action: (e: Estado, fd: FormData) => Promise<Estado>;
  padrao: { emitente_nome: string; emitente_cnpj: string; emitente_uf: string; numero: string };
}) {
  const [itens, setItens] = useState<Item[]>([{ descricao: "", unidade: "", quantidade: "", valor_unitario: "" }]);
  const alt = (i: number, k: keyof Item, v: string) => setItens((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const total = itens.reduce((s, i) => s + (num(i.quantidade) * num(i.valor_unitario) || 0), 0);
  return (
    <FormAcao action={action} enviar="Registrar itens" className="space-y-6">
      <input type="hidden" name="itens" value={JSON.stringify(itens)} />
      <Cartao titulo="Dados da nota">
        <div className="grid gap-4 sm:grid-cols-4">
          <Campo rotulo="Fornecedor (emitente)" obrigatorio className="sm:col-span-2">
            <input name="emitente_nome" required defaultValue={padrao.emitente_nome} className="campo" />
          </Campo>
          <Campo rotulo="CNPJ do emitente">
            <input name="emitente_cnpj" defaultValue={padrao.emitente_cnpj} className="campo" />
          </Campo>
          <Campo rotulo="UF do emitente">
            <select name="emitente_uf" defaultValue={padrao.emitente_uf} className="campo">
              <option value="">—</option>
              {UFS.map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </Campo>
          <Campo rotulo="Nº da NF">
            <input name="numero" defaultValue={padrao.numero} className="campo" />
          </Campo>
          <Campo rotulo="Data de emissão" obrigatorio>
            <input type="date" name="data_emissao" required className="campo" />
          </Campo>
          <Campo rotulo="Frete (R$)">
            <input name="valor_frete" inputMode="decimal" className="campo" placeholder="0,00" />
          </Campo>
          <Campo rotulo="Chave de acesso (44 dígitos)" ajuda="Evita lançar a mesma nota duas vezes.">
            <input name="chave" inputMode="numeric" className="campo" maxLength={60} />
          </Campo>
        </div>
      </Cartao>
      <Cartao titulo="Itens da nota" semPadding>
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>#</th>
                <th className="min-w-56">Descrição (como na nota)</th>
                <th className="w-24">Unidade</th>
                <th className="w-28">Quantidade</th>
                <th className="w-36">Preço unit. (R$)</th>
                <th className="w-32 text-right">Total</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {itens.map((it, i) => (
                <tr key={i}>
                  <td className="pt-4 text-slate-500">{i + 1}</td>
                  <td><input aria-label={`Descrição ${i + 1}`} value={it.descricao} onChange={(e) => alt(i, "descricao", e.target.value)} className="campo" required /></td>
                  <td><input aria-label={`Unidade ${i + 1}`} value={it.unidade} onChange={(e) => alt(i, "unidade", e.target.value)} className="campo" placeholder="UN, M3, KG" /></td>
                  <td><input aria-label={`Quantidade ${i + 1}`} value={it.quantidade} onChange={(e) => alt(i, "quantidade", e.target.value)} className="campo tabular-nums" inputMode="decimal" required /></td>
                  <td><input aria-label={`Preço ${i + 1}`} value={it.valor_unitario} onChange={(e) => alt(i, "valor_unitario", e.target.value)} className="campo tabular-nums" inputMode="decimal" required /></td>
                  <td className="pt-4 text-right tabular-nums">{moeda(num(it.quantidade) * num(it.valor_unitario))}</td>
                  <td className="pt-3">
                    {itens.length > 1 && (
                      <button type="button" aria-label={`Remover ${i + 1}`} className="rounded p-1 text-slate-400 hover:text-red-600" onClick={() => setItens((xs) => xs.filter((_, j) => j !== i))}>
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
                  <Botao type="button" variante="secundario" tamanho="sm" onClick={() => setItens((xs) => [...xs, { descricao: "", unidade: "", quantidade: "", valor_unitario: "" }])}>
                    + Adicionar item
                  </Botao>
                </td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums">{moeda(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Cartao>
    </FormAcao>
  );
}
