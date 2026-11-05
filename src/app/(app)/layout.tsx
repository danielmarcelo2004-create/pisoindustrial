import Link from "next/link";
import { redirect } from "next/navigation";
import { Navegacao, type ItemMenu } from "@/components/navegacao";
import { Icones } from "@/components/icones";
import { getUsuario } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PERFIS } from "@/lib/rotulos";
import { SISTEMA } from "@/lib/sistema";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const u = await getUsuario();
  if (u.trocaSenhaPendente) redirect("/trocar-senha");

  const supabase = await createClient();
  const [{ count: naoLidas }, pend] = await Promise.all([
    supabase.from("notificacoes").select("id", { count: "exact", head: true }).is("lida_em", null),
    u.perfil === "engenheiro" || u.perfil === "administrador" || u.perfil === "administrador_master"
      ? supabase.rpc("minhas_pendencias", undefined, { count: "exact", head: true })
      : Promise.resolve({ count: 0 }),
  ]);

  const fin = u.perfil === "financeiro";
  const sup = u.perfil === "suprimentos";
  const assinante = u.perfil === "engenheiro" || u.perfil === "administrador" || u.perfil === "administrador_master";
  const compras = u.perfil !== "engenheiro";

  const principal: ItemMenu[] = [
    { href: "/", rotulo: "Painel", icone: Icones.painel },
    { href: "/agenda", rotulo: "Agenda de pagamentos", icone: Icones.agenda },
    { href: "/pagamentos", rotulo: "Pagamentos", icone: Icones.pagamentos },
    { href: "/ops", rotulo: u.perfil === "engenheiro" ? "Minhas solicitações (OP)" : "Solicitações de OP", icone: Icones.op },
    ...(assinante ? [{ href: "/aprovacoes", rotulo: "Aprovações e assinaturas", icone: Icones.aprovacoes, contador: pend.count ?? 0 }] : []),
    { href: "/obras", rotulo: "Centros de custo", icone: Icones.obras },
    { href: "/provisoes", rotulo: "Provisões", icone: Icones.agenda },
    ...(fin || sup ? [{ href: "/fornecedores", rotulo: "Fornecedores", icone: Icones.fornecedores }] : []),
    { href: "/relatorios", rotulo: "Relatórios", icone: Icones.relatorios },
    ...(compras ? [{ href: "/compras", rotulo: "Inteligência de Compras", icone: Icones.compras }] : []),
    ...(fin ? [{ href: "/usuarios", rotulo: "Usuários e permissões", icone: Icones.usuarios }] : []),
    ...(fin ? [{ href: "/auditoria", rotulo: "Histórico de atividades", icone: Icones.auditoria }] : []),
  ];
  const futuro: ItemMenu[] = [];

  return (
    <div className="min-h-screen">
      <Navegacao
        principal={principal}
        futuro={futuro}
        marca={
          <Link href="/" className="flex items-center gap-3 text-white">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-sm font-bold">{SISTEMA.sigla}</span>
            <span className="text-sm leading-tight font-semibold">{SISTEMA.nome}</span>
          </Link>
        }
        rodape={
          <div className="text-sm text-marca-100">
            <div className="truncate font-medium text-white">{u.nome}</div>
            <div className="truncate text-xs text-marca-200">{PERFIS[u.perfil]}</div>
            <div className="mt-2 flex gap-3 text-xs">
              <Link href="/trocar-senha" className="hover:text-white hover:underline">
                Alterar senha
              </Link>
              <form action="/sair" method="post">
                <button type="submit" className="hover:text-white hover:underline">
                  Sair
                </button>
              </form>
            </div>
          </div>
        }
      />
      <div className="min-w-0 lg:pl-64">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-end gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <Link
            href="/notificacoes"
            className="relative rounded-full p-2 text-slate-600 hover:bg-slate-100"
            aria-label={`Notificações${naoLidas ? ` (${naoLidas} não lidas)` : ""}`}
          >
            {Icones.sino}
            {!!naoLidas && (
              <span className="absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-red-600 px-1 text-center text-[11px] font-semibold text-white">
                {naoLidas > 99 ? "99+" : naoLidas}
              </span>
            )}
          </Link>
          <div className="hidden text-right text-sm sm:block">
            <div className="font-medium text-slate-800">{u.nome}</div>
            <div className="text-xs text-slate-500">{PERFIS[u.perfil]}</div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
