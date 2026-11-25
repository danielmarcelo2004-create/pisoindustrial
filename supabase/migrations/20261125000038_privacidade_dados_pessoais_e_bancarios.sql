-- Privacidade de dados pessoais e bancários (auditoria A-01, A-02 e A-03).
--
-- Antes, qualquer usuário logado lia, falando direto com a API, o e-mail e o telefone de todos os perfis, os
-- dados fiscais e bancários de todos os fornecedores e a agência/conta da empresa. Esconder o menu não bastava.
--
-- Agora as colunas sensíveis só saem pelas "visões" abaixo, que devolvem linhas apenas para quem precisa:
--   profiles_completo        e-mail e telefone: o próprio usuário e o Financeiro
--   fornecedores_dados       CPF/CNPJ, contatos, PIX, banco, agência, conta: Financeiro, Suprimentos e Administrador master
--   contas_bancarias_dados   banco, agência e conta da empresa: Financeiro e Administrador master
-- As tabelas continuam liberadas só nas colunas de identificação (nome, situação, etc.), o que mantém os nomes
-- que aparecem nas telas (responsável, favorecido, "cadastrado por").

-- 1) profiles
revoke select on public.profiles from authenticated;
grant select (id, nome, perfil, ativo, troca_senha_pendente, assinatura_path, created_at, updated_at) on public.profiles to authenticated;

create view public.profiles_completo as
  select id, nome, email, telefone, perfil, ativo, troca_senha_pendente, assinatura_path, created_at, updated_at
    from public.profiles
   where id = auth.uid() or public.is_financeiro();
revoke all on public.profiles_completo from public, anon, authenticated;
grant select on public.profiles_completo to authenticated;

-- 2) fornecedores
revoke select on public.fornecedores from authenticated;
grant select (id, nome, cidade, uf, ativo, created_by, created_at, updated_at) on public.fornecedores to authenticated;

create view public.fornecedores_dados as
  select id, nome, cpf_cnpj, email, telefone, cidade, uf, chave_pix, banco, agencia, conta, observacoes, ativo, created_by, created_at, updated_at
    from public.fornecedores
   where public.meu_perfil() in ('financeiro', 'suprimentos', 'administrador_master');
revoke all on public.fornecedores_dados from public, anon, authenticated;
grant select on public.fornecedores_dados to authenticated;

-- 3) contas bancárias da empresa: a lista de escolha (nome) continua para todos; número só para quem concilia
revoke select (banco, agencia, conta) on public.contas_bancarias from authenticated;

create view public.contas_bancarias_dados as
  select id, nome, banco, agencia, conta, ativa, tipo, created_at
    from public.contas_bancarias
   where public.meu_perfil() in ('financeiro', 'administrador_master');
revoke all on public.contas_bancarias_dados from public, anon, authenticated;
grant select on public.contas_bancarias_dados to authenticated;
