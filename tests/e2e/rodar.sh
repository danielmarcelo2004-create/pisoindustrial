#!/usr/bin/env bash
# Testes de ponta a ponta no navegador (Playwright) contra o ambiente LOCAL.
# Pré-requisitos: `npx supabase start` e o sistema rodando em http://127.0.0.1:3000
# com as variáveis de teste do WhatsApp e do Resend (veja o README). Recria o banco local!
set -euo pipefail
cd "$(dirname "$0")/../.."
for t in nucleo modulos baixa-lote assinatura assinatura-fluxo assinatura-anexos assinatura-pagina assinatura-cadeia assinatura-substituicao fundos avisos-email notas-contabeis; do
  npx supabase db reset >/dev/null
  npm run seed:demo >/dev/null
  echo "== $t"
  node "tests/e2e/$t.cjs"
done
