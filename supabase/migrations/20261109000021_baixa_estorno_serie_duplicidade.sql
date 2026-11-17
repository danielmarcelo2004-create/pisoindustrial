-- Ajustes vindos da comparação com sistemas do mercado:
-- * baixa com valor menor: a diferença vira saldo em aberto (padrão) ou desconto, à escolha de quem dá a baixa;
-- * estorno de baixa (pagamento inteiro ou parcela), com motivo e histórico;
-- * série de repetições: cancelar esta e as próximas / reajustar o valor das próximas;
-- * aviso de possível duplicidade (mesmo arquivo ou mesmo favorecido + valor + vencimento).

drop function if exists public.registrar_baixa(uuid, date, numeric, text);
create or replace function public.registrar_baixa(
  p_id uuid, p_pago_em date, p_valor_pago numeric default null, p_observacao text default null, p_diferenca text default 'saldo'
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_pago numeric(14, 2);
  v_saldo numeric(14, 2);
begin
  if not public.pode_baixar() then
    raise exception 'Somente o Financeiro ou o Administrador master registram a baixa de pagamentos.' using errcode = '42501';
  end if;
  if exists (select 1 from public.pagamento_parcelas where pagamento_id = p_id) then
    raise exception 'Este pagamento é parcelado: dê baixa em cada parcela.';
  end if;
  select * into p from public.pagamentos where id = p_id for update;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;
  if p.status <> 'aguardando_pagamento' then
    raise exception 'O pagamento nº % não está liberado para pagamento.', p.numero;
  end if;
  if p_pago_em is null then
    raise exception 'Informe a data do pagamento.';
  end if;
  v_pago := coalesce(p_valor_pago, p.valor);
  if v_pago <= 0 then
    raise exception 'O valor pago deve ser maior que zero.';
  end if;
  if coalesce(p_diferenca, 'saldo') not in ('saldo', 'desconto') then
    raise exception 'Informe se a diferença é saldo a pagar ou desconto.';
  end if;

  -- Pagou menos e a diferença é saldo: vira parcela 1 (paga) + parcela 2 (em aberto), e o pagamento continua a pagar.
  if v_pago < p.valor and coalesce(p_diferenca, 'saldo') = 'saldo' then
    v_saldo := p.valor - v_pago;
    insert into public.pagamento_parcelas (pagamento_id, numero, valor_base, vencimento, status, pago_em, valor_pago, pago_por, motivo)
    values (p.id, 1, v_pago, p.vencimento, 'pago', p_pago_em, v_pago, auth.uid(), 'Pagamento parcial');
    insert into public.pagamento_parcelas (pagamento_id, numero, valor_base, vencimento, status, motivo)
    values (p.id, 2, v_saldo, p.vencimento, 'a_pagar', 'Saldo do pagamento parcial');
    perform public._auditar('pagamento', p_id::text, 'baixa_parcela',
      'Pagamento parcial em ' || to_char(p_pago_em, 'DD/MM/YYYY') || ': pago R$ ' || to_char(v_pago, 'FM999G999G990D00')
        || ', saldo de R$ ' || to_char(v_saldo, 'FM999G999G990D00') || ' em aberto'
        || coalesce('. ' || nullif(trim(p_observacao), ''), ''),
      p.obra_id, p_id, null, jsonb_build_object('pago', v_pago, 'saldo', v_saldo));
    perform public._notificar(p.created_by, 'Pagamento parcial',
      'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ': pago R$ ' || to_char(v_pago, 'FM999G999G990D00')
        || '; saldo de R$ ' || to_char(v_saldo, 'FM999G999G990D00') || ' em aberto.',
      '/pagamentos/' || p.id, p.id);
    return;
  end if;

  update public.pagamentos
     set status = 'pago', pago_em = p_pago_em, valor_pago = v_pago, pago_por = auth.uid()
   where id = p_id;
  perform public._auditar('pagamento', p_id::text, 'baixa',
    'Pagamento registrado como pago em ' || to_char(p_pago_em, 'DD/MM/YYYY')
      || case when v_pago < p.valor then ' com desconto de R$ ' || to_char(p.valor - v_pago, 'FM999G999G990D00') else '' end
      || coalesce('. ' || nullif(trim(p_observacao), ''), ''),
    p.obra_id, p_id,
    jsonb_build_object('status', p.status),
    jsonb_build_object('status', 'pago', 'pago_em', p_pago_em, 'valor_pago', v_pago));
  perform public._notificar(p.created_by, 'Pagamento efetuado',
    'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ' foi pago em ' || to_char(p_pago_em, 'DD/MM/YYYY') || '.',
    '/pagamentos/' || p.id, p.id);
end
$$;

-- Estorno do pagamento (sem parcelas): volta para "a pagar".
create or replace function public.estornar_baixa(p_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
begin
  if not public.pode_baixar() then
    raise exception 'Somente o Financeiro ou o Administrador master estornam pagamentos.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'Informe o motivo do estorno.';
  end if;
  select * into p from public.pagamentos where id = p_id for update;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;
  if exists (select 1 from public.pagamento_parcelas where pagamento_id = p_id) then
    raise exception 'Este pagamento é parcelado: estorne a parcela.';
  end if;
  if p.status <> 'pago' then
    raise exception 'Só é possível estornar um pagamento pago.';
  end if;
  update public.pagamentos set status = 'aguardando_pagamento', pago_em = null, valor_pago = null, pago_por = null where id = p_id;
  perform public._auditar('pagamento', p_id::text, 'estorno',
    'Baixa estornada (estava paga em ' || to_char(p.pago_em, 'DD/MM/YYYY') || ', R$ ' || to_char(p.valor_pago, 'FM999G999G990D00') || '). Motivo: ' || trim(p_motivo),
    p.obra_id, p_id,
    jsonb_build_object('status', 'pago', 'pago_em', p.pago_em, 'valor_pago', p.valor_pago),
    jsonb_build_object('status', 'aguardando_pagamento'));
  perform public._notificar(p.created_by, 'Pagamento estornado',
    'A baixa do pagamento nº ' || p.numero || ' — ' || p.favorecido || ' foi estornada. Motivo: ' || trim(p_motivo),
    '/pagamentos/' || p.id, p.id);
end
$$;

-- Estorno de uma parcela paga: a parcela volta a "a pagar" e o pagamento volta a "aguardando pagamento".
create or replace function public.estornar_baixa_parcela(p_parcela_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pc public.pagamento_parcelas;
  p public.pagamentos;
begin
  if not public.pode_baixar() then
    raise exception 'Somente o Financeiro ou o Administrador master estornam pagamentos.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'Informe o motivo do estorno.';
  end if;
  select * into pc from public.pagamento_parcelas where id = p_parcela_id for update;
  if not found then
    raise exception 'Parcela não encontrada.';
  end if;
  if pc.status <> 'pago' then
    raise exception 'Só é possível estornar uma parcela paga.';
  end if;
  select * into p from public.pagamentos where id = pc.pagamento_id for update;
  update public.pagamento_parcelas set status = 'a_pagar', pago_em = null, valor_pago = null, pago_por = null where id = pc.id;
  if p.status = 'pago' then
    update public.pagamentos set status = 'aguardando_pagamento', pago_em = null, valor_pago = null, pago_por = null where id = p.id;
  end if;
  perform public._auditar('pagamento', p.id::text, 'estorno',
    'Parcela ' || pc.numero || ' estornada (estava paga em ' || to_char(pc.pago_em, 'DD/MM/YYYY') || ', R$ ' || to_char(pc.valor_pago, 'FM999G999G990D00') || '). Motivo: ' || trim(p_motivo),
    p.obra_id, p.id,
    jsonb_build_object('parcela', pc.numero, 'status', 'pago'),
    jsonb_build_object('parcela', pc.numero, 'status', 'a_pagar'));
end
$$;

-- Cancela as provisões em aberto de uma série (todas, ou a partir de uma data de vencimento).
create or replace function public.cancelar_serie(p_pagamento_id uuid, p_a_partir date default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_qtd integer;
begin
  select * into p from public.pagamentos where id = p_pagamento_id;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;
  if not (public.is_financeiro() or p.created_by = auth.uid()) then
    raise exception 'Somente quem cadastrou ou o Financeiro altera a série.' using errcode = '42501';
  end if;
  update public.provisoes set status = 'cancelada'
   where pagamento_origem_id = p.id and status = 'provisionada' and (p_a_partir is null or vencimento >= p_a_partir);
  get diagnostics v_qtd = row_count;
  if v_qtd > 0 then
    perform public._auditar('pagamento', p.id::text, 'cancelou', v_qtd || ' provisão(ões) da repetição canceladas', p.obra_id, p.id, null, null);
  end if;
  return v_qtd;
end
$$;

-- Aplica um novo valor às provisões em aberto da série.
create or replace function public.reajustar_serie(p_pagamento_id uuid, p_valor numeric)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_qtd integer;
begin
  if p_valor is null or p_valor <= 0 then
    raise exception 'Valor inválido.';
  end if;
  select * into p from public.pagamentos where id = p_pagamento_id;
  if not found then
    raise exception 'Pagamento não encontrado.';
  end if;
  if not (public.is_financeiro() or p.created_by = auth.uid()) then
    raise exception 'Somente quem cadastrou ou o Financeiro altera a série.' using errcode = '42501';
  end if;
  update public.provisoes set valor_estimado = p_valor where pagamento_origem_id = p.id and status = 'provisionada';
  get diagnostics v_qtd = row_count;
  if v_qtd > 0 then
    perform public._auditar('pagamento', p.id::text, 'alterou',
      'Novo valor R$ ' || to_char(p_valor, 'FM999G999G990D00') || ' aplicado a ' || v_qtd || ' provisão(ões) da repetição', p.obra_id, p.id, null, null);
  end if;
  return v_qtd;
end
$$;

-- Possível duplicidade: o mesmo arquivo já anexado ou mesmo favorecido + valor + vencimento (não bloqueia, só avisa).
create or replace function public.verificar_duplicidade(p_hashes text[], p_favorecido text, p_valor numeric, p_vencimento date)
returns table (pagamento_id uuid, numero integer, obra text, valor numeric, vencimento date, status public.status_pagamento, motivo text)
language sql stable security definer set search_path = ''
as $$
  select distinct on (p.id) p.id, p.numero, o.nome, p.valor, p.vencimento, p.status,
         case when exists (select 1 from public.documentos d where d.pagamento_id = p.id and d.ativo and d.sha256 = any (coalesce(p_hashes, '{}')))
              then 'mesmo arquivo de boleto/nota' else 'mesmo favorecido, valor e vencimento' end
    from public.pagamentos p
    join public.obras o on o.id = p.obra_id
   where p.status <> 'cancelado'
     and public.pode_ver_obra(p.obra_id)
     and (
       exists (select 1 from public.documentos d where d.pagamento_id = p.id and d.ativo and d.sha256 = any (coalesce(p_hashes, '{}')))
       or (p_favorecido is not null and lower(trim(p.favorecido)) = lower(trim(p_favorecido)) and p.valor = p_valor and p.vencimento = p_vencimento)
     )
   order by p.id
   limit 10
$$;

revoke all on function public.registrar_baixa(uuid, date, numeric, text, text) from public, anon;
revoke all on function public.estornar_baixa(uuid, text) from public, anon;
revoke all on function public.estornar_baixa_parcela(uuid, text) from public, anon;
revoke all on function public.cancelar_serie(uuid, date) from public, anon;
revoke all on function public.reajustar_serie(uuid, numeric) from public, anon;
revoke all on function public.verificar_duplicidade(text[], text, numeric, date) from public, anon;
grant execute on function public.registrar_baixa(uuid, date, numeric, text, text) to authenticated;
grant execute on function public.estornar_baixa(uuid, text) to authenticated;
grant execute on function public.estornar_baixa_parcela(uuid, text) to authenticated;
grant execute on function public.cancelar_serie(uuid, date) to authenticated;
grant execute on function public.reajustar_serie(uuid, numeric) to authenticated;
grant execute on function public.verificar_duplicidade(text[], text, numeric, date) to authenticated;
