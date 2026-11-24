-- "Excluir lançamento" com escopo (como no Conta Azul):
--   'atual'        só o lançamento atual
--   'nao_vencidos' o atual e os irmãos que ainda não venceram e não têm baixa
--   'em_aberto'    o atual e os irmãos em aberto (vencidos + a vencer) sem baixa
--   'todos'        todos os irmãos, inclusive os pagos (a baixa é estornada e a conciliação desfeita)
-- Irmãos: as parcelas da mesma despesa; ou, sem parcelas, a série de repetição (a despesa de origem, as despesas
-- lançadas a partir das provisões da série e as provisões em aberto).
-- Parcela excluída sai da despesa (as que ficam são renumeradas) e o total da despesa diminui.

create or replace function public._excluir_parcela(p_parcela_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pc public.pagamento_parcelas;
  p public.pagamentos;
  v_total int;
  v_pagas int;
begin
  select * into pc from public.pagamento_parcelas where id = p_parcela_id for update;
  if not found then return; end if;
  select * into p from public.pagamentos where id = pc.pagamento_id for update;
  if not public.pode_atuar_obra(p.obra_id) then
    raise exception 'Você não tem permissão para excluir lançamentos desta obra.' using errcode = '42501';
  end if;
  if pc.status = 'pago' then
    perform public.estornar_baixa_parcela(pc.id, 'Exclusão do lançamento: ' || trim(p_motivo));
  end if;
  -- (o estorno já desfaz a conciliação pelo gatilho; aqui só sobra o vínculo, se houver)
  delete from public.conciliacao_itens where parcela_id = pc.id;
  delete from public.pagamento_parcelas where id = pc.id;
  select count(*), count(*) filter (where status = 'pago') into v_total, v_pagas from public.pagamento_parcelas where pagamento_id = p.id;
  if v_total = 0 then
    update public.pagamentos set status = 'cancelado', cancelamento_motivo = trim(p_motivo) where id = p.id;
  else
    -- renumera e ajusta o total da despesa
    -- (em dois passos para não colidir com o unique (pagamento_id, numero))
    update public.pagamento_parcelas set numero = numero + 100000 where pagamento_id = p.id;
    update public.pagamento_parcelas x set numero = r.n
      from (select id, row_number() over (order by numero) n from public.pagamento_parcelas where pagamento_id = p.id) r
     where x.id = r.id;
    update public.pagamentos set valor = (select sum(valor_base) from public.pagamento_parcelas where pagamento_id = p.id) where id = p.id;
    if v_pagas = v_total and (select status from public.pagamentos where id = p.id) = 'aguardando_pagamento' then
      update public.pagamentos
         set status = 'pago',
             pago_em = (select max(pago_em) from public.pagamento_parcelas where pagamento_id = p.id),
             valor_pago = (select sum(valor_pago) from public.pagamento_parcelas where pagamento_id = p.id)
       where id = p.id;
    end if;
  end if;
  perform public._auditar('pagamento', p.id::text, 'excluiu_parcela',
    'Parcela ' || pc.numero || ' (R$ ' || public._brl(pc.valor_base) || ', vence em ' || to_char(pc.vencimento, 'DD/MM/YYYY') || ') excluída. Motivo: ' || trim(p_motivo),
    p.obra_id, p.id);
end
$$;
revoke all on function public._excluir_parcela(uuid, text) from public, anon, authenticated;

create or replace function public._excluir_pagamento(p_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
begin
  select * into p from public.pagamentos where id = p_id for update;
  if not found or p.status = 'cancelado' then return; end if;
  if p.status = 'pago' then
    perform public.estornar_baixa(p.id, 'Exclusão do lançamento: ' || trim(p_motivo));
  end if;
  perform public.cancelar_pagamento(p.id, trim(p_motivo));
end
$$;
revoke all on function public._excluir_pagamento(uuid, text) from public, anon, authenticated;

create or replace function public.excluir_lancamentos(p_pagamento_id uuid, p_parcela_id uuid, p_escopo text, p_motivo text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_raiz uuid;
  v_pag int := 0;
  v_parc int := 0;
  v_prov int := 0;
  r record;
begin
  if p_escopo not in ('atual', 'nao_vencidos', 'em_aberto', 'todos') then raise exception 'Escolha quais lançamentos excluir.'; end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Informe o motivo.'; end if;
  select * into p from public.pagamentos where id = p_pagamento_id;
  if not found or not public.pode_ver_obra(p.obra_id) then raise exception 'Lançamento não encontrado.'; end if;
  if not public.pode_atuar_obra(p.obra_id) then
    raise exception 'Você não tem permissão para excluir lançamentos desta obra.' using errcode = '42501';
  end if;

  if exists (select 1 from public.pagamento_parcelas where pagamento_id = p.id) then
    -- Despesa parcelada: os irmãos são as parcelas
    for r in
      select pc.id from public.pagamento_parcelas pc
       where pc.pagamento_id = p.id
         and (pc.id = p_parcela_id
              or (p_escopo = 'nao_vencidos' and pc.status <> 'pago' and pc.vencimento >= v_hoje)
              or (p_escopo = 'em_aberto' and pc.status <> 'pago')
              or p_escopo = 'todos')
       order by pc.numero desc
    loop
      perform public._excluir_parcela(r.id, p_motivo);
      v_parc := v_parc + 1;
    end loop;
  else
    -- Série de repetição (ou lançamento avulso): despesa de origem + despesas lançadas das provisões + provisões em aberto
    v_raiz := coalesce((select pagamento_origem_id from public.provisoes where pagamento_id = p.id limit 1), p.id);
    for r in
      select x.id from public.pagamentos x
       where x.status <> 'cancelado'
         and (x.id = p.id
              or (p_escopo <> 'atual' and (x.id = v_raiz or x.id in (select pagamento_id from public.provisoes where pagamento_origem_id = v_raiz and pagamento_id is not null))
                  and (p_escopo = 'todos'
                       or (x.status <> 'pago' and (p_escopo = 'em_aberto' or x.vencimento >= v_hoje)))))
    loop
      perform public._excluir_pagamento(r.id, p_motivo);
      v_pag := v_pag + 1;
    end loop;
    if p_escopo <> 'atual' then
      update public.provisoes set status = 'cancelada'
       where pagamento_origem_id = v_raiz and status = 'provisionada'
         and (p_escopo <> 'nao_vencidos' or vencimento is null or vencimento >= v_hoje);
      get diagnostics v_prov = row_count;
    end if;
  end if;

  perform public._auditar('pagamento', p.id::text, 'excluiu',
    'Exclusão de lançamentos (' || case p_escopo when 'atual' then 'somente o atual' when 'nao_vencidos' then 'atual e não vencidos sem baixa'
      when 'em_aberto' then 'atual e em aberto sem baixa' else 'todos' end || '): ' || v_pag || ' despesa(s), ' || v_parc || ' parcela(s), ' || v_prov
      || ' provisão(ões). Motivo: ' || trim(p_motivo), p.obra_id, p.id);
  return jsonb_build_object('pagamentos', v_pag, 'parcelas', v_parc, 'provisoes', v_prov);
end
$$;
revoke all on function public.excluir_lancamentos(uuid, uuid, text, text) from public, anon;
grant execute on function public.excluir_lancamentos(uuid, uuid, text, text) to authenticated;
