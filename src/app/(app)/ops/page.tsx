import { redirect } from "next/navigation";

// As Ordens de Pagamento agora ficam em Pagamentos (aba única). Mantém o endereço antigo funcionando.
export default function OPsPage() {
  redirect("/pagamentos");
}
