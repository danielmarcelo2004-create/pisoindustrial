"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

/** "← Contas a pagar" que volta para a lista como ela estava (período, filtros e contas marcadas). */
export function LinkVoltarContas({ rotulo, className }: { rotulo: string; className: string }) {
  const router = useRouter();
  return (
    <Link
      href="/pagamentos"
      className={className}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return; // nova aba: lista padrão
        let salvo: string | null = null;
        try {
          salvo = sessionStorage.getItem("contas-a-pagar:lista");
        } catch {
          /* sem armazenamento: volta para a lista padrão */
        }
        if (salvo && salvo.startsWith("/pagamentos") && salvo !== "/pagamentos") {
          e.preventDefault();
          router.push(salvo);
        }
      }}
    >
      ← {rotulo}
    </Link>
  );
}
