"use client";

import { useActionState, startTransition } from "react";
import type { Estado } from "@/lib/erros";
import { Aviso, Botao } from "@/components/ui";

export function CaixaCredenciais({ email, senha }: { email: string; senha: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm">
      <div className="font-semibold text-amber-900">Credenciais provisórias — anote agora</div>
      <p className="mt-1 text-amber-900">
        Esta senha não será exibida novamente. Entregue-a por um canal seguro (pessoalmente ou mensagem direta). No primeiro acesso o
        usuário deverá criar uma senha própria.
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
        <dt className="text-amber-800">Login</dt>
        <dd className="select-all">{email}</dd>
        <dt className="text-amber-800">Senha</dt>
        <dd className="select-all text-base font-semibold">{senha}</dd>
      </dl>
    </div>
  );
}

/** Botão de ação que exibe credenciais retornadas pela Server Action. */
export function AcaoCredenciais({
  action,
  rotulo,
  confirmar,
}: {
  action: (e: Estado) => Promise<Estado>;
  rotulo: string;
  confirmar: string;
}) {
  const [estado, executar, pendente] = useActionState(action, null);
  return (
    <div className="space-y-3">
      <Botao
        variante="secundario"
        disabled={pendente}
        onClick={() => {
          if (window.confirm(confirmar)) startTransition(() => executar());
        }}
      >
        {pendente ? "Gerando…" : rotulo}
      </Botao>
      {estado?.erro && <Aviso tipo="erro">{estado.erro}</Aviso>}
      {estado?.dados?.senha && <CaixaCredenciais email={estado.dados.email} senha={estado.dados.senha} />}
    </div>
  );
}
