"use client";

import { useState, type ReactNode } from "react";
import { Campo, Cartao } from "@/components/ui";
import type { Estado } from "@/lib/erros";
import { FORMAS_PAGAMENTO, type FormaPagamento } from "@/lib/rotulos";
import { FormOP } from "../../ops/form";

type ObraOP = { id: string; nome: string; cidade: string; uf: string; temAdministrador: boolean };

/**
 * Novo pagamento: a forma de pagamento decide o formulário.
 * Boleto: cadastro com boleto/nota. Demais formas: Ordem de Pagamento no modelo oficial (o PDF é gerado no envio).
 */
export function TipoPagamento({
  formas,
  formaInicial,
  formBoleto,
  op,
}: {
  formas: FormaPagamento[];
  formaInicial: FormaPagamento;
  formBoleto: ReactNode;
  op: {
    action: (e: Estado, fd: FormData) => Promise<Estado>;
    obras: ObraOP[];
    podeAssinar: boolean;
    ehEngenheiro: boolean;
    assinaturaUrl: string | null;
    categorias: { id: string; nome: string }[];
    podeAdicionarCategoria: boolean;
  };
}) {
  const [forma, setForma] = useState<FormaPagamento>(formaInicial);
  return (
    <div className="space-y-6">
      <Cartao titulo="Forma de pagamento">
        <Campo
          rotulo="Forma de pagamento"
          obrigatorio
          ajuda={
            forma === "boleto"
              ? "Boleto: anexe o boleto ou a nota fiscal; o engenheiro assina esse documento."
              : "Preencha a Ordem de Pagamento abaixo. O PDF no modelo oficial é gerado ao enviar e é o documento que o engenheiro e o administrador assinam."
          }
        >
          <select value={forma} onChange={(e) => setForma(e.target.value as FormaPagamento)} className="campo sm:max-w-sm" aria-label="Forma de pagamento">
            {formas.map((v) => (
              <option key={v} value={v}>
                {FORMAS_PAGAMENTO[v]}
              </option>
            ))}
          </select>
        </Campo>
      </Cartao>
      {forma === "boleto" ? (
        formBoleto
      ) : op.obras.length === 0 ? (
        <p className="text-sm text-amber-700">Você não está vinculado a nenhum centro de custo ativo para solicitar Ordem de Pagamento.</p>
      ) : (
        <FormOP
          action={op.action}
          obras={op.obras}
          podeAssinar={op.podeAssinar}
          ehEngenheiro={op.ehEngenheiro}
          assinaturaUrl={op.assinaturaUrl}
          formaFixa={forma}
          categorias={op.categorias}
          podeAdicionarCategoria={op.podeAdicionarCategoria}
          padrao={{ forma_pagamento: forma }}
        />
      )}
    </div>
  );
}
