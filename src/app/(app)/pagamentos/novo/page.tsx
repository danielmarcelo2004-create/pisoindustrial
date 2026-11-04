import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Cabecalho, Campo, Cartao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { fornecedoresAtivos, obrasParaCadastro } from "@/lib/consultas/cadastros";
import { FLUXOS } from "@/lib/rotulos";
import { CamposPagamento } from "../campos";
import { criarPagamento } from "../actions";

export const metadata: Metadata = { title: "Novo pagamento" };

const ACEITOS = ".pdf,.png,.jpg,.jpeg,.webp,.heic,.xml";

export default async function NovoPagamentoPage({ searchParams }: PageProps<"/pagamentos/novo">) {
  const u = await exigirPerfil("financeiro", "suprimentos");
  const sp = await searchParams;
  const [obras, fornecedores] = await Promise.all([obrasParaCadastro(u), fornecedoresAtivos()]);
  const obraPadrao = typeof sp.obra === "string" ? sp.obra : "";

  return (
    <>
      <Cabecalho titulo="Novo pagamento" voltar={{ href: "/pagamentos", rotulo: "Pagamentos" }} />
      {obras.length === 0 ? (
        <Aviso tipo="alerta">Você ainda não tem permissão para cadastrar pagamentos em nenhuma obra ativa. Solicite acesso ao Financeiro.</Aviso>
      ) : (
        <FormAcao action={criarPagamento} enviar="Cadastrar e encaminhar" pendente="Enviando…">
          <Cartao titulo="Obra">
            <Campo rotulo="Obra" obrigatorio ajuda="O pagamento seguirá o fluxo de aprovação configurado para a obra.">
              <select name="obra_id" required defaultValue={obraPadrao} className="campo">
                <option value="">Selecione…</option>
                {obras.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.nome} — {o.cidade}/{o.uf} · {FLUXOS[o.fluxo].rotulo.split(" — ")[1]}
                  </option>
                ))}
              </select>
            </Campo>
          </Cartao>
          <Cartao titulo="Dados do pagamento">
            <CamposPagamento fornecedores={fornecedores} />
          </Cartao>
          <Cartao titulo="Documentos">
            <div className="grid gap-4 sm:grid-cols-3">
              <Campo rotulo="Boleto">
                <input type="file" name="boleto" accept={ACEITOS} className="campo" />
              </Campo>
              <Campo rotulo="Nota fiscal" ajuda="Prefira o XML da NF-e, quando houver.">
                <input type="file" name="nota_fiscal" accept={ACEITOS} multiple className="campo" />
              </Campo>
              <Campo rotulo="Outros documentos">
                <input type="file" name="outros" accept={ACEITOS} multiple className="campo" />
              </Campo>
            </div>
            <p className="mt-2 text-xs text-slate-500">PDF, imagem ou XML, até 25 MB cada. Também é possível anexar depois.</p>
          </Cartao>
        </FormAcao>
      )}
    </>
  );
}
