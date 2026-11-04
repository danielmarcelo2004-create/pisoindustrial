import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Cabecalho, Cartao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { CamposFornecedor } from "../campos";
import { salvarFornecedor } from "../actions";

export const metadata: Metadata = { title: "Novo fornecedor" };

export default async function NovoFornecedorPage() {
  await exigirPerfil("financeiro", "suprimentos");
  return (
    <>
      <Cabecalho titulo="Novo fornecedor" voltar={{ href: "/fornecedores", rotulo: "Fornecedores" }} />
      <Cartao>
        <FormAcao action={salvarFornecedor.bind(null, null)} enviar="Cadastrar fornecedor">
          <CamposFornecedor />
        </FormAcao>
      </Cartao>
    </>
  );
}
