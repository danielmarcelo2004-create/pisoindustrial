import { Campo } from "@/components/ui";
import { cpfCnpj } from "@/lib/formato";
import { UFS } from "@/lib/rotulos";

type Padrao = Partial<Record<"nome" | "cpf_cnpj" | "email" | "telefone" | "cidade" | "uf" | "chave_pix" | "banco" | "agencia" | "conta" | "observacoes", string | null>> & {
  ativo?: boolean;
};

export function CamposFornecedor({ padrao, edicao }: { padrao?: Padrao; edicao?: boolean }) {
  const p = padrao ?? {};
  return (
    <div className="grid gap-4 sm:grid-cols-4">
      <Campo rotulo="Nome / razão social" obrigatorio className="sm:col-span-3">
        <input name="nome" required defaultValue={p.nome ?? ""} className="campo" maxLength={200} />
      </Campo>
      <Campo rotulo="CPF / CNPJ">
        <input name="cpf_cnpj" defaultValue={cpfCnpj(p.cpf_cnpj)} className="campo" inputMode="numeric" maxLength={18} />
      </Campo>
      <Campo rotulo="E-mail" className="sm:col-span-2">
        <input name="email" type="email" defaultValue={p.email ?? ""} className="campo" />
      </Campo>
      <Campo rotulo="Telefone">
        <input name="telefone" defaultValue={p.telefone ?? ""} className="campo" />
      </Campo>
      <div />
      <Campo rotulo="Cidade" className="sm:col-span-2">
        <input name="cidade" defaultValue={p.cidade ?? ""} className="campo" />
      </Campo>
      <Campo rotulo="UF">
        <select name="uf" defaultValue={p.uf ?? ""} className="campo">
          <option value="">—</option>
          {UFS.map((u) => (
            <option key={u}>{u}</option>
          ))}
        </select>
      </Campo>
      <div />
      <Campo rotulo="Chave PIX" className="sm:col-span-2">
        <input name="chave_pix" defaultValue={p.chave_pix ?? ""} className="campo" />
      </Campo>
      <Campo rotulo="Banco">
        <input name="banco" defaultValue={p.banco ?? ""} className="campo" />
      </Campo>
      <div className="grid grid-cols-2 gap-2">
        <Campo rotulo="Agência">
          <input name="agencia" defaultValue={p.agencia ?? ""} className="campo" />
        </Campo>
        <Campo rotulo="Conta">
          <input name="conta" defaultValue={p.conta ?? ""} className="campo" />
        </Campo>
      </div>
      <Campo rotulo="Observações" className="sm:col-span-4">
        <textarea name="observacoes" rows={2} defaultValue={p.observacoes ?? ""} className="campo" />
      </Campo>
      {edicao && (
        <label className="flex items-center gap-2 text-sm sm:col-span-4">
          <input type="checkbox" name="ativo" defaultChecked={p.ativo ?? true} /> Fornecedor ativo
        </label>
      )}
    </div>
  );
}
