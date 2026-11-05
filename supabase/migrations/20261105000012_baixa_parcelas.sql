-- Baixa por parcela: cada parcela é paga separadamente. O pagamento só fica pago
-- quando todas as parcelas estiverem pagas. Pagamento parcelado não recebe baixa total.
alter table public.pagamento_parcelas
  add column if not exists status text not null default 'a_pagar' check (status in ('a_pagar', 'pago')),
  add column if not exists pago_em date,
  add column if not exists valor_pago numeric(14, 2),
  add column if not exists pago_por uuid references public.profiles (id);

create or replace function public.registrar_baixa_parcela(
  p_parcela_id uuid, p_pago_em date, p_valor_pago numeric default null, p_observacao text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pc public.pagamento_parcelas;
  p public.pagamentos;
  v_total int;
  v_pagas int;
  v_valor numeric(14, 2);
begin
  if not public.pode_baixar() then
    raise exception 'Somente o Financeiro ou o Administrador master registram a baixa de pagamentos.' using errcode = '42501';
  end if;
  select * into pc from public.pagamento_parcelas where id = p_parcela_id for update;
  if not found then
    raise exception 'Parcela não encontrada.';
  end if;
  select * into p from public.pagamentos where id = pc.pagamento_id for update;
  if p.status <> 'aguardando_pagamento' then
    raise exception 'O pagamento nº % não está liberado para pagamento.', p.numero;
  end if;
  if pc.status = 'pago' then
    raise exception 'Esta parcela já foi paga.';
  end if;
  if p_pago_em is null then
    raise exception 'Informe a data do pagamento.';
  end if;
  v_valor := round(pc.valor_base + pc.multa + pc.juros - pc.desconto, 2);

  update public.pagamento_parcelas
     set status = 'pago', pago_em = p_pago_em, valor_pago = coalesce(p_valor_pago, v_valor), pago_por = auth.uid()
   where id = pc.id;

  perform public._auditar('pagamento', p.id::text, 'baixa_parcela',
    'Parcela ' || pc.numero || ' paga em ' || to_char(p_pago_em, 'DD/MM/YYYY') || ' (R$ ' || to_char(coalesce(p_valor_pago, v_valor), 'FM999G999G990D00') || ')'
      || coalesce('. ' || nullif(trim(p_observacao), ''), ''),
    p.obra_id, p.id,
    jsonb_build_object('parcela', pc.numero, 'status', 'a_pagar'),
    jsonb_build_object('parcela', pc.numero, 'status', 'pago', 'valor_pago', coalesce(p_valor_pago, v_valor)));

  select count(*), count(*) filter (where status = 'pago') into v_total, v_pagas
    from public.pagamento_parcelas where pagamento_id = p.id;

  if v_pagas = v_total then
    update public.pagamentos
       set status = 'pago',
           pago_em = (select max(pago_em) from public.pagamento_parcelas where pagamento_id = p.id),
           valor_pago = (select sum(valor_pago) from public.pagamento_parcelas where pagamento_id = p.id),
           pago_por = auth.uid()
     where id = p.id;
    perform public._auditar('pagamento', p.id::text, 'baixa',
      'Todas as parcelas pagas: pagamento concluído', p.obra_id, p.id,
      jsonb_build_object('status', p.status), jsonb_build_object('status', 'pago'));
    perform public._notificar(p.created_by, 'Pagamento efetuado',
      'Todas as parcelas do pagamento nº ' || p.numero || ' foram pagas.', '/pagamentos/' || p.id, p.id);
  else
    perform public._notificar(p.created_by, 'Parcela paga',
      'Parcela ' || pc.numero || ' do pagamento nº ' || p.numero || ' foi paga. Faltam ' || (v_total - v_pagas) || ' parcela(s).',
      '/pagamentos/' || p.id, p.id);
  end if;
end
$$;

revoke all on function public.registrar_baixa_parcela(uuid, date, numeric, text) from public, anon;
grant execute on function public.registrar_baixa_parcela(uuid, date, numeric, text) to authenticated;

-- Pagamento parcelado não recebe baixa total.
create or replace function public.registrar_baixa(
  p_id uuid, p_pago_em date, p_valor_pago numeric default null, p_observacao text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
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
  update public.pagamentos
     set status = 'pago', pago_em = p_pago_em, valor_pago = coalesce(p_valor_pago, p.valor), pago_por = auth.uid()
   where id = p_id;
  perform public._auditar('pagamento', p_id::text, 'baixa',
    'Pagamento registrado como pago em ' || to_char(p_pago_em, 'DD/MM/YYYY')
      || coalesce('. ' || nullif(trim(p_observacao), ''), ''),
    p.obra_id, p_id,
    jsonb_build_object('status', p.status),
    jsonb_build_object('status', 'pago', 'pago_em', p_pago_em, 'valor_pago', coalesce(p_valor_pago, p.valor)));
  perform public._notificar(p.created_by, 'Pagamento efetuado',
    'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ' foi pago em ' || to_char(p_pago_em, 'DD/MM/YYYY') || '.',
    '/pagamentos/' || p.id, p.id);
end
$$;

create or replace function public.definir_parcelas(p_pagamento_id uuid, p_parcelas jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_item jsonb;
  v_num int := 0;
  v_base numeric(14, 2) := 0;
  v_base_item numeric(14, 2);
  v_multa numeric(14, 2);
  v_juros numeric(14, 2);
  v_desc numeric(14, 2);
  v_motivo text;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or p.created_by <> auth.uid() or public.meu_perfil() not in ('financeiro', 'suprimentos') then
    raise exception 'Somente quem cadastrou o pagamento pode parcelá-lo.' using errcode = '42501';
  end if;
  if exists (select 1 from public.pagamento_parcelas where pagamento_id = p_pagamento_id and status = 'pago') then
    raise exception 'Não é possível redividir: há parcelas já pagas.';
  end if;
  if p.status in ('pago', 'cancelado', 'rejeitado') then
    raise exception 'Não é possível parcelar um pagamento pago, cancelado ou rejeitado.';
  end if;
  if p_parcelas is null or jsonb_typeof(p_parcelas) <> 'array' or jsonb_array_length(p_parcelas) < 2 then
    raise exception 'Um pagamento parcelado precisa de pelo menos duas parcelas.';
  end if;

  for v_item in select * from jsonb_array_elements(p_parcelas) loop
    v_num := v_num + 1;
    v_base_item := round((v_item ->> 'valor')::numeric, 2);
    v_multa := round(coalesce(nullif(v_item ->> 'multa', ''), '0')::numeric, 2);
    v_juros := round(coalesce(nullif(v_item ->> 'juros', ''), '0')::numeric, 2);
    v_desc := round(coalesce(nullif(v_item ->> 'desconto', ''), '0')::numeric, 2);
    v_motivo := nullif(trim(v_item ->> 'motivo'), '');
    if v_base_item is null or v_base_item <= 0 then
      raise exception 'Parcela %: informe o valor.', v_num;
    end if;
    if nullif(v_item ->> 'vencimento', '') is null then
      raise exception 'Parcela %: informe o vencimento.', v_num;
    end if;
    if v_multa < 0 or v_juros < 0 or v_desc < 0 then
      raise exception 'Parcela %: multa, juros e desconto não podem ser negativos.', v_num;
    end if;
    if (v_multa + v_juros + v_desc) > 0 and v_motivo is null then
      raise exception 'Parcela %: multa, juros ou desconto exigem o motivo.', v_num;
    end if;
    v_base := v_base + v_base_item;
  end loop;

  if v_base <> p.valor then
    raise exception 'A soma das parcelas (R$ %) não confere com o valor do pagamento (R$ %). Multa e juros são lançados à parte, em cada parcela.', v_base, p.valor;
  end if;

  delete from public.pagamento_parcelas where pagamento_id = p_pagamento_id;
  v_num := 0;
  for v_item in select * from jsonb_array_elements(p_parcelas) loop
    v_num := v_num + 1;
    insert into public.pagamento_parcelas (pagamento_id, numero, valor_base, multa, juros, desconto, vencimento, motivo)
    values (p_pagamento_id, v_num, round((v_item ->> 'valor')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'multa', ''), '0')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'juros', ''), '0')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'desconto', ''), '0')::numeric, 2),
            (v_item ->> 'vencimento')::date, nullif(trim(v_item ->> 'motivo'), ''));
  end loop;

  perform public._auditar('pagamento', p_pagamento_id::text, 'parcelou',
    'Pagamento dividido em ' || v_num || ' parcelas com vencimentos próprios (aprovação única do pagamento)',
    p.obra_id, p_pagamento_id, null, jsonb_build_object('parcelas', v_num));
end
$$;
