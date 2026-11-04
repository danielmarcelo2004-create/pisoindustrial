import type { Metadata } from "next";
import Link from "next/link";
import { FormAcao } from "@/components/form-acao";
import { Aviso, Campo } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { trocarSenha } from "./actions";

export const metadata: Metadata = { title: "Definir senha" };

export default async function TrocarSenhaPage() {
  const u = await getUsuario();
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-slate-900">
          {u.trocaSenhaPendente ? "Defina sua senha" : "Alterar senha"}
        </h1>
        <p className="mt-1 mb-4 text-sm text-slate-500">{u.email}</p>
        {u.trocaSenhaPendente && (
          <div className="mb-4">
            <Aviso tipo="info">
              Este é seu primeiro acesso (ou sua senha foi redefinida). Crie uma senha pessoal para continuar. Não
              compartilhe sua senha: ela identifica você nas assinaturas e no histórico.
            </Aviso>
          </div>
        )}
        <FormAcao
          action={trocarSenha}
          enviar="Salvar senha"
          rodape={
            !u.trocaSenhaPendente && (
              <Link href="/" className="text-sm text-slate-600 hover:underline">
                Cancelar
              </Link>
            )
          }
        >
          <Campo rotulo="Nova senha" ajuda="Mínimo de 8 caracteres, com letras e números.">
            <input name="senha" type="password" autoComplete="new-password" required minLength={8} className="campo" />
          </Campo>
          <Campo rotulo="Confirme a nova senha">
            <input name="confirmacao" type="password" autoComplete="new-password" required className="campo" />
          </Campo>
        </FormAcao>
      </div>
    </main>
  );
}
