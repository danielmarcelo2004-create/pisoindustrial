import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Marca a notificação como lida e abre a tarefa correspondente. */
export async function GET(request: NextRequest, ctx: RouteContext<"/notificacoes/[id]">) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.redirect(new URL("/notificacoes", request.url));
  const { data } = await supabase.from("notificacoes").select("link").eq("id", id).maybeSingle();
  await supabase.rpc("marcar_notificacoes_lidas", { p_ids: [id] });
  const destino = data?.link && data.link.startsWith("/") && !data.link.startsWith("//") ? data.link : "/notificacoes";
  return NextResponse.redirect(new URL(destino, request.url), { status: 303 });
}
