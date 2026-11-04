# Gestão Financeira de Obras

Sistema web interno para centralizar a rotina financeira das obras: pagamentos e vencimentos, documentos (boletos, notas fiscais, comprovantes), aprovações e assinaturas eletrônicas por obra, notificações e histórico auditável.

> Nome, sigla e cores são **provisórios** (seção 13 da especificação). Para trocar, edite `src/lib/sistema.ts` (nome) e as variáveis `--marca-*` em `src/app/globals.css` (cores).

## O que já está pronto

| Módulo | Situação |
|---|---|
| Login individual, senha provisória e troca obrigatória no 1º acesso | ✅ |
| Perfis Financeiro, Suprimentos, Engenheiro e Administrador da obra | ✅ |
| Usuários e permissões (somente o Financeiro cria e concede acessos) | ✅ |
| Obras com fluxo A / B / C e responsáveis | ✅ |
| Fornecedores, com histórico de pagamentos | ✅ |
| Pagamentos: cadastro, anexos, edição com versões, cancelamento, reenvio, baixa e comprovante | ✅ |
| Aprovações e assinaturas eletrônicas (individual e em lote, com senha e hash de integridade) | ✅ |
| Painel com indicadores e pendências | ✅ |
| Agenda de pagamentos (calendário, vencidos, hoje e próximos, totais por data) | ✅ |
| Histórico de atividades / auditoria imutável | ✅ |
| Notificações internas (sino), com fila pronta para o WhatsApp | ✅ |
| Exportação dos pagamentos para planilha (CSV, abre no Excel) | ✅ |
| Solicitações de OP: itens, PDF numerado (modelo provisório), envio direto ao administrador, "Minhas solicitações" | ✅ |
| Relatórios por obra, fornecedor, mês e situação, com período por vencimento, pagamento ou cadastro; exportação para Excel | ✅ |
| Inteligência de Compras: leitura automática do XML da NF-e, lançamento manual de NF em PDF/imagem, comparação de preços, histórico, evolução mensal, comparação regional, alertas e Excel | ✅ |
| Lembretes diários (vencimentos e assinaturas pendentes) | ✅ (pg_cron, 07:30) |
| Alertas por WhatsApp (Cloud API da Meta) | ✅ pronto, falta configurar o número e o template |
| Leitura automática (OCR) de NF em PDF/imagem | ⏳ hoje é lançamento manual com conferência humana |
| Integração com o Conta Azul | ⏳ futura |

## Como a segurança funciona

- **Isolamento por obra no banco de dados.** Todas as tabelas usam *Row Level Security* (RLS) do PostgreSQL. Um engenheiro ou administrador só enxerga as obras em que é responsável ou foi vinculado, mesmo que altere o endereço da página ou chame a API diretamente. Os arquivos no Storage seguem a mesma regra.
- **Regras de negócio dentro do banco.** Pagamentos, documentos e assinaturas só mudam por funções (`criar_pagamento`, `decidir_aprovacao`, `registrar_baixa` etc.). Cada função confere a permissão, grava a auditoria e dispara as notificações na mesma transação. Ninguém grava direto nessas tabelas.
- **Assinatura eletrônica.** Exige confirmar que conferiu os documentos e redigitar a senha. Fica vinculada ao usuário, à **versão** do pagamento e ao **SHA-256** do conteúdo (dados mais o hash de cada arquivo), com data, hora, IP e navegador. A assinatura em lote gera um registro por documento e é atômica: se um item falhar, nenhum é assinado.
- **Nada é alterado em silêncio.** Mudar valor, vencimento, favorecido ou descrição, ou substituir um documento, gera nova versão. Se já havia assinatura, o fluxo recomeça. Os arquivos antigos ficam preservados.
- **Auditoria imutável.** Triggers impedem alterar ou apagar o histórico, inclusive com a chave administrativa.

> A validade jurídica da modalidade de assinatura deve ser confirmada com o jurídico da empresa (seção 6 da especificação).

## Fluxo de aprovação

```
Fluxo A:  Cadastro → Engenheiro assina → Administrador assina → Financeiro paga → Pago
Fluxo B:  Cadastro → Administrador assina → Financeiro paga → Pago
Fluxo C:  Cadastro → Financeiro paga → Pago
```

Rejeição em qualquer etapa → **Rejeitado**. Quem cadastrou corrige e **reenvia**, gerando nova versão. Se o Financeiro mudar o fluxo ou os responsáveis de uma obra, os pagamentos pendentes são reencaminhados automaticamente.

## Solicitações de OP

1. O engenheiro cria a solicitação (rascunho = **em elaboração**), com favorecido, CPF/CNPJ, itens, quantidades e valores.
2. Ao **enviar**, a OP recebe número único (`OP-AAAA-00001`), o PDF é gerado e anexado, e um pagamento é criado **direto para o administrador da obra**, sem passar por Suprimentos. Se a obra não tiver administrador, a OP vai ao Financeiro.
3. O status acompanha o andamento: **enviada → em análise** (quando o administrador abre) **→ aprovada / rejeitada → paga**. Uma OP rejeitada pode ser duplicada para correção.

