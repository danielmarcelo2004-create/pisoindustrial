import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Campo } from "@/components/ui";
import { SISTEMA } from "@/lib/sistema";
import { entrar } from "./actions";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const voltar = typeof sp.voltar === "string" ? sp.voltar : "";
  const motivo = typeof sp.motivo === "string" ? sp.motivo : "";

  return (
    <main className="flex min-h-screen items-center justify-center bg-marca-900 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-white">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-lg bg-white/10 text-lg font-bold">
            {SISTEMA.sigla}
          </div>
          <h1 className="text-xl font-semibold">{SISTEMA.nome}</h1>
          <p className="mt-1 text-sm text-marca-200">Acesso restrito a usuários autorizados</p>
        </div>
        <div className="rounded-lg bg-white p-6 shadow-xl">
          {motivo === "inativo" && (
            <div className="mb-4">
              <Aviso tipo="alerta">Seu acesso está desativado. Fale com o Financeiro.</Aviso>
            </div>
          )}
          {motivo === "saiu" && (
            <div className="mb-4">
              <Aviso tipo="info">Você saiu do sistema.</Aviso>
            </div>
          )}
          <FormAcao action={entrar} enviar="Entrar" pendente="Entrando…">
            <input type="hidden" name="voltar" value={voltar} />
            <Campo rotulo="E-mail">
              <input name="email" type="email" autoComplete="username" required className="campo" autoFocus />
            </Campo>
            <Campo rotulo="Senha">
              <input name="senha" type="password" autoComplete="current-password" required className="campo" />
            </Campo>
          </FormAcao>
          <p className="mt-4 text-xs text-slate-500">
            Esqueceu a senha? Solicite ao Financeiro uma nova senha provisória.
          </p>
        </div>
      </div>
    </main>
  );
}
