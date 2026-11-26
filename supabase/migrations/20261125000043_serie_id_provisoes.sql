-- Identificador próprio das séries de provisões (auditoria A-11).
-- Antes a série era reconhecida pelo texto "Descrição (k/N)" + obra + criador: duas séries iguais nesses quatro
-- pontos se confundiam, e cancelar ou estender uma mexia na outra. Agora cada série tem um serie_id.

alter table public.provisoes add column if not exists serie_id uuid;
create index if not exists provisoes_serie_idx on public.provisoes (serie_id) where serie_id is not null;

-- As séries que já existem ganham o identificador (agrupadas pelo mesmo critério antigo, uma última vez)
with chaves as (
  select distinct obra_id, created_by, pagamento_origem_id,
         regexp_replace(descricao, ' \(\d+/\d+\)$', '') as base,
         (regexp_match(descricao, ' \(\d+/(\d+)\)$'))[1]::int as total
    from public.provisoes
   where descricao ~ ' \(\d+/\d+\)$' and serie_id is null
), com_id as (select c.*, gen_random_uuid() as sid from chaves c)
update public.provisoes p
   set serie_id = i.sid
  from com_id i
 where p.serie_id is null
   and p.descricao ~ ' \(\d+/\d+\)$'
   and p.obra_id = i.obra_id and p.created_by = i.created_by
   and p.pagamento_origem_id is not distinct from i.pagamento_origem_id
   and regexp_replace(p.descricao, ' \(\d+/\d+\)$', '') = i.base
   and (regexp_match(p.descricao, ' \(\d+/(\d+)\)$'))[1]::int = i.total;

