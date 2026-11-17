-- Repetição de despesa: o primeiro lançamento é o pagamento; os seguintes viram provisões
-- (com os próximos vencimentos), para virar pagamento quando o boleto/documento chegar.

alter table public.provisoes add column if not exists categoria_id uuid references public.categorias (id);
alter table public.provisoes add column if not exists pagamento_origem_id uuid references public.pagamentos (id);
create index if not exists provisoes_origem_idx on public.provisoes (pagamento_origem_id);

-- A OP guarda a configuração de repetição no rascunho; as provisões nascem no envio.
alter table public.ordens_pagamento add column if not exists repetir_intervalo integer check (repetir_intervalo is null or repetir_intervalo between 1 and 12);
alter table public.ordens_pagamento add column if not exists repetir_vezes integer check (repetir_vezes is null or repetir_vezes between 2 and 60);

create or replace function public.definir_repeticao_op(p_ordem_id uuid, p_intervalo integer, p_vezes integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  o public.ordens_pagamento;
begin
  select * into o from public.ordens_pagamento where id = p_ordem_id for update;
  if not found or o.solicitante_id <> auth.uid() then
    raise exception 'Solicitação não encontrada.';
  end if;
  if o.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  if (p_intervalo is null) <> (p_vezes is null) then
    raise exception 'Informe o intervalo e a quantidade de vezes da repetição.';
  end if;
  if p_intervalo is not null and (p_intervalo not between 1 and 12 or p_vezes not between 2 and 60) then
    raise exception 'Repetição inválida: intervalo de 1 a 12 meses e de 2 a 60 vezes.';
  end if;
  update public.ordens_pagamento set repetir_intervalo = p_intervalo, repetir_vezes = p_vezes where id = p_ordem_id;
end
$$;

-- Cria as provisões das próximas ocorrências de um pagamento (a 1ª ocorrência é o próprio pagamento).
-- Só quem cadastrou o pagamento; não repete se já houver provisões geradas por ele.
create or replace function public.criar_repeticoes(p_pagamento_id uuid, p_intervalo integer, p_vezes integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  k integer;
  v_venc date;
  v_comp date;
begin
  if p_intervalo is null or p_vezes is null or p_intervalo not between 1 and 12 or p_vezes not between 2 and 60 then
    raise exception 'Repetição inválida: intervalo de 1 a 12 meses e de 2 a 60 vezes.';
  end if;
  select * into p from public.pagamentos where id = p_pagamento_id;
  if not found or p.created_by <> auth.uid() then
    raise exception 'Pagamento não encontrado.';
  end if;
  if exists (select 1 from public.provisoes where pagamento_origem_id = p.id) then
    return 0;
  end if;
  for k in 1..(p_vezes - 1) loop
    v_venc := (p.vencimento + make_interval(months => k * p_intervalo))::date;
    v_comp := (p.data_competencia + make_interval(months => k * p_intervalo))::date;
    insert into public.provisoes (obra_id, descricao, mes_referencia, vencimento, valor_estimado, observacoes, categoria_id, pagamento_origem_id, created_by)
    values (
      p.obra_id,
      left(p.favorecido || ' — ' || p.descricao || ' (' || (k + 1) || '/' || p_vezes || ')', 500),
      to_char(v_comp, 'YYYY-MM'),
      v_venc,
      p.valor,
      'Repetição do pagamento nº ' || p.numero || '. Converta em pagamento quando o documento chegar.',
      p.categoria_id,
      p.id,
      auth.uid()
    );
  end loop;
  perform public._auditar('pagamento', p.id::text, 'criou',
    'Repetição: ' || (p_vezes - 1) || ' provisão(ões) criadas a cada ' || p_intervalo || ' mês(es)', p.obra_id, p.id, null, null);
  return p_vezes - 1;
end
$$;

revoke all on function public.definir_repeticao_op(uuid, integer, integer) from public, anon;
revoke all on function public.criar_repeticoes(uuid, integer, integer) from public, anon;
grant execute on function public.definir_repeticao_op(uuid, integer, integer) to authenticated;
grant execute on function public.criar_repeticoes(uuid, integer, integer) to authenticated;
