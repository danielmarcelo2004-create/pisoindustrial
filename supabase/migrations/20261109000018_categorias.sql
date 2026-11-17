-- Categorias de despesa (lista simples, sem grupos), gerenciadas pelo Financeiro e pelo administrador master.
create table if not exists public.categorias (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) > 0),
  ativo boolean not null default true,
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists categorias_nome_unico on public.categorias (lower(trim(nome)));

alter table public.categorias enable row level security;
drop policy if exists categorias_select on public.categorias;
create policy categorias_select on public.categorias for select to authenticated using (true);
revoke all on public.categorias from anon;
revoke insert, update, delete, truncate on public.categorias from authenticated;

alter table public.pagamentos add column if not exists categoria_id uuid references public.categorias (id);
alter table public.ordens_pagamento add column if not exists categoria_id uuid references public.categorias (id);

-- O pagamento criado a partir de uma OP herda a competência e a categoria da OP.
create or replace function public._competencia_da_op()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.ordem_id is not null then
    select o.data_competencia, coalesce(new.categoria_id, o.categoria_id)
      into new.data_competencia, new.categoria_id
      from public.ordens_pagamento o where o.id = new.ordem_id;
  end if;
  if new.data_competencia is null then
    new.data_competencia := (now() at time zone 'America/Sao_Paulo')::date;
  end if;
  return new;
end
$$;

-- Cria uma categoria (ou devolve a existente com o mesmo nome).
create or replace function public.criar_categoria(p_nome text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_nome text := trim(coalesce(p_nome, ''));
begin
  if public.meu_perfil() not in ('financeiro', 'administrador_master') then
    raise exception 'Somente o Financeiro cadastra categorias.' using errcode = '42501';
  end if;
  if v_nome = '' then
    raise exception 'Informe o nome da categoria.';
  end if;
  if length(v_nome) > 120 then
    raise exception 'O nome da categoria deve ter até 120 caracteres.';
  end if;
  select id into v_id from public.categorias where lower(trim(nome)) = lower(v_nome);
  if found then
    update public.categorias set ativo = true where id = v_id;
    return v_id;
  end if;
  insert into public.categorias (nome) values (v_nome) returning id into v_id;
  return v_id;
end
$$;

-- Renomeia e ativa/desativa uma categoria (desativada some da escolha, mas continua nos lançamentos antigos).
create or replace function public.atualizar_categoria(p_id uuid, p_nome text, p_ativo boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_nome text := trim(coalesce(p_nome, ''));
begin
  if public.meu_perfil() not in ('financeiro', 'administrador_master') then
    raise exception 'Somente o Financeiro altera categorias.' using errcode = '42501';
  end if;
  if v_nome = '' then
    raise exception 'Informe o nome da categoria.';
  end if;
  if exists (select 1 from public.categorias where lower(trim(nome)) = lower(v_nome) and id <> p_id) then
    raise exception 'Já existe uma categoria com esse nome.';
  end if;
  update public.categorias set nome = v_nome, ativo = coalesce(p_ativo, ativo) where id = p_id;
  if not found then
    raise exception 'Categoria não encontrada.';
  end if;
end
$$;

-- Define a categoria de um pagamento em aberto (quem atua na obra ou quem cadastrou).
create or replace function public.definir_categoria(p_pagamento_id uuid, p_categoria_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;
  if p.status in ('pago', 'cancelado') then
    raise exception 'Pagamento finalizado: a categoria não pode mais ser alterada.';
  end if;
  if not (public.pode_atuar_obra(p.obra_id) or p.created_by = auth.uid()) then
    raise exception 'Sem permissão para alterar este pagamento.' using errcode = '42501';
  end if;
  if p_categoria_id is not null and not exists (select 1 from public.categorias where id = p_categoria_id and ativo) then
    raise exception 'Categoria inválida.';
  end if;
  update public.pagamentos set categoria_id = p_categoria_id where id = p_pagamento_id;
end
$$;

-- Define a categoria da OP em rascunho (só quem solicitou).
create or replace function public.definir_categoria_op(p_ordem_id uuid, p_categoria_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.ordens_pagamento;
begin
  select * into o from public.ordens_pagamento where id = p_ordem_id for update;
  if not found or o.solicitante_id <> auth.uid() then
    raise exception 'Solicitação não encontrada.';
  end if;
  if o.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  if p_categoria_id is not null and not exists (select 1 from public.categorias where id = p_categoria_id and ativo) then
    raise exception 'Categoria inválida.';
  end if;
  update public.ordens_pagamento set categoria_id = p_categoria_id where id = p_ordem_id;
end
$$;

revoke all on function public.criar_categoria(text) from public, anon;
revoke all on function public.atualizar_categoria(uuid, text, boolean) from public, anon;
revoke all on function public.definir_categoria(uuid, uuid) from public, anon;
revoke all on function public.definir_categoria_op(uuid, uuid) from public, anon;
grant execute on function public.criar_categoria(text) to authenticated;
grant execute on function public.atualizar_categoria(uuid, text, boolean) to authenticated;
grant execute on function public.definir_categoria(uuid, uuid) to authenticated;
grant execute on function public.definir_categoria_op(uuid, uuid) to authenticated;
