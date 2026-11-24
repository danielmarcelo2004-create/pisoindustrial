"use client";

import { useState } from "react";
import { Campo } from "@/components/ui";

export type DadosIniciais = { forma: string | null; favorecido: string | null; banco: string | null; agencia: string | null; conta: string | null; chavePix: string | null };

/** Campos "como você recebe": conta bancária (agência + conta) ou PIX (chave). A instituição vale para os dois. */
export function CamposDadosBancarios({ inicial }: { inicial: DadosIniciais }) {
  const [forma, setForma] = useState(inicial.forma === "pix" ? "pix" : "conta");
  return (
    <>
      <fieldset className="mb-3 flex flex-wrap gap-4 text-sm" aria-label="Como você recebe">
        <label className="flex items-center gap-2">
          <input type="radio" name="forma" value="conta" checked={forma === "conta"} onChange={() => setForma("conta")} /> Conta bancária
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="forma" value="pix" checked={forma === "pix"} onChange={() => setForma("pix")} /> PIX
        </label>
      </fieldset>
      <div className="space-y-3">
        <Campo rotulo="Nome do favorecido (titular da conta ou da chave PIX)" obrigatorio>
          <input name="favorecido" required defaultValue={inicial.favorecido ?? ""} className="campo" maxLength={160} placeholder="Nome completo de quem vai receber" />
        </Campo>
        <Campo rotulo="Instituição bancária" obrigatorio>
          <input name="banco" required defaultValue={inicial.banco ?? ""} className="campo" maxLength={120} placeholder="Ex.: Banco do Brasil, Nubank, Caixa" />
        </Campo>
        {forma === "conta" ? (
          <div className="grid grid-cols-2 gap-3">
            <Campo rotulo="Agência" obrigatorio>
              <input name="agencia" required defaultValue={inicial.agencia ?? ""} className="campo" maxLength={20} inputMode="numeric" />
            </Campo>
            <Campo rotulo="Conta" obrigatorio>
              <input name="conta" required defaultValue={inicial.conta ?? ""} className="campo" maxLength={30} />
            </Campo>
          </div>
        ) : (
          <Campo rotulo="Chave PIX" obrigatorio>
            <input name="chave_pix" required defaultValue={inicial.chavePix ?? ""} className="campo" maxLength={140} placeholder="CPF, e-mail, telefone ou chave aleatória" />
          </Campo>
        )}
      </div>
    </>
  );
}
