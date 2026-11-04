import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Cabecalho, Cartao } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { responsaveisAtivos } from "@/lib/consultas/usuarios";
import { CamposObra } from "../campos";
import { salvarObra } from "../actions";

export const metadata: Metadata = { title: "Nova obra" };

export default async function NovaObraPage() {
  await exigirPerfil("financeiro");
  const { engenheiros, administradores } = await responsaveisAtivos();
  return (
    <>
      <Cabecalho titulo="Nova obra" voltar={{ href: "/obras", rotulo: "Obras" }} />
      <Cartao>
        <FormAcao action={salvarObra.bind(null, null)} enviar="Cadastrar obra">
          <CamposObra engenheiros={engenheiros} administradores={administradores} />
        </FormAcao>
      </Cartao>
    </>
  );
}
