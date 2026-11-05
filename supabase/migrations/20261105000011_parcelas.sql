-- Pagamento parcelado: cada parcela tem vencimento próprio. A aprovação vale para o pagamento inteiro.
-- Regra: a soma do valor base das parcelas é igual ao valor do pagamento. Multa e juros aumentam a
-- parcela; desconto a reduz. Qualquer multa, juros ou desconto exige motivo.
create table public.pagamento_parcelas (
  id uuid primary key default gen_random_uuid(),
  pagamento_id uuid not null references public.pagamentos (id) on delete cascade,
  numero integer not null check (numero > 0),
  valor_base numeric(14, 2) not null check (valor_base > 0),
  multa numeric(14, 2) not null default 0 check (multa >= 0),
  juros numeric(14, 2) not null default 0 check (juros >= 0),
  desconto numeric(14, 2) not null default 0 check (desconto >= 0),
  vencimento date not null,
  motivo text,
  unique (pagamento_id, numero)
);
alter table public.pagamento_parcelas enable row level security;
create policy pagamento_parcelas_select on public.pagamento_parcelas for select to authenticated
  using (exists (select 1 from public.pagamentos p where p.id = pagamento_id and public.pode_ver_obra(p.obra_id)));
revoke all on public.pagamento_parcelas from anon;
revoke insert, update, delete, truncate on public.pagamento_parcelas from authenticated;

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

revoke all on function public.definir_parcelas(uuid, jsonb) from public, anon;
grant execute on function public.definir_parcelas(uuid, jsonb) to authenticated;
