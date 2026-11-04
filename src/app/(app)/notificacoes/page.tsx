import type { Metadata } from "next";
import { FormAcao } from "@/components/form-acao";
import { Cabecalho, Cartao, Vazio, cx } from "@/components/ui";
import { getUsuario } from "@/lib/auth";
import { dataHora } from "@/lib/formato";
import { createClient } from "@/lib/supabase/server";
import { marcarTodasLidas } from "./actions";

export const metadata: Metadata = { title: "Notificações" };

export default async function NotificacoesPage() {
  await getUsuario();
  const supabase = await createClient();
  const { data } = await supabase.from("notificacoes").select("*").order("created_at", { ascending: false }).limit(200);
  const naoLidas = (data ?? []).filter((n) => !n.lida_em).length;

  return (
    <>
      <Cabecalho
        titulo="Notificações"
        subtitulo={naoLidas ? `${naoLidas} não lida(s)` : "Tudo em dia"}
        acoes={naoLidas > 0 && <FormAcao action={marcarTodasLidas} enviar="Marcar todas como lidas" variante="secundario" className="" />}
      />
      <Cartao semPadding>
        {!data?.length ? (
          <Vazio>Nenhuma notificação.</Vazio>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((n) => (
              <li key={n.id}>
                <a href={`/notificacoes/${n.id}`} className={cx("block px-4 py-3 hover:bg-slate-50", !n.lida_em && "bg-marca-50/50")}>
                  <div className="flex items-start gap-3">
                    <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.lida_em ? "bg-transparent" : "bg-marca-600")} />
                    <div className="min-w-0 flex-1">
                      <div className={cx("text-sm", !n.lida_em && "font-semibold")}>{n.titulo}</div>
                      {n.mensagem && <div className="text-sm text-slate-600">{n.mensagem}</div>}
                      <div className="mt-0.5 text-xs text-slate-400">{dataHora(n.created_at)}</div>
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Cartao>
    </>
  );
}
