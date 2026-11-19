-- Editar parcela (uma) e editar o lançamento inteiro (todas as parcelas em aberto) a partir das Ações.
-- Parcelas pagas não mudam. Se a soma mudar, o valor do pagamento acompanha:
-- em aprovação, gera nova versão (as assinaturas recomeçam); liberado, exige motivo e avisa o Financeiro.

-- Valor em reais no formato brasileiro (1.234,56), independente do idioma do servidor.
create or replace function public._brl(v numeric)
returns text
language sql immutable set search_path = ''
as $$ select translate(to_char(v, 'FM999,999,999,990.00'), ',.', '.,') $$;
revoke all on function public._brl(numeric) from public, anon, authenticated;

-- Avisa quem assinou (aprovou) o lançamento, menos quem fez a alteração.
create or replace function public._notificar_aprovadores(p_pagamento_id uuid, p_titulo text, p_mensagem text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
begin
  for v_user in
    select distinct a.user_id from public.assinaturas a
     where a.pagamento_id = p_pagamento_id and a.decisao = 'aprovado' and a.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  loop
    perform public._notificar(v_user, p_titulo, p_mensagem, '/pagamentos/' || p_pagamento_id, p_pagamento_id);
  end loop;
end
$$;
revoke all on function public._notificar_aprovadores(uuid, text, text) from public, anon, authenticated;

create or replace function public.editar_parcelas(p_pagamento_id uuid, p_parcelas jsonb, p_motivo text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_item jsonb;
  pc public.pagamento_parcelas;
  v_valor numeric(14, 2);
  v_venc date;
  v_total numeric(14, 2);
  v_antes jsonb := '[]'::jsonb;
  v_depois jsonb := '[]'::jsonb;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  if not (public.is_financeiro() or (p.created_by = auth.uid() and public.pode_atuar_obra(p.obra_id))) then
    raise exception 'Somente o Financeiro ou quem cadastrou altera as parcelas.' using errcode = '42501';
  end if;
  if p.status in ('pago', 'cancelado') then
    raise exception 'Pagamentos pagos ou cancelados não podem ter as parcelas alteradas.';
  end if;
  if p_parcelas is null or jsonb_typeof(p_parcelas) <> 'array' or jsonb_array_length(p_parcelas) = 0 then
    raise exception 'Informe as parcelas.';
  end if;

  for v_item in select * from jsonb_array_elements(p_parcelas) loop
    select * into pc from public.pagamento_parcelas where id = nullif(v_item ->> 'id', '')::uuid and pagamento_id = p.id for update;
    if not found then
      raise exception 'Parcela não encontrada neste pagamento.';
    end if;
    if pc.status = 'pago' then
      raise exception 'A parcela % já está paga e não pode ser alterada.', pc.numero;
    end if;
    v_valor := round((v_item ->> 'valor')::numeric, 2);
    v_venc := nullif(v_item ->> 'vencimento', '')::date;
    if v_valor is null or v_valor <= 0 then
      raise exception 'Parcela %: informe o valor.', pc.numero;
    end if;
    if v_venc is null then
      raise exception 'Parcela %: informe o vencimento.', pc.numero;
    end if;
    if v_valor <> pc.valor_base or v_venc <> pc.vencimento then
      v_antes := v_antes || jsonb_build_object('parcela', pc.numero, 'valor', pc.valor_base, 'vencimento', pc.vencimento);
      v_depois := v_depois || jsonb_build_object('parcela', pc.numero, 'valor', v_valor, 'vencimento', v_venc);
      update public.pagamento_parcelas set valor_base = v_valor, vencimento = v_venc where id = pc.id;
    end if;
  end loop;

  if jsonb_array_length(v_depois) = 0 then
    return; -- nada mudou
  end if;

  select sum(valor_base) into v_total from public.pagamento_parcelas where pagamento_id = p.id;
  if v_total <> p.valor and nullif(trim(p_motivo), '') is null then
    raise exception 'O valor total muda de R$ % para R$ %: informe o motivo.', p.valor, v_total;
  end if;
  update public.pagamentos
     set valor = v_total,
         vencimento = (select min(vencimento) from public.pagamento_parcelas where pagamento_id = p.id)
   where id = p.id;

  perform public._auditar('pagamento', p.id::text, 'alterou',
    'Parcelas alteradas' || case when v_total <> p.valor then ' (total de R$ ' || to_char(p.valor, 'FM999G999G990D00') || ' para R$ ' || to_char(v_total, 'FM999G999G990D00') || ')' else '' end
      || coalesce('. Motivo: ' || nullif(trim(p_motivo), ''), ''),
    p.obra_id, p.id,
    jsonb_build_object('parcelas', v_antes) || case when v_total <> p.valor then jsonb_build_object('valor', p.valor) else '{}'::jsonb end,
    jsonb_build_object('parcelas', v_depois) || case when v_total <> p.valor then jsonb_build_object('valor', v_total) else '{}'::jsonb end);

  if v_total <> p.valor then
    if p.status in ('aguardando_engenheiro', 'aguardando_administrador') then
      perform public._nova_versao(p.id, coalesce(nullif(trim(p_motivo), ''), 'Parcelas alteradas'));
    elsif p.status = 'aguardando_pagamento' then
      -- Já aprovado: quem assinou fica sabendo da mudança de valor (inclusive se foi o Financeiro)
      perform public._notificar_aprovadores(p.id, 'Valor alterado após a sua aprovação',
        'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ', que você aprovou, teve as parcelas alteradas: total de R$ '
          || public._brl(p.valor) || ' para R$ ' || public._brl(v_total) || ' por '
          || coalesce((select nome from public.profiles where id = auth.uid()), 'um usuário') || '. Motivo: ' || trim(p_motivo));
    end if;
    if p.status = 'aguardando_pagamento' and v_total <> p.valor and not public.is_financeiro() then
      perform public._notificar_financeiro('Parcelas alteradas após liberação',
        'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ': total alterado para R$ ' || to_char(v_total, 'FM999G999G990D00') || '. Motivo: ' || trim(p_motivo),
        '/pagamentos/' || p.id, p.id);
    end if;
  end if;
end
$$;

revoke all on function public.editar_parcelas(uuid, jsonb, text) from public, anon;
grant execute on function public.editar_parcelas(uuid, jsonb, text) to authenticated;
