-- Fundo fixo: um fundo por pessoa e por obra. Gastos individuais com anexos assinados.
-- Status do fundo é calculado pelo saldo: acabando (10% ou menos), esgotado (zero ou menos).
create type public.status_fundo as enum ('em_andamento', 'acabando', 'esgotado', 'fechado');
create type public.status_gasto_fundo as enum ('pendente', 'aprovado', 'recusado');

create table public.fundos_fixos (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras (id),
  pessoa_id uuid not null references public.profiles (id),
  valor numeric(14, 2) not null check (valor > 0),
  status public.status_fundo not null default 'em_andamento',
  criado_por uuid not null references public.profiles (id) default auth.uid(),
  fechado_em timestamptz,
  reposicao numeric(14, 2),
  reembolso numeric(14, 2),
  saldo_repassado numeric(14, 2),
  pagamento_id uuid references public.pagamentos (id),
  created_at timestamptz not null default now()
);
-- Só pode existir um fundo aberto por pessoa e obra.
create unique index fundos_aberto_unico on public.fundos_fixos (obra_id, pessoa_id)
  where status <> 'fechado';

create table public.fundo_gastos (
  id uuid primary key default gen_random_uuid(),
  fundo_id uuid not null references public.fundos_fixos (id),
  descricao text not null check (length(trim(descricao)) > 0),
  data_gasto date not null,
  valor numeric(14, 2) not null check (valor > 0),
  status public.status_gasto_fundo not null default 'pendente',
  motivo_recusa text,
  decidido_por uuid references public.profiles (id),
  decidido_em timestamptz,
  lancado_por uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index fundo_gastos_fundo_idx on public.fundo_gastos (fundo_id);

create table public.fundo_gasto_anexos (
  id uuid primary key default gen_random_uuid(),
  gasto_id uuid not null references public.fundo_gastos (id),
  storage_path text not null unique,
  nome_arquivo text not null,
  mime_type text,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  assinado boolean not null default false,
  enviado_por uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.fundos_fixos enable row level security;
alter table public.fundo_gastos enable row level security;
alter table public.fundo_gasto_anexos enable row level security;

-- Visão: o dono do fundo, o Financeiro e quem pode ver a obra (administrador responsável).
create policy fundos_select on public.fundos_fixos for select to authenticated
  using (pessoa_id = auth.uid() or public.is_financeiro() or public.pode_ver_obra(obra_id));
create policy fundo_gastos_select on public.fundo_gastos for select to authenticated
  using (exists (select 1 from public.fundos_fixos f where f.id = fundo_id
         and (f.pessoa_id = auth.uid() or public.is_financeiro() or public.pode_ver_obra(f.obra_id))));
create policy fundo_anexos_select on public.fundo_gasto_anexos for select to authenticated
  using (exists (select 1 from public.fundo_gastos g join public.fundos_fixos f on f.id = g.fundo_id
         where g.id = gasto_id and (f.pessoa_id = auth.uid() or public.is_financeiro() or public.pode_ver_obra(f.obra_id))));

revoke all on public.fundos_fixos, public.fundo_gastos, public.fundo_gasto_anexos from anon;
revoke insert, update, delete, truncate on public.fundos_fixos, public.fundo_gastos, public.fundo_gasto_anexos from authenticated;
grant select on public.fundos_fixos, public.fundo_gastos, public.fundo_gasto_anexos to authenticated;

-- Saldo do fundo: valor menos os gastos aprovados.
create or replace function public._saldo_fundo(p_fundo uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select f.valor - coalesce((select sum(g.valor) from public.fundo_gastos g where g.fundo_id = f.id and g.status = 'aprovado'), 0)
    from public.fundos_fixos f where f.id = p_fundo
$$;

-- Atualiza o status pelo saldo e avisa o Financeiro quando acaba ou esgota.
create or replace function public._atualizar_status_fundo(p_fundo uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  v_saldo numeric(14, 2);
  v_novo public.status_fundo;
  v_pessoa text;
  v_obra text;
begin
  select * into f from public.fundos_fixos where id = p_fundo for update;
  if f.status = 'fechado' then
    return;
  end if;
  v_saldo := public._saldo_fundo(p_fundo);
  v_novo := case
    when v_saldo <= 0 then 'esgotado'::public.status_fundo
    when v_saldo <= f.valor * 0.10 then 'acabando'::public.status_fundo
    else 'em_andamento'::public.status_fundo
  end;
  if v_novo is distinct from f.status then
    update public.fundos_fixos set status = v_novo where id = p_fundo;
    if v_novo in ('acabando', 'esgotado') then
      select nome into v_pessoa from public.profiles where id = f.pessoa_id;
      select nome into v_obra from public.obras where id = f.obra_id;
      perform public._notificar_financeiro(
        case when v_novo = 'esgotado' then 'Fundo fixo esgotado' else 'Fundo fixo acabando' end,
        'Fundo de ' || coalesce(v_pessoa, '') || ' em ' || coalesce(v_obra, '') || ': saldo de R$ '
          || to_char(greatest(v_saldo, 0), 'FM999G999G990D00') || ' de R$ ' || to_char(f.valor, 'FM999G999G990D00')
          || '. Feche o fundo e crie um novo.',
        '/fundos-fixos', null);
    end if;
  end if;
end
$$;

-- Criar fundo (Financeiro). Um aberto por pessoa e obra.
create or replace function public.criar_fundo_fixo(p_obra_id uuid, p_pessoa_id uuid, p_valor numeric)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro cria fundos fixos.' using errcode = '42501';
  end if;
  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe um valor de fundo maior que zero.';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_pessoa_id and pr.ativo and pr.perfil in ('engenheiro', 'suprimentos')) then
    raise exception 'O fundo fixo é para engenheiro ou Suprimentos.';
  end if;
  insert into public.fundos_fixos (obra_id, pessoa_id, valor)
  values (p_obra_id, p_pessoa_id, round(p_valor, 2))
  returning id into v_id;
  perform public._auditar('fundo_fixo', v_id::text, 'criou', 'Fundo fixo criado', p_obra_id, null, null,
    jsonb_build_object('pessoa_id', p_pessoa_id, 'valor', p_valor));
  return v_id;
end
$$;

-- Lançar gasto: dono do fundo. Com administrador na obra, fica pendente; senão conta na hora.
create or replace function public.lancar_gasto_fundo(p_fundo_id uuid, p_descricao text, p_data date, p_valor numeric)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  o public.obras;
  v_id uuid;
  v_status public.status_gasto_fundo;
begin
  select * into f from public.fundos_fixos where id = p_fundo_id;
  if not found or f.pessoa_id <> auth.uid() then
    raise exception 'Somente a pessoa do fundo lança gastos nele.' using errcode = '42501';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe o valor do gasto.';
  end if;
  if nullif(trim(p_descricao), '') is null or p_data is null then
    raise exception 'Informe a descrição e a data do gasto.';
  end if;
  select * into o from public.obras where id = f.obra_id;
  v_status := case when o.administrador_id is not null then 'pendente'::public.status_gasto_fundo else 'aprovado'::public.status_gasto_fundo end;
  insert into public.fundo_gastos (fundo_id, descricao, data_gasto, valor, status, decidido_em)
  values (p_fundo_id, trim(p_descricao), p_data, round(p_valor, 2), v_status,
          case when v_status = 'aprovado' then now() end)
  returning id into v_id;
  if v_status = 'aprovado' then
    perform public._atualizar_status_fundo(p_fundo_id);
  end if;
  return v_id;
end
$$;

-- Aprovar ou recusar gasto: administrador responsável pela obra (ou administrador master).
create or replace function public.decidir_gasto_fundo(p_gasto_id uuid, p_aprovar boolean, p_motivo text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  g public.fundo_gastos;
  f public.fundos_fixos;
  o public.obras;
begin
  select * into g from public.fundo_gastos where id = p_gasto_id for update;
  if not found then
    raise exception 'Gasto não encontrado.';
  end if;
  select * into f from public.fundos_fixos where id = g.fundo_id;
  select * into o from public.obras where id = f.obra_id;
  if not (o.administrador_id = auth.uid() or public.meu_perfil() = 'administrador_master') then
    raise exception 'Somente o administrador da obra aprova gastos de fundo fixo.' using errcode = '42501';
  end if;
  if g.status <> 'pendente' then
    raise exception 'Este gasto já foi decidido.';
  end if;
  if not p_aprovar and nullif(trim(p_motivo), '') is null then
    raise exception 'Informe o motivo da recusa.';
  end if;
  update public.fundo_gastos
     set status = case when p_aprovar then 'aprovado'::public.status_gasto_fundo else 'recusado'::public.status_gasto_fundo end,
         motivo_recusa = case when p_aprovar then null else trim(p_motivo) end,
         decidido_por = auth.uid(), decidido_em = now()
   where id = p_gasto_id;
  perform public._atualizar_status_fundo(f.id);
end
$$;

-- Registrar anexo (original ou assinado) de um gasto: dono do fundo.
create or replace function public.registrar_anexo_gasto(
  p_gasto_id uuid, p_storage_path text, p_nome text, p_mime text, p_sha256 text, p_assinado boolean
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  g public.fundo_gastos;
  f public.fundos_fixos;
  v_id uuid;
begin
  select * into g from public.fundo_gastos where id = p_gasto_id;
  if not found then
    raise exception 'Gasto não encontrado.';
  end if;
  select * into f from public.fundos_fixos where id = g.fundo_id;
  if f.pessoa_id <> auth.uid() then
    raise exception 'Somente a pessoa do fundo anexa comprovantes aos gastos.' using errcode = '42501';
  end if;
  if p_storage_path not like 'fundos/' || f.id::text || '/%' then
    raise exception 'Caminho de arquivo inválido.';
  end if;
  if not exists (select 1 from storage.objects s where s.bucket_id = 'documentos' and s.name = p_storage_path) then
    raise exception 'Arquivo não encontrado no armazenamento.';
  end if;
  insert into public.fundo_gasto_anexos (gasto_id, storage_path, nome_arquivo, mime_type, sha256, assinado)
  values (p_gasto_id, p_storage_path, p_nome, p_mime, lower(p_sha256), p_assinado)
  returning id into v_id;
  return v_id;
end
$$;

-- Fechamento do fundo (Financeiro). Gera um pagamento só com o que for reposição e reembolso.
create or replace function public.fechar_fundo_fixo(p_fundo_id uuid, p_vencimento date)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  o public.obras;
  v_pessoa text;
  v_gasto numeric(14, 2);
  v_reposicao numeric(14, 2) := 0;
  v_reembolso numeric(14, 2) := 0;
  v_saldo numeric(14, 2);
  v_pag uuid;
  v_desc text;
  v_forma public.forma_pagamento := 'pix';
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro fecha fundos fixos.' using errcode = '42501';
  end if;
  select * into f from public.fundos_fixos where id = p_fundo_id for update;
  if not found or f.status = 'fechado' then
    raise exception 'Fundo não encontrado ou já fechado.';
  end if;
  select * into o from public.obras where id = f.obra_id;
  select nome into v_pessoa from public.profiles where id = f.pessoa_id;
  v_gasto := coalesce((select sum(g.valor) from public.fundo_gastos g where g.fundo_id = f.id and g.status = 'aprovado'), 0);
  v_saldo := f.valor - v_gasto;

  if f.status = 'esgotado' then
    v_reposicao := least(v_gasto, f.valor);
    v_reembolso := greatest(v_gasto - f.valor, 0);
  end if;
  -- Acabando: sem reposição; o saldo que sobrou é registrado para repassar à empresa.

  if v_reposicao + v_reembolso > 0 then
    v_desc := 'Fundo fixo (' || coalesce(v_pessoa, '') || '): reposição de R$ '
      || to_char(v_reposicao, 'FM999G999G990D00') || ' + reembolso de R$ ' || to_char(v_reembolso, 'FM999G999G990D00');
    insert into public.pagamentos (obra_id, fornecedor_id, favorecido, descricao, valor, vencimento, forma_pagamento,
                                   numero_documento, observacoes, fluxo, status, created_by)
    values (f.obra_id, null, coalesce(v_pessoa, 'Fundo fixo'), v_desc, v_reposicao + v_reembolso,
            coalesce(p_vencimento, current_date), v_forma, null,
            'Gastos aprovados do fundo fixo; anexos com as assinaturas de quem gastou.',
            'C', 'aguardando_pagamento', auth.uid())
    returning id into v_pag;
    perform public._notificar_etapa(v_pag);
  end if;

  update public.fundos_fixos
     set status = 'fechado', fechado_em = now(), reposicao = v_reposicao, reembolso = v_reembolso,
         saldo_repassado = case when v_saldo > 0 then v_saldo else 0 end, pagamento_id = v_pag
   where id = p_fundo_id;
  perform public._auditar('fundo_fixo', p_fundo_id::text, 'fechou',
    'Fundo fechado. Reposição R$ ' || v_reposicao || ', reembolso R$ ' || v_reembolso
      || case when v_saldo > 0 then ', saldo a repassar R$ ' || v_saldo else '' end,
    f.obra_id, v_pag, null, jsonb_build_object('reposicao', v_reposicao, 'reembolso', v_reembolso, 'saldo', greatest(v_saldo, 0)));
  return v_pag;
end
$$;

revoke all on function public._saldo_fundo(uuid) from public, anon, authenticated;
revoke all on function public._atualizar_status_fundo(uuid) from public, anon, authenticated;
revoke all on function public.criar_fundo_fixo(uuid, uuid, numeric) from public, anon;
revoke all on function public.lancar_gasto_fundo(uuid, text, date, numeric) from public, anon;
revoke all on function public.decidir_gasto_fundo(uuid, boolean, text) from public, anon;
revoke all on function public.registrar_anexo_gasto(uuid, text, text, text, text, boolean) from public, anon;
revoke all on function public.fechar_fundo_fixo(uuid, date) from public, anon;
grant execute on function public.criar_fundo_fixo(uuid, uuid, numeric) to authenticated;
grant execute on function public.lancar_gasto_fundo(uuid, text, date, numeric) to authenticated;
grant execute on function public.decidir_gasto_fundo(uuid, boolean, text) to authenticated;
grant execute on function public.registrar_anexo_gasto(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function public.fechar_fundo_fixo(uuid, date) to authenticated;

-- Anexos de fundo ficam no bucket de documentos, em pasta própria do fundo.
create policy fundo_anexos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos' and name like 'fundos/%'
    and exists (select 1 from public.fundos_fixos f
                where f.id = public._uuid_ou_nulo(split_part(name, '/', 2)) and f.pessoa_id = auth.uid() and f.status <> 'fechado'));
create policy fundo_anexos_leitura on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and name like 'fundos/%'
    and exists (select 1 from public.fundos_fixos f
                where f.id = public._uuid_ou_nulo(split_part(name, '/', 2))
                  and (f.pessoa_id = auth.uid() or public.is_financeiro() or public.pode_ver_obra(f.obra_id))));

-- Avisos de fundo fixo por e-mail (Financeiro).
create or replace function public._email_elegivel(p_titulo text, p_perfil public.perfil_usuario)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when p_titulo in ('Documento aguardando sua assinatura', 'Documentos aguardando sua assinatura')
      then p_perfil in ('engenheiro', 'administrador', 'administrador_master')
    when p_titulo = 'Pagamento vence amanhã'
      then p_perfil in ('financeiro', 'suprimentos')
    when p_titulo in ('Fundo fixo acabando', 'Fundo fixo esgotado')
      then p_perfil = 'financeiro'
    else false
  end
$$;
