import { redirect } from "next/navigation";

// A nova Ordem de Pagamento é feita em "Novo pagamento" (formas que não são boleto). Mantém o endereço antigo funcionando.
export default function NovaOPPage() {
  redirect("/pagamentos/novo");
}
