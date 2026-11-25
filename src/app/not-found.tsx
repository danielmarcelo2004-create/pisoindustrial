import Link from "next/link";

// Página inexistente (ou que a pessoa não pode ver): mensagem em português, sem revelar o motivo.
export default function NaoEncontrada() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold text-slate-900">Página não encontrada</h1>
      <p className="mt-2 text-sm text-slate-600">O endereço não existe ou você não tem acesso a ele.</p>
      <Link href="/" className="mt-5 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
        Voltar ao início
      </Link>
    </div>
  );
}
