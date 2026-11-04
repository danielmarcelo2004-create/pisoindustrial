import type { Metadata } from "next";
import { Cabecalho } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { gerarSenhaProvisoria } from "@/lib/senha";
import { createClient } from "@/lib/supabase/server";
import { FormNovoUsuario } from "./form";

export const metadata: Metadata = { title: "Novo usuário" };

export default async function NovoUsuarioPage() {
  await exigirPerfil("financeiro");
  const supabase = await createClient();
  const { data: obras } = await supabase.from("obras").select("id, nome").neq("status", "concluida").order("nome");
  return (
    <>
      <Cabecalho titulo="Novo usuário" voltar={{ href: "/usuarios", rotulo: "Usuários" }} />
      <FormNovoUsuario obras={obras ?? []} senhaSugerida={gerarSenhaProvisoria()} />
    </>
  );
}
