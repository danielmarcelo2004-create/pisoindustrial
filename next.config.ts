import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
