import type { Metadata } from "next";
import Link from "next/link";
import { Cabecalho, Cartao, LinkBotao, Selo } from "@/components/ui";
import { exigirPerfil } from "@/lib/auth";
import { PERFIS } from "@/lib/rotulos";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Usuários e permissões" };

export default async function UsuariosPage() {
  await exigirPerfil("financeiro");
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, nome, email, telefone, perfil, ativo, troca_senha_pendente, obra_acessos!obra_acessos_user_id_fkey(obra_id)")
    .order("ativo", { ascending: false })
    .order("nome");

  return (
    <>
      <Cabecalho
        titulo="Usuários e permissões"
        subtitulo="Cada pessoa tem credencial individual. Somente o Financeiro cria usuários e concede acessos."
        acoes={<LinkBotao href="/usuarios/novo">+ Novo usuário</LinkBotao>}
      />
      <Cartao semPadding>
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Perfil</th>
                <th>Telefone</th>
                <th>Acessos extras</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {(data ?? []).map((p) => (
                <tr key={p.id} className={p.ativo ? "" : "opacity-60"}>
                  <td>
                    <Link href={`/usuarios/${p.id}`} className="font-medium text-marca-700 hover:underline">
                      {p.nome}
                    </Link>
                    <div className="text-xs text-slate-500">{p.email}</div>
                  </td>
                  <td>{PERFIS[p.perfil]}</td>
                  <td>{p.telefone ?? "—"}</td>
                  <td>{p.perfil === "financeiro" ? "Todas as obras" : `${p.obra_acessos.length} obra(s)`}</td>
                  <td className="space-x-1">
                    {p.ativo ? <Selo cor="verde">Ativo</Selo> : <Selo>Inativo</Selo>}
                    {p.ativo && p.troca_senha_pendente && <Selo cor="amarelo">Aguardando 1º acesso</Selo>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Cartao>
    </>
  );
}
