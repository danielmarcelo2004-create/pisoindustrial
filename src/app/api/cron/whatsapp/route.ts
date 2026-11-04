import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { enviarWhatsapp, telefoneE164, whatsappConfigurado } from "@/lib/whatsapp";

/**
 * Processa a fila de alertas por WhatsApp. Chamado por um agendador (ex.: Vercel
 * Cron) com o cabeçalho "Authorization: Bearer <CRON_SECRET>".
 */
export async function GET(request: NextRequest) {
  const segredo = process.env.CRON_SECRET;
  const recebido = request.headers.get("authorization") ?? "";
  const esperado = `Bearer ${segredo}`;
  if (!segredo || recebido.length !== esperado.length || !timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) {
    return NextResponse.json({ erro: "não autorizado" }, { status: 401 });
  }
  if (!whatsappConfigurado()) {
    return NextResponse.json({ configurado: false, mensagem: "WhatsApp não configurado; alertas continuam na fila." });
  }

  const admin = createAdminClient();
  const appUrl = (process.env.APP_URL ?? request.nextUrl.origin).replace(/\/$/, "");

  // Alertas muito antigos não são mais enviados.
  const limite = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  await admin.from("notificacoes").update({ whatsapp_status: "ignorado", whatsapp_erro: "expirado" }).eq("whatsapp_status", "pendente").lt("created_at", limite);

  const { data: fila, error } = await admin
    .from("notificacoes")
    .select("id, titulo, mensagem, link, usuario:profiles!notificacoes_user_id_fkey(telefone, ativo)")
    .eq("whatsapp_status", "pendente")
    .order("created_at")
    .limit(50);
  if (error) return NextResponse.json({ erro: error.message }, { status: 500 });

  let enviados = 0;
  let falhas = 0;
  for (const n of fila ?? []) {
    const para = n.usuario?.ativo ? telefoneE164(n.usuario.telefone) : null;
    if (!para) {
      await admin.from("notificacoes").update({ whatsapp_status: "ignorado", whatsapp_erro: "telefone inválido ou usuário inativo" }).eq("id", n.id);
      continue;
    }
    try {
      await enviarWhatsapp(para, n.titulo, n.mensagem ?? "", `${appUrl}${n.link ?? "/notificacoes"}`);
      await admin.from("notificacoes").update({ whatsapp_status: "enviado", whatsapp_enviado_em: new Date().toISOString(), whatsapp_erro: null }).eq("id", n.id);
      enviados++;
    } catch (e) {
      await admin.from("notificacoes").update({ whatsapp_status: "falhou", whatsapp_erro: String((e as Error).message).slice(0, 500) }).eq("id", n.id);
      falhas++;
    }
  }
  return NextResponse.json({ configurado: true, processados: fila?.length ?? 0, enviados, falhas });
}
