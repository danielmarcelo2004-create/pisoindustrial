-- Fundo fixo:
--  1) O comprovante assinado por quem gastou é obrigatório: o gasto nasce "pendente" e só conta no saldo
--     depois que existir um comprovante assinado (sem administrador na obra, conta na hora em que o assinado é
--     anexado; com administrador, ele só aprova gasto que tenha o comprovante assinado).
--  2) Fundo esgotado não recebe novos gastos. A conta considera o que já está aprovado + o que aguarda
--     aprovação; o último gasto pode ultrapassar o valor do fundo (a diferença vira reembolso).

-- Quanto ainda dá para gastar: valor do fundo menos os gastos aprovados e os que aguardam aprovação.
create or replace function public._saldo_disponivel_fundo(p_fundo uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select f.valor - coalesce((select sum(g.valor) from public.fundo_gastos g where g.fundo_id = f.id and g.status in ('aprovado', 'pendente')), 0)
    from public.fundos_fixos f where f.id = p_fundo
$$;
revoke all on function public._saldo_disponivel_fundo(uuid) from public, anon, authenticated;

create or replace function public.lancar_gasto_fundo(p_fundo_id uuid, p_descricao text, p_data date, p_valor numeric)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  v_id uuid;
begin
  select * into f from public.fundos_fixos where id = p_fundo_id for update;
  if not found or f.pessoa_id <> auth.uid() then
    raise exception 'Somente a pessoa do fundo lança gastos nele.' using errcode = '42501';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if f.status = 'esgotado' or public._saldo_disponivel_fundo(f.id) <= 0 then
    raise exception 'Fundo esgotado: os gastos lançados já cobrem todo o valor do fundo. Peça ao Financeiro para fechar e repor o fundo.';
  end if;
  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe o valor do gasto.';
  end if;
  if nullif(trim(p_descricao), '') is null or p_data is null then
    raise exception 'Informe a descrição e a data do gasto.';
  end if;
  -- Sempre pendente: só conta depois do comprovante assinado (e da aprovação, se houver administrador)
  insert into public.fundo_gastos (fundo_id, descricao, data_gasto, valor, status)
  values (p_fundo_id, trim(p_descricao), p_data, round(p_valor, 2), 'pendente')
  returning id into v_id;
  return v_id;
end
$$;

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
  if p_aprovar and not exists (select 1 from public.fundo_gasto_anexos a where a.gasto_id = g.id and a.assinado) then
    raise exception 'O gasto só pode ser aprovado com o comprovante assinado por quem gastou.';
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

create or replace function public.registrar_anexo_gasto(
  p_gasto_id uuid, p_storage_path text, p_nome text, p_mime text, p_sha256 text, p_assinado boolean
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  g public.fundo_gastos;
  f public.fundos_fixos;
  o public.obras;
  v_id uuid;
begin
  select * into g from public.fundo_gastos where id = p_gasto_id for update;
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
  -- Comprovante assinado em obra sem administrador: o gasto passa a contar no saldo agora
  if p_assinado and g.status = 'pendente' and f.status <> 'fechado' then
    select * into o from public.obras where id = f.obra_id;
    if o.administrador_id is null then
      update public.fundo_gastos set status = 'aprovado', decidido_em = now() where id = g.id;
      perform public._atualizar_status_fundo(f.id);
    end if;
  end if;
  return v_id;
end
$$;

-- O aviso agora aponta o caminho certo (fechar e repor ou encerrar), não "criar um novo".
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
          || public._reais(greatest(v_saldo, 0)) || ' de R$ ' || public._reais(f.valor)
          || '. Feche o fundo: repor e continuar, ou encerrar.',
        '/fundos-fixos', null);
    end if;
  end if;
end
$$;
