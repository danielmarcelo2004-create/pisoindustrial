import { Campo } from "@/components/ui";
import { valorParaCampo } from "@/lib/formato";
import { FORMAS_PAGAMENTO } from "@/lib/rotulos";

type Padrao = {
  fornecedor_id?: string | null;
  favorecido?: string | null;
  descricao?: string | null;
  valor?: number | string | null;
  vencimento?: string | null;
  forma_pagamento?: string | null;
  numero_documento?: string | null;
  observacoes?: string | null;
};

export function CamposPagamento({
  fornecedores,
  padrao = {},
}: {
  fornecedores: { id: string; nome: string; cpf_cnpj: string | null }[];
  padrao?: Padrao;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Campo rotulo="Fornecedor" ajuda="Não está na lista? Cadastre em Fornecedores ou informe só o favorecido.">
        <select name="fornecedor_id" defaultValue={padrao.fornecedor_id ?? ""} className="campo">
          <option value="">— Sem fornecedor cadastrado —</option>
          {fornecedores.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nome}
            </option>
          ))}
        </select>
      </Campo>
      <Campo rotulo="Favorecido" ajuda="Preenchido automaticamente com o fornecedor, se deixado em branco.">
        <input name="favorecido" defaultValue={padrao.favorecido ?? ""} className="campo" maxLength={200} />
      </Campo>
      <Campo rotulo="Descrição" obrigatorio className="sm:col-span-2">
        <input name="descricao" required defaultValue={padrao.descricao ?? ""} className="campo" maxLength={500} placeholder="Ex.: Concreto usinado FCK 30 — 12 m³" />
      </Campo>
      <Campo rotulo="Valor (R$)" obrigatorio>
        <input
          name="valor"
          required
          inputMode="decimal"
          defaultValue={valorParaCampo(padrao.valor)}
          className="campo tabular-nums"
          placeholder="0,00"
          pattern="^\s*(R\$)?\s*[0-9.]*[0-9](,[0-9]{1,2})?\s*$|^[0-9]+(\.[0-9]{1,2})?$"
          title="Use o formato 1.234,56"
        />
      </Campo>
      <Campo rotulo="Vencimento" obrigatorio>
        <input name="vencimento" type="date" required defaultValue={padrao.vencimento ?? ""} className="campo" />
      </Campo>
      <Campo rotulo="Forma de pagamento" obrigatorio>
        <select name="forma_pagamento" defaultValue={padrao.forma_pagamento ?? "boleto"} className="campo">
          {Object.entries(FORMAS_PAGAMENTO).map(([v, r]) => (
            <option key={v} value={v}>
              {r}
            </option>
          ))}
        </select>
      </Campo>
      <Campo rotulo="Nº do documento / NF">
        <input name="numero_documento" defaultValue={padrao.numero_documento ?? ""} className="campo" maxLength={100} />
      </Campo>
      <Campo rotulo="Observações" className="sm:col-span-2" ajuda="Observações não fazem parte do conteúdo assinado.">
        <textarea name="observacoes" rows={2} defaultValue={padrao.observacoes ?? ""} className="campo" maxLength={2000} />
      </Campo>
    </div>
  );
}
