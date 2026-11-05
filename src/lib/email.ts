import "server-only";

/**
 * Envio de e-mail pelo Resend (API HTTP).
 * Variáveis: RESEND_API_KEY (obrigatória para enviar), EMAIL_FROM (remetente verificado no Resend),
 * RESEND_API_URL (opcional, para testes), APP_URL (endereço do sistema para o link).
 */
export function emailConfigurado() {
  return Boolean(process.env.RESEND_API_KEY);
}

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function enviarEmail(para: string, assunto: string, mensagem: string, link: string) {
  const base = process.env.RESEND_API_URL ?? "https://api.resend.com";
  const url = `${(process.env.APP_URL ?? "").replace(/\/$/, "")}${link}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b2533">
    <p>${escapar(mensagem)}</p>
    <p><a href="${escapar(url)}" style="display:inline-block;background:#1f3a5a;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir no sistema</a></p>
    <p style="font-size:12px;color:#64748b">Aviso automático do sistema de gestão de obras. Para assinar ou aprovar, entre no sistema.</p>
  </div>`;
  const resp = await fetch(`${base}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM ?? "Gestão Financeira de Obras <onboarding@resend.dev>",
      to: [para],
      subject: assunto,
      html,
      text: `${mensagem}\n\n${url}`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  }
}
