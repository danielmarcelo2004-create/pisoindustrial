import { redirect } from "next/navigation";

// A baixa agora parte da lista de Pagamentos (marcar e clicar em "Baixar").
export default function BaixaLoteAntiga() {
  redirect("/pagamentos?status=aguardando_pagamento");
}
