-- Lançar uma provisão: a despesa criada a partir dela (boleto ou Ordem de Pagamento) marca a provisão como
-- lançada e fica ligada a ela. Antes, a provisão continuava "provisionada" ao lado da despesa até alguém
-- clicar em "Marcar como lançada".

alter table public.provisoes add column if not exists pagamento_id uuid references public.pagamentos (id);
alter table public.ordens_pagamento add column if not exists provisao_id uuid references public.provisoes (id);

-- Quem pode agir na provisão: Financeiro em todas; Suprimentos nas que cadastrou (mesma regra da tela).
create or replace function public._pode_agir_provisao(p public.provisoes)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.meu_perfil() = 'financeiro' or (public.meu_perfil() = 'suprimentos' and p.created_by = auth.uid())
$$;

create or replace function public._converter_provisao(p_provisao_id uuid, p_pagamento_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pr public.provisoes;
  pg public.pagamentos;
begin
  select * into pr from public.provisoes where id = p_provisao_id for update;
  if not found then raise exception 'Provisão não encontrada.'; end if;
  if pr.status <> 'provisionada' then raise exception 'Esta provisão já foi lançada ou cancelada.'; end if;
  select * into pg from public.pagamentos where id = p_pagamento_id;
  if not found then raise exception 'Despesa não encontrada.'; end if;
  if pg.obra_id <> pr.obra_id then raise exception 'A despesa é de outro centro de custo que a provisão.'; end if;
  update public.provisoes set status = 'convertida', pagamento_id = pg.id where id = pr.id;
  perform public._auditar('provisao', pr.id::text, 'lancou',
    'Provisão "' || pr.descricao || '" lançada como despesa nº ' || pg.numero || ' (R$ ' || public._brl(pg.valor) || ')', pr.obra_id, pg.id);
end
$$;
revoke all on function public._converter_provisao(uuid, uuid) from public, anon, authenticated;

-- Despesa com boleto criada a partir da provisão (chamada logo depois de criar_pagamento).
create or replace function public.lancar_provisao(p_provisao_id uuid, p_pagamento_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pr public.provisoes;
begin
  select * into pr from public.provisoes where id = p_provisao_id;
  if not found then raise exception 'Provisão não encontrada.'; end if;
  if not public._pode_agir_provisao(pr) then
    raise exception 'Somente o Financeiro (ou o Suprimentos que cadastrou a provisão) lança a provisão.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.pagamentos where id = p_pagamento_id and (created_by = auth.uid() or public.meu_perfil() = 'financeiro')) then
    raise exception 'Despesa não encontrada.';
  end if;
  perform public._converter_provisao(p_provisao_id, p_pagamento_id);
end
$$;
revoke all on function public.lancar_provisao(uuid, uuid) from public, anon;
grant execute on function public.lancar_provisao(uuid, uuid) to authenticated;

-- Ordem de Pagamento criada a partir da provisão: guarda a provisão no rascunho; ao enviar, o pagamento a lança.
create or replace function public.definir_provisao_op(p_ordem_id uuid, p_provisao_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.ordens_pagamento;
  pr public.provisoes;
begin
  select * into o from public.ordens_pagamento where id = p_ordem_id for update;
  if not found or o.solicitante_id <> auth.uid() then raise exception 'Solicitação não encontrada.'; end if;
  if o.status <> 'em_elaboracao' then raise exception 'Esta solicitação já foi enviada.'; end if;
  if p_provisao_id is not null then
    select * into pr from public.provisoes where id = p_provisao_id;
    if not found or pr.status <> 'provisionada' then raise exception 'Esta provisão já foi lançada ou cancelada.'; end if;
    if not public._pode_agir_provisao(pr) then raise exception 'Você não pode lançar esta provisão.' using errcode = '42501'; end if;
    if pr.obra_id <> o.obra_id then raise exception 'A provisão é de outro centro de custo.'; end if;
  end if;
  update public.ordens_pagamento set provisao_id = p_provisao_id where id = o.id;
end
$$;
revoke all on function public.definir_provisao_op(uuid, uuid) from public, anon;
grant execute on function public.definir_provisao_op(uuid, uuid) to authenticated;

create or replace function public._provisao_da_op()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_prov uuid;
begin
  if new.ordem_id is not null then
    select provisao_id into v_prov from public.ordens_pagamento where id = new.ordem_id;
    if v_prov is not null and exists (select 1 from public.provisoes where id = v_prov and status = 'provisionada' and obra_id = new.obra_id) then
      perform public._converter_provisao(v_prov, new.id);
    end if;
  end if;
  return null;
end
$$;
drop trigger if exists pagamentos_provisao_da_op on public.pagamentos;
create trigger pagamentos_provisao_da_op after insert on public.pagamentos
  for each row execute function public._provisao_da_op();
