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

## Telas

- **Nenhuma janela (`role="dialog"`) pode cortar conteúdo ou passar da tela**, no computador nem no celular. Toda janela nova ou alterada passa por `tests/e2e/janelas.cjs` (abre as janelas em cada perfil, em 1440px e 390px). Se a janela nova não aparece no teste, acrescente os dados para ela aparecer.
- Nada de rolagem lateral para ver informação: tabelas e cartões cabem na largura (conferir em 1280px e 390px).

## Fluxo de trabalho

- Commit, push, mudanças no banco de teste/produção e publicação só depois da aprovação do usuário.
