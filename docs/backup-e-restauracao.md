# Backup e restauração

## O que precisa de backup
1. **Banco (Supabase Postgres)**: pagamentos, documentos (metadados), conciliação, auditoria, usuários.
2. **Arquivos (Supabase Storage)**: boletos, notas, comprovantes, assinaturas e OPs em PDF.

## Rotina recomendada
- **Banco**: ative os backups diários do projeto no painel Supabase (Database → Backups). Em plano sem backup diário, rode toda noite
  `supabase db dump --db-url "$DATABASE_URL" -f backup-$(date +%F).sql` e guarde o arquivo fora do Supabase (outro provedor de nuvem).
- **Arquivos**: uma vez por semana, copie os buckets (`supabase storage cp -r ss:///<bucket> ./backup-arquivos/<bucket>`) para o mesmo destino externo.
- Guarde as cópias por pelo menos 30 dias e mantenha o acesso a elas separado do acesso ao Supabase.

## Teste de restauração (faça a cada trimestre)
1. Crie um projeto Supabase novo e vazio (nunca restaure por cima da produção para testar).
2. `psql "$DATABASE_URL_NOVO" -f backup-AAAA-MM-DD.sql`
3. Copie os arquivos de volta para os buckets de mesmo nome.
4. Aponte uma cópia do sistema para o projeto novo, entre com um usuário Financeiro e confira: lista de Contas a pagar, abertura de um PDF anexado e a conciliação de uma conta.
5. Anote a data do teste e o tempo que levou.

## Arquivos órfãos
Anexos enviados pelo navegador cujo cadastro falhou podem ficar sem vínculo. A função `arquivos_orfaos(p_dias)` lista os arquivos sem registro; revise a lista antes de apagar qualquer coisa.

## Proteção da branch (configurar no GitHub)
Em Settings → Branches, proteger a branch principal: exigir pull request, exigir o check "CI / verificar" aprovado e bloquear push direto.
