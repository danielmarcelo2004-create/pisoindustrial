import type { Metadata } from "next";
import { Aviso, Cabecalho } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { obrasParaOP } from "@/lib/consultas/obras-op";
import { salvarOP } from "../actions";
import { FormOP } from "../form";

export const metadata: Metadata = { title: "Nova solicitação de OP" };

export default async function NovaOPPage() {
  await exigirPerfil("engenheiro");
  const obras = await obrasParaOP();
  return (
    <>
      <Cabecalho titulo="Nova solicitação de Ordem de Pagamento" voltar={{ href: "/ops", rotulo: "Minhas solicitações" }} />
      {obras.length === 0 ? (
        <Aviso tipo="alerta">Você não está vinculado a nenhuma obra ativa.</Aviso>
      ) : (
        <FormOP action={salvarOP.bind(null, null)} obras={obras} />
      )}
    </>
  );
}
