#!/usr/bin/env bash
# Rotina de antes de publicar em produção. Rode: npm run pre-producao
# Faz, nesta ordem: lint, tipos, testes unitários, build, banco local zerado + integração, testes de tela (e2e),
# e as personas (usuários simulados). No fim mostra o quadro e só sai com "0" se TUDO passou.
# Pré-requisito: Docker/Supabase local disponíveis (npx supabase start). Recria o banco LOCAL; nunca toca em produção.
# Opções:  --rapido  (pula e2e e personas; só lint, tipos, unit, build, integração)
cd "$(dirname "$0")/.."
RAPIDO=0; [ "${1:-}" = "--rapido" ] && RAPIDO=1
LOG=.pre-producao; mkdir -p "$LOG"
RES=()
etapa() { # etapa "nome" comando...
  local nome="$1"; shift
  echo "▶ $nome"
  if "$@" >"$LOG/$(echo "$nome" | tr ' /' '__').log" 2>&1; then RES+=("✔ $nome"); else RES+=("✘ $nome  (veja $LOG/$(echo "$nome" | tr ' /' '__').log)"); fi
}
export CRON_SECRET=segredo-teste

etapa "lint" npm run lint
etapa "tipos" npm run typecheck
etapa "testes unitários" npm run test:unit
etapa "build" npm run build

npx supabase start >/dev/null 2>&1 || true
etapa "banco zerado" bash scripts/reset-banco.sh
etapa "testes de integração (banco)" npm run test:integracao

if [ "$RAPIDO" = 0 ]; then
  # Servidor com as variáveis de teste (WhatsApp/e-mail falsos); fecha no fim
  fuser -k 3000/tcp >/dev/null 2>&1 || true
  WHATSAPP_TOKEN=tok WHATSAPP_PHONE_NUMBER_ID=999 WHATSAPP_TEMPLATE=alerta WHATSAPP_API_URL=http://127.0.0.1:4555 \
  APP_URL=http://127.0.0.1:3000 RESEND_API_KEY=re_teste EMAIL_FROM=avisos@teste.local RESEND_API_URL=http://127.0.0.1:4556 \
    nohup npx next start -p 3000 >"$LOG/servidor.log" 2>&1 &
  SERVIDOR=$!
  for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/login)" = 200 ] && break; sleep 1; done

  etapa "testes de tela (e2e)" bash tests/e2e/rodar.sh
  # Personas: um banco zerado, depois cada arquivo em sequência (dados com marca própria)
  etapa "banco zerado (personas)" bash scripts/reset-banco.sh
  FALHAS=0
  for f in tests/e2e/personas/*.cjs; do
    case "$f" in */_util.cjs) continue;; esac
    nome="persona $(basename "$f" .cjs)"
    echo "▶ $nome"
    if node "$f" >"$LOG/$(basename "$f").log" 2>&1; then RES+=("✔ $nome"); else RES+=("✘ $nome  (veja $LOG/$(basename "$f").log)"); FALHAS=1; fi
  done
  kill "$SERVIDOR" >/dev/null 2>&1 || true
fi

echo; echo "════════ RESULTADO PRÉ-PRODUÇÃO ════════"
printf '%s\n' "${RES[@]}"
if printf '%s\n' "${RES[@]}" | grep -q '^✘'; then
  echo; echo "NÃO PUBLIQUE: há falhas acima."; exit 1
fi
echo; echo "Tudo passou. Antes de publicar, confira à mão: (1) migrations novas aplicadas no banco de produção ANTES do código;"
echo "(2) backup recente do banco; (3) a branch certa está selecionada."
