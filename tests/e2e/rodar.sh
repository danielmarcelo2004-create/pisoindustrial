#!/usr/bin/env bash
# Testes de ponta a ponta no navegador (Playwright) contra o ambiente LOCAL.
# Pré-requisitos: `npx supabase start` e o sistema rodando em http://127.0.0.1:3000
# com as variáveis de teste do WhatsApp e do Resend (veja o README). Recria o banco local!
set -uo pipefail
cd "$(dirname "$0")/../.."
FALHAS=()
for t in nucleo modulos baixa-lote assinatura assinatura-fluxo assinatura-anexos assinatura-pagina assinatura-cadeia assinatura-substituicao fundos avisos-email notas-contabeis funcoes-apoio regressoes conciliacao-lancamento conciliacao-receber fluxo-provisao persona-financeiro medicao-receita compras-notas janelas conciliacao-ajuste excluir-lancamento relatorios situacao-pago importacao-lote op-pdf-pendente lista-sem-rolagem exportacao; do
  if [ -n "${PROGRESSO:-}" ] && grep -qxF "ok:tela $t" "$PROGRESSO" 2>/dev/null; then echo "== $t (já passou)"; continue; fi
  echo "== $t"
  if ! bash scripts/reset-banco.sh; then FALHAS+=("$t (banco)"); continue; fi
  if node "tests/e2e/$t.cjs"; then [ -n "${PROGRESSO:-}" ] && echo "ok:tela $t" >> "$PROGRESSO"; else FALHAS+=("$t"); fi
done
echo
if [ ${#FALHAS[@]} -gt 0 ]; then
  echo "TESTES DE TELA COM FALHA: ${FALHAS[*]}"
  exit 1
fi
echo "TESTES DE TELA: todos passaram"
