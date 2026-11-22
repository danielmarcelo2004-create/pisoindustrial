import Link from "next/link";

/**
 * "Conta bancária": de qual conta sai o pagamento (obrigatória ao criar a despesa).
 * Com uma conta só, ela já vem escolhida.
 */
export function SeletorContaBancaria({ contas, valorInicial, podeCadastrar = false }: { contas: { id: string; nome: string }[]; valorInicial?: string | null; podeCadastrar?: boolean }) {
  if (!contas.length) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Nenhuma conta bancária cadastrada.{" "}
        {podeCadastrar ? (
          <Link href="/contas-bancarias" className="underline">
            Cadastre em Contas bancárias
          </Link>
        ) : (
          "Peça ao Financeiro para cadastrar em Contas bancárias."
        )}
        <select name="conta_bancaria_id" required defaultValue="" className="sr-only" aria-label="Conta bancária" tabIndex={-1}>
          <option value="" />
        </select>
      </div>
    );
  }
  const inicial = valorInicial && contas.some((c) => c.id === valorInicial) ? valorInicial : contas.length === 1 ? contas[0].id : "";
  return (
    <select name="conta_bancaria_id" required defaultValue={inicial} className="campo" aria-label="Conta bancária">
      <option value="" disabled>
        Escolha a conta de onde sai o pagamento…
      </option>
      {contas.map((c) => (
        <option key={c.id} value={c.id}>
          {c.nome}
        </option>
      ))}
    </select>
  );
}