O modelo do PDF é provisório (`src/lib/pdf-op.ts`). Os dados da empresa ficam em `src/lib/sistema.ts`.

## Inteligência de Compras

- Ao anexar o **XML da NF-e** como nota fiscal, os itens são lidos automaticamente: descrição, NCM, unidade, quantidade, preço, fornecedor/CNPJ e data. A obra liga cada item à cidade e à UF.
- Para NF em **PDF ou imagem**, o detalhe do pagamento oferece o **lançamento manual dos itens** (conferência humana).
- A mesma NF-e (pela chave de acesso) não entra duas vezes. Se o documento da NF for substituído, os itens antigos saem da análise.
- Alertas marcam preços mais de 15% acima da mediana do mesmo material e unidade (com no mínimo 3 compras). São **indicadores para análise**, não prova de sobrepreço.
- Acesso: Financeiro e Suprimentos.

## Alertas por WhatsApp

O WhatsApp é **só aviso**: a mensagem traz um link que exige login. Toda notificação de um usuário com telefone cadastrado entra numa fila. A rota `/api/cron/whatsapp` envia a fila pela Cloud API da Meta quando estas variáveis existem: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` e `WHATSAPP_TEMPLATE` (um template aprovado com 3 parâmetros: título, mensagem e link), além de `CRON_SECRET` e `APP_URL`.

O `vercel.json` agenda essa rota uma vez por dia (10h UTC), que é o limite do plano gratuito da Vercel. Para envios mais frequentes, use o plano Pro (ajuste o `schedule` para `*/10 * * * *`) ou chame a rota por outro agendador com o cabeçalho `Authorization: Bearer <CRON_SECRET>`.

## Tecnologia

- **Next.js 16** (App Router, Server Actions) + TypeScript + Tailwind CSS 4
- **Supabase**: PostgreSQL com RLS, autenticação e armazenamento de arquivos

## Rodar localmente

Pré-requisitos: Node.js 20+ e Docker.

```bash
npm install
npx supabase start            # sobe banco, autenticação e storage locais
npx supabase status -o env    # copie as chaves para o .env.local (veja .env.example)
npm run seed:demo             # (opcional) dados de demonstração
npm run dev                   # http://localhost:3000
```

Usuários de demonstração (senha `Demo-1234`): `financeiro@demo.local`, `suprimentos@demo.local`, `engenheiro@demo.local`, `administrador@demo.local`, `administrador2@demo.local`.

Testes:

```bash
npm run test:integracao   # regras do banco (RLS, fluxos, assinaturas, OP, NF, lembretes)
npm run test:nfe          # leitura de XML de NF-e
npm run test:e2e          # navegador, ponta a ponta (recria o banco local!)
```

Para o `test:e2e`, rode o sistema com `npm run build` e depois:
`CRON_SECRET=segredo-teste WHATSAPP_TOKEN=tok WHATSAPP_PHONE_NUMBER_ID=999 WHATSAPP_TEMPLATE=alerta WHATSAPP_API_URL=http://127.0.0.1:4555 APP_URL=http://127.0.0.1:3000 npm start`.
O teste simula a API do WhatsApp localmente.

Exemplo de XML de NF-e para testar a Inteligência de Compras: `tests/exemplos/nfe-exemplo-concreto.xml`.

## Colocar em produção

1. Crie um projeto em [supabase.com](https://supabase.com) (região São Paulo).
2. Aplique o banco: `npx supabase link --project-ref SEU_PROJETO` e depois `npx supabase db push`.
3. No painel do Supabase, em **Authentication → Sign In / Providers**, **desative "Allow new users to sign up"**. Usuários são criados somente pelo Financeiro, dentro do sistema.
4. Publique o Next.js (por exemplo, na Vercel) com as variáveis do `.env.example`. A `SUPABASE_SECRET_KEY` deve ficar **somente** no servidor.
5. Crie o primeiro usuário do Financeiro:
   ```bash
   npm run criar-admin -- financeiro@suaempresa.com.br "Nome Completo"
   ```
6. Entre com a senha provisória exibida, defina sua senha e cadastre obras e usuários.

Recomendado: ative os backups diários (point-in-time recovery) no Supabase e defina a política de retenção de documentos (seção 13).

## Estrutura

```
supabase/migrations/   banco: tabelas, RLS, funções de fluxo, auditoria, storage
src/app/(app)/         páginas do sistema (painel, agenda, pagamentos, aprovações…)
src/app/(publico)/     login
src/lib/               sessão, consultas, formatação pt-BR, upload de documentos
src/components/        componentes de interface
scripts/               criar-admin (1º usuário) e seed de demonstração
tests/                 testes de integração das regras do banco
```
