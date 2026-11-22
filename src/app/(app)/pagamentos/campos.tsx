import { Campo } from "@/components/ui";
import { hojeISO, valorParaCampo } from "@/lib/formato";
import { FORMAS_PAGAMENTO } from "@/lib/rotulos";
import { ParcelasPagamento } from "./parcelas-pagamento";
import { SeletorCategoria } from "@/components/seletor-categoria";
import { AvisosLancamento } from "@/components/avisos-lancamento";
import { SeletorContaBancaria } from "@/components/seletor-conta-bancaria";

type Padrao = {
  fornecedor_id?: string | null;
  favorecido?: string | null;
  descricao?: string | null;
  valor?: number | string | null;
  vencimento?: string | null;
  data_competencia?: string | null;
  categoria_id?: string | null;
  conta_bancaria_id?: string | null;
  forma_pagamento?: string | null;
  numero_documento?: string | null;
  observacoes?: string | null;
};

export function CamposPagamento({
  fornecedores,
  padrao = {},
  parcelar = false,
  formaFixa,
  categorias,
  podeAdicionarCategoria = false,
  pagamentoId,
  contasBancarias,
  podeCadastrarConta = false,
}: {
  fornecedores: { id: string; nome: string; cpf_cnpj: string | null }[];
  padrao?: Padrao;
  parcelar?: boolean;
  /** Forma escolhida fora (topo de "Novo pagamento"): não mostra o seletor. */
  formaFixa?: string;
  categorias?: { id: string; nome: string }[];
  podeAdicionarCategoria?: boolean;
  /** Na edição: o próprio pagamento não conta como duplicado. */
  pagamentoId?: string;
  /** Contas bancárias (de onde sai o pagamento). */
  contasBancarias?: { id: string; nome: string }[];
  podeCadastrarConta?: boolean;
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
      {categorias && (
        <Campo rotulo="Categoria" obrigatorio className="sm:col-span-2">
          <SeletorCategoria categorias={categorias} valorInicial={padrao.categoria_id} podeAdicionar={podeAdicionarCategoria} />
        </Campo>
      )}
      {contasBancarias && (
        <Campo rotulo="Conta bancária" obrigatorio className="sm:col-span-2" ajuda="De qual conta sai o pagamento. Se for paga por outra, dá para trocar depois em Ações.">
          <SeletorContaBancaria contas={contasBancarias} valorInicial={padrao.conta_bancaria_id} podeCadastrar={podeCadastrarConta} />
        </Campo>
      )}
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
      <Campo rotulo="Data de competência" obrigatorio ajuda="Já vem com a data do lançamento. Altere se a despesa for de outro período.">
        <input name="data_competencia" type="date" required defaultValue={padrao.data_competencia ?? hojeISO()} className="campo" />
      </Campo>
      {formaFixa ? (
        <input type="hidden" name="forma_pagamento" value={formaFixa} />
      ) : (
        <Campo rotulo="Forma de pagamento" obrigatorio>
          <select name="forma_pagamento" defaultValue={padrao.forma_pagamento ?? "boleto"} className="campo">
            {Object.entries(FORMAS_PAGAMENTO).map(([v, r]) => (
              <option key={v} value={v}>
                {r}
              </option>
            ))}
          </select>
        </Campo>
      )}
      <Campo rotulo="Nº do documento / NF">
        <input name="numero_documento" defaultValue={padrao.numero_documento ?? ""} className="campo" maxLength={100} />
      </Campo>
      <Campo rotulo="Observações" className="sm:col-span-2" ajuda="Observações não fazem parte do conteúdo assinado.">
        <textarea name="observacoes" rows={2} defaultValue={padrao.observacoes ?? ""} className="campo" maxLength={2000} />
      </Campo>
      <AvisosLancamento excluirPagamentoId={pagamentoId} />
      {parcelar && <ParcelasPagamento />}
    </div>
  );
}
