---
name: testes-cenarios-completos
description: Testes de cenário completo para o sistema financeiro de obras. Use quando pedirem para testar um fluxo (OP, pagamento, aprovação, assinatura, parcelas, anexos, fundos) ou "teste todas as possibilidades". Pensa por perfil que solicita, por estado, por mudança de valor, por rejeição e por permissão antes de escrever qualquer teste.
---

# Testes de cenário completo

Não teste só o caminho feliz. Antes de escrever ou rodar qualquer teste, monte a matriz do fluxo e cubra cada célula ou diga por que ela não se aplica.

## 1. Mapear os atores

Liste quem pode iniciar, aprovar, assinar, anexar, rejeitar, pagar e ver cada item. Para este sistema, os perfis são:

- `financeiro`, `suprimentos`: solicitam e anexam; não assinam.
- `engenheiro`: solicita, assina a própria OP na solicitação e assina cada anexo; aprova.
- `administrador`: assina e aprova; pode rejeitar.
- `administrador_master`: acesso amplo; confira a regra antes de assumir.
- Usuário sem vínculo com a obra: não deve ver nem agir.

Para cada ator, teste também a negativa: o que ele não pode fazer deve ser bloqueado no servidor, não só escondido na tela.

## 2. Mapear os estados e as transições

Desenhe os estados antes de testar (ex.: OP `em_elaboracao` → `enviada` → `em_analise` → `aprovada` → `paga`; pagamento `aguardando_engenheiro` → `aguardando_administrador` → `aguardando_pagamento` → `pago`, com `rejeitado` e `cancelado`). Para cada transição, teste:

- o caminho permitido;
- a transição fora de ordem (ex.: aprovar antes de assinar);
- a repetição (ex.: enviar duas vezes, assinar duas vezes).

## 3. Cenários obrigatórios em toda solicitação

- **Quem solicita:** rode o fluxo pelo financeiro, pelo suprimentos e pelo engenheiro, quando todos puderem. Os fluxos de assinatura e de aprovação mudam por perfil.
- **Obra:** com administrador (fluxo B/A) e sem administrador (fluxo C), se a regra existir. Confira também a obra de outro vínculo.
- **Valor:** alterar item, quantidade, desconto e parcelas antes do envio; depois do envio, a edição deve ser bloqueada. Confira que o total do pagamento bate com a soma dos itens menos o desconto.
- **Parcelas:** soma igual ao total; soma diferente bloqueia; vencimentos mensais; baixa parcial e total.
- **Assinatura:** assinar, alterar depois de assinar (deve invalidar), reassinar, enviar com assinatura inválida (deve bloquear).
- **Anexos:** anexar com e sem assinatura conforme o perfil; tipo de arquivo inválido; remover; substituir (histórico preservado).
- **Rejeição:** rejeitar em cada etapa; o solicitante vê o motivo; duplicar a OP rejeitada gera rascunho novo, com o histórico antigo preservado.
- **Cancelamento e exclusão:** o que pode ser excluído antes e depois do envio.
- **Dados obrigatórios:** favorecido, dados de pagamento, vencimento, obra, itens. Cada campo faltando deve gerar mensagem clara.
- **Permissão cruzada:** o perfil A tenta agir sobre o item do perfil B pela URL direta.
- **Repetição de envio/clique duplo:** não pode gerar dois pagamentos.

## 4. Como verificar

- Pela interface (Playwright) para o caminho do usuário, com captura de erros de página e de console.
- Pelo banco (`docker exec ... psql`) para confirmar status, valor, fluxo e parcelas, e não só o texto da tela.
- Pelo integração (`tests/integracao.test.mjs`) para regra de negócio e permissão no banco.
- Pelo e2e (`tests/e2e/rodar.sh`) para regressão do fluxo completo.

Ao escrever um teste novo, registre o perfil, o estado de partida, a ação e o estado esperado no nome do teste.

## 5. Relatório

Entregue uma matriz curta: cenário, resultado (passou, falhou, não aplicável com motivo) e evidência (status no banco, mensagem exata, arquivo gerado). Se algo falhar, diga o que foi observado e o que ainda não foi confirmado. Não corrija código sem o pedido explícito de correção.

## 6. Cuidados

- Use só o banco local. Não aplique migrações nem SQL em projetos remotos sem autorização explícita do usuário.
- Não exponha senhas, tokens ou dados pessoais reais nas saídas.
- Reset do banco local apaga os dados de teste; avise antes se houver dados que o usuário queira manter.
