-- Ordem de pagamento parcelada: a OP continua sendo um documento só (uma aprovação), mas o valor
-- total é dividido em parcelas com vencimentos mensais a partir do primeiro vencimento.
-- As parcelas são recalculadas sempre que a OP é salva (rascunho); ao enviar, viram parcelas do pagamento.

create table public.ordem_parcelas (
  id uuid primary key default gen_random_uuid(),
  ordem_id uuid not null references public.ordens_pagamento (id) on delete cascade,
  numero integer not null check (numero > 0),
  valor numeric(14, 2) not null check (valor > 0),
  vencimento date not null,
  unique (ordem_id, numero)
);

alter table public.ordem_parcelas enable row level security;

create policy ordem_parcelas_select on public.ordem_parcelas for select to authenticated
  using (exists (select 1 from public.ordens_pagamento o where o.id = ordem_id and public.pode_ver_obra(o.obra_id)));

revoke all on public.ordem_parcelas from anon;
revoke insert, update, delete, truncate on public.ordem_parcelas from authenticated;

-- Recalcula as parcelas da OP em rascunho. Quantidade 1 (ou menos) remove o parcelamento.
create or replace function public.definir_parcelas_op(p_id uuid, p_quantidade integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_op public.ordens_pagamento;
  v_subtotal numeric(14, 2);
  v_total numeric(14, 2);
  v_base numeric(14, 2);
  i integer;
begin
  select * into v_op from public.ordens_pagamento where id = p_id for update;
  if not found or v_op.solicitante_id <> auth.uid() then
    raise exception 'Solicitação não encontrada.';
  end if;
  if v_op.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  if p_quantidade is null or p_quantidade < 1 or p_quantidade > 60 then
    raise exception 'A quantidade de parcelas deve estar entre 1 e 60.';
  end if;

  delete from public.ordem_parcelas where ordem_id = p_id;
  if p_quantidade = 1 then
    return;
  end if;
  if v_op.vencimento is null then
    raise exception 'Informe o primeiro vencimento para parcelar.';
  end if;

  select coalesce(sum(i2.total), 0) into v_subtotal from public.ordem_itens i2 where i2.ordem_id = p_id;
  v_total := v_subtotal - v_op.desconto;
  if v_total <= 0 then
    raise exception 'O valor total da OP deve ser maior que zero para parcelar.';
  end if;

  -- Parcelas iguais; a última absorve os centavos que sobram.
  v_base := floor(v_total * 100 / p_quantidade) / 100;
  for i in 1..p_quantidade loop
    insert into public.ordem_parcelas (ordem_id, numero, valor, vencimento)
    values (
      p_id,
      i,
      case when i = p_quantidade then v_total - v_base * (p_quantidade - 1) else v_base end,
      (v_op.vencimento + make_interval(months => i - 1))::date
    );
  end loop;
end
$$;

-- Envio: igual ao anterior, e copia as parcelas da OP para o pagamento (quando houver duas ou mais).
create or replace function public.enviar_op(p_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_op public.ordens_pagamento;
  o public.obras;
  v_subtotal numeric(14, 2);
  v_total numeric(14, 2);
  v_fluxo public.fluxo_aprovacao;
  v_pag uuid;
  v_numero text;
begin
  select * into v_op from public.ordens_pagamento where id = p_id for update;
  if not found or v_op.solicitante_id <> auth.uid() then
    raise exception 'Solicitação não encontrada.';
  end if;
  if v_op.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  if public.meu_perfil() not in ('engenheiro', 'financeiro', 'suprimentos') or not public.pode_ver_obra(v_op.obra_id) then
    raise exception 'Você não está vinculado a esta obra.' using errcode = '42501';
  end if;
  if v_op.vencimento is null then
    raise exception 'Informe a data de vencimento antes de enviar.';
  end if;
  select coalesce(sum(i.total), 0) into v_subtotal from public.ordem_itens i where i.ordem_id = p_id;
  v_total := v_subtotal - v_op.desconto;
  if v_total <= 0 then
    raise exception 'O valor total da OP deve ser maior que zero.';
  end if;
  select * into o from public.obras where id = v_op.obra_id;
  if o.status <> 'ativa' then
    raise exception 'O centro de custo não está ativo.';
  end if;

  v_fluxo := case when o.administrador_id is not null then 'B'::public.fluxo_aprovacao else 'C'::public.fluxo_aprovacao end;
  v_numero := 'OP-' || to_char(now() at time zone 'America/Sao_Paulo', 'YYYY') || '-'
              || lpad(nextval('public.ordens_pagamento_seq')::text, 5, '0');

  update public.ordens_pagamento
     set numero = v_numero, status = 'enviada', enviada_em = now()
   where id = p_id;

  insert into public.pagamentos (obra_id, fornecedor_id, favorecido, descricao, valor, vencimento, forma_pagamento,
                                 numero_documento, observacoes, fluxo, status, created_by, ordem_id)
  values (o.id, v_op.fornecedor_id, v_op.favorecido, v_op.descricao, v_total, v_op.vencimento, v_op.forma_pagamento,
          coalesce(v_op.numero_nf, v_numero), v_op.observacoes, v_fluxo, public._status_inicial(v_fluxo), auth.uid(), p_id)
  returning id into v_pag;

  -- Parcelas da OP viram parcelas do pagamento (a baixa é feita por parcela, como nos demais pagamentos).
  insert into public.pagamento_parcelas (pagamento_id, numero, valor_base, vencimento)
  select v_pag, op.numero, op.valor, op.vencimento
    from public.ordem_parcelas op
   where op.ordem_id = p_id
     and (select count(*) from public.ordem_parcelas x where x.ordem_id = p_id) >= 2;

  perform public._auditar('pagamento', v_pag::text, 'criou',
    'Ordem de pagamento ' || v_numero || ' solicitada'
      || case when v_fluxo = 'B' then ' e encaminhada ao administrador' else ' e encaminhada ao Financeiro (centro de custo sem administrador)' end,
    o.id, v_pag, null, (select to_jsonb(p) from public.pagamentos p where p.id = v_pag));
  perform public._notificar_etapa(v_pag);
  return v_pag;
end
$$;
