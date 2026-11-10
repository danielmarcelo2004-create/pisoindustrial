-- Parcelas da OP informadas pelo solicitante: cada parcela tem vencimento e valor.
-- A soma das parcelas precisa ser igual ao total da OP (itens menos desconto).
drop function if exists public.definir_parcelas_op(uuid, integer);

create or replace function public.definir_parcelas_op(p_id uuid, p_parcelas jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_op public.ordens_pagamento;
  v_subtotal numeric(14, 2);
  v_total numeric(14, 2);
  v_soma numeric(14, 2) := 0;
  v_item jsonb;
  v_num integer := 0;
  v_valor numeric(14, 2);
  v_venc date;
begin
  select * into v_op from public.ordens_pagamento where id = p_id for update;
  if not found or v_op.solicitante_id <> auth.uid() then
    raise exception 'Solicitação não encontrada.';
  end if;
  if v_op.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;

  delete from public.ordem_parcelas where ordem_id = p_id;
  if p_parcelas is null or jsonb_typeof(p_parcelas) <> 'array' or jsonb_array_length(p_parcelas) < 2 then
    return;
  end if;
  if jsonb_array_length(p_parcelas) > 60 then
    raise exception 'Máximo de 60 parcelas.';
  end if;

  select coalesce(sum(i2.total), 0) into v_subtotal from public.ordem_itens i2 where i2.ordem_id = p_id;
  v_total := v_subtotal - v_op.desconto;
  if v_total <= 0 then
    raise exception 'O valor total da OP deve ser maior que zero para parcelar.';
  end if;

  for v_item in select * from jsonb_array_elements(p_parcelas) loop
    v_num := v_num + 1;
    v_valor := round((v_item ->> 'valor')::numeric, 2);
    if v_valor is null or v_valor <= 0 then
      raise exception 'Parcela %: informe o valor.', v_num;
    end if;
    if nullif(v_item ->> 'vencimento', '') is null then
      raise exception 'Parcela %: informe o vencimento.', v_num;
    end if;
    v_venc := (v_item ->> 'vencimento')::date;
    v_soma := v_soma + v_valor;
    insert into public.ordem_parcelas (ordem_id, numero, valor, vencimento) values (p_id, v_num, v_valor, v_venc);
  end loop;

  if abs(v_soma - v_total) > 0.005 then
    raise exception 'A soma das parcelas (R$ %) precisa ser igual ao total da OP (R$ %).', v_soma, v_total;
  end if;
end
$$;

revoke all on function public.definir_parcelas_op(uuid, jsonb) from public, anon;
grant execute on function public.definir_parcelas_op(uuid, jsonb) to authenticated;
