-- =============================================================================
-- Modelo oficial da Ordem de Pagamento (Construtora Parceria):
--   * referência do mês (ex.: OUTUBRO), desconto e totais
--   * início e salário de referência por item (mão de obra)
-- =============================================================================

alter table public.ordens_pagamento
  add column referencia text check (referencia is null or length(referencia) <= 60),
  add column desconto numeric(14, 2) not null default 0 check (desconto >= 0);

alter table public.ordem_itens
  add column inicio date,
  add column salario numeric(14, 2) check (salario is null or salario >= 0);

drop function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb);

create or replace function public.salvar_op(
  p_id uuid,
  p_obra_id uuid,
  p_favorecido text,
  p_cpf_cnpj text,
  p_descricao text,
  p_vencimento date,
  p_forma_pagamento public.forma_pagamento,
  p_dados_bancarios text,
  p_observacoes text,
  p_itens jsonb,
  p_desconto numeric default 0,
  p_referencia text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_op public.ordens_pagamento;
  v_item jsonb;
  v_pos int := 0;
  v_doc text := nullif(regexp_replace(coalesce(p_cpf_cnpj, ''), '\D', '', 'g'), '');
  v_forn uuid;
  v_desconto numeric(14, 2) := round(coalesce(p_desconto, 0), 2);
  v_subtotal numeric(14, 2);
begin
  if public.meu_perfil() is distinct from 'engenheiro' then
    raise exception 'Somente engenheiros solicitam Ordens de Pagamento.' using errcode = '42501';
  end if;
  if not public.pode_ver_obra(p_obra_id) then
    raise exception 'Você não está vinculado a esta obra.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.obras o where o.id = p_obra_id and o.status = 'ativa') then
    raise exception 'A obra não está ativa.';
  end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Informe ao menos um item.';
  end if;
  select coalesce(sum(round((x ->> 'quantidade')::numeric * (x ->> 'valor_unitario')::numeric, 2)), 0)
    into v_subtotal
    from jsonb_array_elements(p_itens) x;
  if v_desconto < 0 then
    raise exception 'O desconto não pode ser negativo.';
  end if;
  if v_desconto > v_subtotal then
    raise exception 'O desconto não pode ser maior que o subtotal da OP.';
  end if;
  if v_doc is not null and length(v_doc) not in (11, 14) then
    raise exception 'CPF deve ter 11 dígitos e CNPJ 14 dígitos.';
  end if;
  if v_doc is not null then
    select f.id into v_forn from public.fornecedores f where f.cpf_cnpj = v_doc;
  end if;

  if v_id is null then
    insert into public.ordens_pagamento (obra_id, solicitante_id, fornecedor_id, favorecido, cpf_cnpj, descricao,
                                         vencimento, forma_pagamento, dados_bancarios, observacoes, referencia, desconto)
    values (p_obra_id, auth.uid(), v_forn, trim(p_favorecido), v_doc, trim(p_descricao), p_vencimento,
            p_forma_pagamento, nullif(trim(p_dados_bancarios), ''), nullif(trim(p_observacoes), ''),
            nullif(trim(p_referencia), ''), v_desconto)
    returning id into v_id;
  else
    select * into v_op from public.ordens_pagamento where id = v_id for update;
    if not found or v_op.solicitante_id <> auth.uid() then
      raise exception 'Solicitação não encontrada.';
    end if;
    if v_op.status <> 'em_elaboracao' then
      raise exception 'A solicitação já foi enviada e não pode mais ser alterada.';
    end if;
    update public.ordens_pagamento set
      obra_id = p_obra_id, fornecedor_id = v_forn, favorecido = trim(p_favorecido), cpf_cnpj = v_doc,
      descricao = trim(p_descricao), vencimento = p_vencimento, forma_pagamento = p_forma_pagamento,
      dados_bancarios = nullif(trim(p_dados_bancarios), ''), observacoes = nullif(trim(p_observacoes), ''),
      referencia = nullif(trim(p_referencia), ''), desconto = v_desconto
    where id = v_id;
    delete from public.ordem_itens where ordem_id = v_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    v_pos := v_pos + 1;
    insert into public.ordem_itens (ordem_id, posicao, descricao, unidade, quantidade, valor_unitario, inicio, salario)
    values (v_id, v_pos, trim(v_item ->> 'descricao'), nullif(trim(v_item ->> 'unidade'), ''),
            (v_item ->> 'quantidade')::numeric, (v_item ->> 'valor_unitario')::numeric,
            nullif(v_item ->> 'inicio', '')::date, nullif(v_item ->> 'salario', '')::numeric);
  end loop;
  return v_id;
end
$$;

revoke all on function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb, numeric, text) from public, anon;
grant execute on function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb, numeric, text) to authenticated;

-- Envio: o valor do pagamento é o subtotal menos o desconto.
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
  if public.meu_perfil() is distinct from 'engenheiro' or not public.pode_ver_obra(v_op.obra_id) then
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
    raise exception 'A obra não está ativa.';
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
          v_numero, v_op.observacoes, v_fluxo, public._status_inicial(v_fluxo), auth.uid(), p_id)
  returning id into v_pag;

  perform public._auditar('pagamento', v_pag::text, 'criou',
    'Ordem de pagamento ' || v_numero || ' solicitada pelo engenheiro'
      || case when v_fluxo = 'B' then ' e encaminhada ao administrador' else ' e encaminhada ao Financeiro (obra sem administrador)' end,
    o.id, v_pag, null, (select to_jsonb(p) from public.pagamentos p where p.id = v_pag));
  perform public._notificar_etapa(v_pag);
  return v_pag;
end
$$;
