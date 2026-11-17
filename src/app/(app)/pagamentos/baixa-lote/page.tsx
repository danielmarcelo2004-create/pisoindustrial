import type { Metadata } from "next";
import { exigirPerfil } from "@/lib/auth";
import { Cabecalho } from "@/components/ui";
import { abertosParaBaixa } from "@/lib/consultas/abertos-baixa";
import { FormBaixaLote } from "./form";

export const metadata: Metadata = { title: "Baixa em lote" };

export default async function BaixaLotePage() {
  await exigirPerfil("financeiro", "administrador_master");
  const abertos = await abertosParaBaixa();
  return (
    <>
      <Cabecalho
        titulo="Baixa de pagamentos em lote"
        subtitulo="Envie os PDFs de comprovantes do banco (PIX e boletos, podem ser arquivos separados). O sistema lê cada página, reconhece o pagamento e você confere antes de confirmar."
        voltar={{ href: "/pagamentos", rotulo: "Pagamentos" }}
      />
      <FormBaixaLote abertos={abertos} />
    </>
  );
}