create or replace function public.criar_repeticoes(p_pagamento_id uuid, p_intervalo integer, p_vezes integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  k integer;
  v_venc date;
  v_comp date;
  v_serie uuid := gen_random_uuid();
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
    insert into public.provisoes (obra_id, descricao, mes_referencia, vencimento, valor_estimado, observacoes, categoria_id, pagamento_origem_id, created_by, serie_id)
    values (
      p.obra_id,
      left(p.favorecido || ' — ' || p.descricao || ' (' || (k + 1) || '/' || p_vezes || ')', 500),
      to_char(v_comp, 'YYYY-MM'),
      v_venc,
      p.valor,
      'Repetição do pagamento nº ' || p.numero || '. Converta em pagamento quando o documento chegar.',
      p.categoria_id,
      p.id,
      auth.uid(),
      v_serie
    );
  end loop;
  perform public._auditar('pagamento', p.id::text, 'criou',
    'Repetição: ' || (p_vezes - 1) || ' provisão(ões) criadas a cada ' || p_intervalo || ' mês(es)', p.obra_id, p.id, null, null);
  return p_vezes - 1;
end
$$;

create or replace function public.estender_serie_provisao(p_provisao_id uuid, p_quantidade integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  pv public.provisoes;
  v_base text;
  v_total integer;
  v_novo_total integer;
  v_intervalo integer;
  v_anc_k integer;
  v_anc_venc date;
  v_anc_mes date;
  v_ult public.provisoes;
  v_seg record;
  v_origem public.pagamentos;
  k integer;
  v_ids uuid[];
  v_serie uuid;
begin
  if p_quantidade is null or p_quantidade not between 1 and 60 then
    raise exception 'Informe de 1 a 60 parcelas para adicionar.';
  end if;
  select * into pv from public.provisoes where id = p_provisao_id;
  if not found or not public.pode_ver_obra(pv.obra_id) and not public.is_financeiro() then
    raise exception 'Provisão não encontrada.';
  end if;
  if not (public.is_financeiro() or pv.created_by = auth.uid()) then
    raise exception 'Somente o Financeiro ou quem cadastrou a provisão pode adicionar parcelas.' using errcode = '42501';
  end if;

  if substring(pv.descricao from ' \((\d+)/(\d+)\)$') is null then
    raise exception 'Esta provisão não faz parte de uma série de parcelas.';
  end if;
  v_base := regexp_replace(pv.descricao, ' \(\d+/\d+\)$', '');
  v_total := (regexp_match(pv.descricao, ' \(\d+/(\d+)\)$'))[1]::int;

  -- Linhas da série (todas as situações). A série é o identificador próprio (serie_id): duas séries da mesma pessoa,
  -- na mesma obra, com a mesma descrição e o mesmo total deixam de se confundir (auditoria A-11).
  if pv.serie_id is not null then
    v_serie := pv.serie_id;
    select array_agg(s.id) into v_ids from public.provisoes s where s.serie_id = v_serie;
  else
    -- Série antiga sem identificador: reconhece pelo texto e passa a ter um
    select array_agg(s.id) into v_ids
      from public.provisoes s
     where s.obra_id = pv.obra_id
       and s.created_by = pv.created_by
       and coalesce(s.pagamento_origem_id::text, '') = coalesce(pv.pagamento_origem_id::text, '')
       and regexp_replace(s.descricao, ' \(\d+/\d+\)$', '') = v_base
       and (regexp_match(s.descricao, ' \(\d+/(\d+)\)$'))[1]::int = v_total;
    v_serie := gen_random_uuid();
    update public.provisoes set serie_id = v_serie where id = any (v_ids);
  end if;

  v_novo_total := v_total + p_quantidade;
  if v_novo_total > 120 then
    raise exception 'A série pode ter no máximo 120 parcelas.';
  end if;

  -- Âncora: a parcela de menor número com vencimento; intervalo pela diferença em meses entre as duas primeiras
  select (regexp_match(s.descricao, ' \((\d+)/\d+\)$'))[1]::int, s.vencimento, to_date(s.mes_referencia || '-01', 'YYYY-MM-DD')
    into v_anc_k, v_anc_venc, v_anc_mes
    from public.provisoes s where s.id = any (v_ids) and s.vencimento is not null
   order by 1 limit 1;
  if v_anc_venc is null then
    raise exception 'A série não tem vencimentos para calcular as próximas parcelas.';
  end if;
  select (regexp_match(s.descricao, ' \((\d+)/\d+\)$'))[1]::int as k, s.vencimento
    into v_seg
    from public.provisoes s where s.id = any (v_ids) and s.vencimento is not null
     and (regexp_match(s.descricao, ' \((\d+)/\d+\)$'))[1]::int > v_anc_k
   order by 1 limit 1;
  if v_seg.k is not null then
    v_intervalo := ((extract(year from v_seg.vencimento) * 12 + extract(month from v_seg.vencimento))
                   - (extract(year from v_anc_venc) * 12 + extract(month from v_anc_venc)))::int / (v_seg.k - v_anc_k);
  elsif pv.pagamento_origem_id is not null then
    select * into v_origem from public.pagamentos where id = pv.pagamento_origem_id;
    v_intervalo := ((extract(year from v_anc_venc) * 12 + extract(month from v_anc_venc))
                   - (extract(year from v_origem.vencimento) * 12 + extract(month from v_origem.vencimento)))::int / greatest(v_anc_k - 1, 1);
  end if;
  v_intervalo := greatest(coalesce(v_intervalo, 1), 1);

  -- Última parcela (modelo de valor, categoria e observações)
  select * into v_ult from public.provisoes s where s.id = any (v_ids)
   order by (regexp_match(s.descricao, ' \((\d+)/\d+\)$'))[1]::int desc limit 1;

  -- Renumera as existentes: (k/N) -> (k/N+q)
  update public.provisoes s
     set descricao = v_base || ' (' || (regexp_match(s.descricao, ' \((\d+)/\d+\)$'))[1] || '/' || v_novo_total || ')'
   where s.id = any (v_ids);

  for k in (v_total + 1)..v_novo_total loop
    insert into public.provisoes (obra_id, descricao, mes_referencia, vencimento, valor_estimado, observacoes, categoria_id, pagamento_origem_id, created_by, serie_id)
    values (
      pv.obra_id,
      left(v_base || ' (' || k || '/' || v_novo_total || ')', 500),
      case when v_anc_mes is null then to_char((v_anc_venc + make_interval(months => (k - v_anc_k) * v_intervalo))::date, 'YYYY-MM')
           else to_char((v_anc_mes + make_interval(months => (k - v_anc_k) * v_intervalo))::date, 'YYYY-MM') end,
      (v_anc_venc + make_interval(months => (k - v_anc_k) * v_intervalo))::date,
      v_ult.valor_estimado,
      v_ult.observacoes,
      v_ult.categoria_id,
      pv.pagamento_origem_id,
      pv.created_by,
      v_serie
    );
  end loop;

  perform public._auditar('provisao', pv.id::text, 'criou',
    p_quantidade || ' parcela(s) adicionada(s) à série "' || v_base || '" (agora ' || v_novo_total || ' parcelas, a cada ' || v_intervalo || ' mês(es))',
    pv.obra_id, pv.pagamento_origem_id, null, null);
  return p_quantidade;
end
$$;

revoke all on function public.criar_repeticoes(uuid, integer, integer) from public, anon;
grant execute on function public.criar_repeticoes(uuid, integer, integer) to authenticated;
revoke all on function public.estender_serie_provisao(uuid, integer) from public, anon;
grant execute on function public.estender_serie_provisao(uuid, integer) to authenticated;
