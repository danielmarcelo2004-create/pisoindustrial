-- Data de competência do pagamento e da Ordem de Pagamento.
-- Vem preenchida com a data do lançamento e pode ser alterada no cadastro e na edição.

alter table public.pagamentos add column if not exists data_competencia date;
alter table public.ordens_pagamento add column if not exists data_competencia date;

-- Registros existentes: competência = data do cadastro
update public.pagamentos set data_competencia = (created_at at time zone 'America/Sao_Paulo')::date where data_competencia is null;
update public.ordens_pagamento set data_competencia = (created_at at time zone 'America/Sao_Paulo')::date where data_competencia is null;

alter table public.pagamentos alter column data_competencia set default ((now() at time zone 'America/Sao_Paulo')::date);
alter table public.ordens_pagamento alter column data_competencia set default ((now() at time zone 'America/Sao_Paulo')::date);
alter table public.pagamentos alter column data_competencia set not null;
alter table public.ordens_pagamento alter column data_competencia set not null;

-- Pagamento criado a partir de uma OP herda a competência da OP.
create or replace function public._competencia_da_op()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.ordem_id is not null then
    select o.data_competencia into new.data_competencia from public.ordens_pagamento o where o.id = new.ordem_id;
  end if;
  if new.data_competencia is null then
    new.data_competencia := (now() at time zone 'America/Sao_Paulo')::date;
  end if;
  return new;
end
$$;

drop trigger if exists pagamentos_competencia_op on public.pagamentos;
create trigger pagamentos_competencia_op before insert on public.pagamentos
  for each row execute function public._competencia_da_op();

-- Define a competência de um pagamento ainda não pago nem cancelado (quem pode atuar na obra ou quem cadastrou).
create or replace function public.definir_competencia(p_pagamento_id uuid, p_data date)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
begin
  if p_data is null then
    raise exception 'Informe a data de competência.';
  end if;
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;
  if p.status in ('pago', 'cancelado') then
    raise exception 'Pagamento finalizado: a competência não pode mais ser alterada.';
  end if;
  if not (public.pode_atuar_obra(p.obra_id) or p.created_by = auth.uid()) then
    raise exception 'Sem permissão para alterar este pagamento.' using errcode = '42501';
  end if;
  update public.pagamentos set data_competencia = p_data where id = p_pagamento_id;
end
$$;

-- Define a competência da OP em rascunho (só quem solicitou).
create or replace function public.definir_competencia_op(p_ordem_id uuid, p_data date)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.ordens_pagamento;
begin
  if p_data is null then
    raise exception 'Informe a data de competência.';
  end if;
  select * into o from public.ordens_pagamento where id = p_ordem_id for update;
  if not found or o.solicitante_id <> auth.uid() then
    raise exception 'Solicitação não encontrada.';
  end if;
  if o.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  update public.ordens_pagamento set data_competencia = p_data where id = p_ordem_id;
end
$$;

revoke all on function public.definir_competencia(uuid, date) from public, anon;
revoke all on function public.definir_competencia_op(uuid, date) from public, anon;
grant execute on function public.definir_competencia(uuid, date) to authenticated;
grant execute on function public.definir_competencia_op(uuid, date) to authenticated;
