import "server-only";

/**
 * Envio de alertas pelo WhatsApp Business (Cloud API da Meta), somente como
 * canal de AVISO: a mensagem traz um link que exige login no sistema.
 * Nada é aprovado ou assinado pelo WhatsApp.
 *
 * Variáveis de ambiente:
 *   WHATSAPP_TOKEN            token de acesso permanente
 *   WHATSAPP_PHONE_NUMBER_ID  ID do número remetente
 *   WHATSAPP_TEMPLATE         nome do template aprovado (3 parâmetros: título, mensagem, link)
 *   WHATSAPP_TEMPLATE_LANG    idioma do template (padrão pt_BR)
 *   WHATSAPP_API_URL          (opcional) base da API, padrão https://graph.facebook.com/v21.0
 *   APP_URL                   endereço público do sistema (para montar o link)
 */
export function whatsappConfigurado() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_TEMPLATE);
}

/** Telefone brasileiro → formato internacional só com dígitos (ex.: 5571999990000). */
export function telefoneE164(tel: string | null | undefined): string | null {
  let d = (tel ?? "").replace(/\D/g, "");
  if (d.startsWith("0")) d = d.replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return /^55\d{10,11}$/.test(d) ? d : null;
}

const limitar = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export async function enviarWhatsapp(para: string, titulo: string, mensagem: string, link: string) {
  const base = process.env.WHATSAPP_API_URL ?? "https://graph.facebook.com/v21.0";
  const resp = await fetch(`${base}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "template",
      template: {
        name: process.env.WHATSAPP_TEMPLATE,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG ?? "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: limitar(titulo, 60) },
              { type: "text", text: limitar(mensagem.replace(/\s+/g, " "), 500) },
              { type: "text", text: link },
            ],
          },
        ],
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const corpo = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${corpo.slice(0, 300)}`);
  }
}
