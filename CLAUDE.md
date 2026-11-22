# Instruções do projeto

@AGENTS.md

## Testes

- **Toda correção de bug vem com um teste de regressão no repositório** (pasta `tests/`), escrito para falhar sem a correção e passar com ela. Coloque `regressão:` no nome do teste e descreva o bug em uma linha.
  - Funções sem banco (leitura de OFX, comprovantes, sugestões, cálculos): `tests/*.test.mts` (rodam com `npm run test:unit`).
  - Regras no banco (permissões, estados, valores, RPCs): `tests/integracao.test.mjs` (`npm run test:integracao`).
  - Telas (cliques, filtros, menus): `tests/e2e/*.cjs` (`npm run test:e2e`).
- Teste só no ambiente temporário não conta: ele se perde quando a sessão termina.
- Dados de teste são fictícios. Arquivos reais do usuário (extratos, comprovantes) não entram no repositório.
- Para testar um fluxo, siga a skill `testes-cenarios-completos` (todos os perfis, estados, valores e permissões).

## Fluxo de trabalho

- Commit, push, mudanças no banco de teste/produção e publicação só depois da aprovação do usuário.
