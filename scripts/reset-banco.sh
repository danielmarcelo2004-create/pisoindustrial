#!/usr/bin/env bash
# Zera o banco LOCAL e popula a demonstração. Depois do reset o Supabase reinicia os contêineres: espera a API voltar e
# repete o povoamento se ela ainda não estiver pronta (sem isso, o primeiro acesso logo após o reset falhava de vez em quando).
cd "$(dirname "$0")/.."
npx supabase db reset >/dev/null 2>&1 || { echo "falha no db reset" >&2; exit 1; }
for i in $(seq 1 40); do
  c=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:54321/rest/v1/ 2>/dev/null)
  [ "$c" != "503" ] && [ "$c" != "000" ] && break
  sleep 2
done
for t in 1 2 3 4 5 6; do
  if npm run seed:demo >/dev/null 2>&1; then exit 0; fi
  sleep 5
  # um povoamento que falhou no meio deixa dados pela metade: recomeça do zero
  npx supabase db reset >/dev/null 2>&1
  sleep 6
done
echo "não foi possível popular a demonstração" >&2
exit 1
