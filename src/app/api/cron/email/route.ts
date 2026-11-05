import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { enviarEmail, emailConfigurado } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase/server";

/** Envia a fila de avisos por e-mail. Chamado pelo agendador com "Authorization: Bearer <CRON_SECRET>". */
export async function GET(request: NextRequest) {
  const segredo = process.env.CRON_SECRET;
  const recebido = request.headers.get("authorization") ?? "";
  const esperado = `Bearer ${segredo}`;
  if (!segredo || recebido.length !== esperado.length || !timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) {
    return NextResponse.json({ erro: "não autorizado" }, { status: 401 });
  }
  if (!emailConfigurado()) {
    return NextResponse.json({ configurado: false, mensagem: "RESEND_API_KEY não definida; avisos continuam na fila." });
  }
  const admin = createAdminClient();
  const limite = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  await admin.from("notificacoes").update({ email_status: "ignorado", email_erro: "expirado" }).eq("email_status", "pendente").lt("created_at", limite);

  const { data: fila, error } = await admin
    .from("notificacoes")
    .select("id, titulo, mensagem, link, usuario:profiles!notificacoes_user_id_fkey(email, ativo)")
    .eq("email_status", "pendente")
    .order("created_at")
    .limit(100);
  if (error) return NextResponse.json({ erro: error.message }, { status: 500 });

  let enviados = 0;
  let falhas = 0;
  for (const n of fila ?? []) {
    const para = n.usuario?.ativo ? n.usuario.email : null;
    if (!para) {
      await admin.from("notificacoes").update({ email_status: "ignorado", email_erro: "usuário inativo ou sem e-mail" }).eq("id", n.id);
      continue;
    }
    try {
      await enviarEmail(para, n.titulo, n.mensagem ?? "", n.link ?? "/notificacoes");
      await admin.from("notificacoes").update({ email_status: "enviado", email_enviado_em: new Date().toISOString(), email_erro: null }).eq("id", n.id);
      enviados++;
    } catch (e) {
      await admin.from("notificacoes").update({ email_status: "falhou", email_erro: String((e as Error).message).slice(0, 500) }).eq("id", n.id);
      falhas++;
    }
  }
  return NextResponse.json({ configurado: true, processados: fila?.length ?? 0, enviados, falhas });
}
