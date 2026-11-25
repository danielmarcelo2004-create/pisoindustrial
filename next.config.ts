import type { NextConfig } from "next";

// CSP só em modo "relatório" (Content-Security-Policy-Report-Only): o navegador aponta no console o que seria bloqueado,
// sem quebrar nada. Depois de uma semana sem avisos, troque para "Content-Security-Policy" e retire 'unsafe-inline'/'unsafe-eval'
// de script-src (o Next usa scripts embutidos; o ideal é trocar por nonce).
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseUrl}`.trim(),
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // pdf.js lê o texto das notas no servidor; precisa ser carregado direto do node_modules (worker interno).
  serverExternalPackages: ["pdfjs-dist"],
  // Sistema interno: todas as páginas dependem do usuário logado, então
  // usamos renderização dinâmica (sem Cache Components).
  experimental: {
    serverActions: {
      // Anexos (boletos, NFs, comprovantes) de até 25 MB cada.
      bodySizeLimit: "60mb",
    },
    proxyClientMaxBodySize: "60mb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          // Só vale em HTTPS (ignorado em http://localhost). Sem includeSubDomains/preload de propósito.
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
          { key: "Content-Security-Policy-Report-Only", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
