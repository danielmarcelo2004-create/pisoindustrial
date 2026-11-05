import { Campo } from "@/components/ui";
import { FLUXOS, STATUS_OBRA, UFS } from "@/lib/rotulos";

type Pessoa = { id: string; nome: string };
type Padrao = Partial<{
  codigo: string | null;
  nome: string;
  cliente: string | null;
  endereco: string | null;
  cidade: string;
  uf: string;
  fluxo: string;
  status: string;
  engenheiro_id: string | null;
  administrador_id: string | null;
  observacoes: string | null;
}>;

export function CamposObra({ engenheiros, administradores, padrao = {} }: { engenheiros: Pessoa[]; administradores: Pessoa[]; padrao?: Padrao }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-4">
        <Campo rotulo="Código">
          <input name="codigo" defaultValue={padrao.codigo ?? ""} className="campo" maxLength={30} />
        </Campo>
        <Campo rotulo="Nome do centro de custo" obrigatorio className="sm:col-span-3">
          <input name="nome" required defaultValue={padrao.nome ?? ""} className="campo" maxLength={200} />
        </Campo>
        <Campo rotulo="Cliente" className="sm:col-span-2">
          <input name="cliente" defaultValue={padrao.cliente ?? ""} className="campo" maxLength={200} />
        </Campo>
        <Campo rotulo="Situação">
          <select name="status" defaultValue={padrao.status ?? "ativa"} className="campo">
            {Object.entries(STATUS_OBRA).map(([v, r]) => (
              <option key={v} value={v}>
                {r}
              </option>
            ))}
          </select>
        </Campo>
        <div />
        <Campo rotulo="Endereço" className="sm:col-span-2">
          <input name="endereco" defaultValue={padrao.endereco ?? ""} className="campo" maxLength={300} />
        </Campo>
        <Campo rotulo="Cidade" obrigatorio>
          <input name="cidade" required defaultValue={padrao.cidade ?? ""} className="campo" maxLength={100} />
        </Campo>
        <Campo rotulo="UF" obrigatorio>
          <select name="uf" required defaultValue={padrao.uf ?? ""} className="campo">
            <option value="">—</option>
            {UFS.map((u) => (
              <option key={u}>{u}</option>
            ))}
          </select>
        </Campo>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-700">
          Fluxo de aprovação <span className="text-red-600">*</span>
        </legend>
        <div className="grid gap-2 md:grid-cols-3">
          {Object.entries(FLUXOS).map(([v, f]) => (
            <label key={v} className="flex cursor-pointer gap-2 rounded-md border border-slate-300 p-3 text-sm has-[:checked]:border-marca-500 has-[:checked]:bg-marca-50">
              <input type="radio" name="fluxo" value={v} required defaultChecked={(padrao.fluxo ?? "") === v} className="mt-0.5" />
              <span>
                <span className="block font-medium">{f.rotulo}</span>
                <span className="text-xs text-slate-600">{f.descricao}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Campo rotulo="Engenheiro responsável" ajuda="Obrigatório no Fluxo A.">
          <select name="engenheiro_id" defaultValue={padrao.engenheiro_id ?? ""} className="campo">
            <option value="">— Nenhum —</option>
            {engenheiros.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Administrador responsável" ajuda="Obrigatório nos Fluxos A e B.">
          <select name="administrador_id" defaultValue={padrao.administrador_id ?? ""} className="campo">
            <option value="">— Nenhum —</option>
            {administradores.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </Campo>
      </div>
      <Campo rotulo="Observações">
        <textarea name="observacoes" rows={2} defaultValue={padrao.observacoes ?? ""} className="campo" />
      </Campo>
    </div>
  );
}
