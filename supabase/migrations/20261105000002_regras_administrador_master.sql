-- =============================================================================
-- Administrador master: poderes de administrador + registrar/confirmar pagamentos
-- (baixa) de todas as obras + relatórios de todas as obras + Inteligência de Compras.
-- =============================================================================

-- Pode dar baixa e anexar comprovantes: Financeiro e Administrador master.
create or replace function public.pode_baixar()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(public.meu_perfil() in ('financeiro', 'administrador_master'), false)
$$;

-- Visão de todas as obras (dados, pagamentos, documentos, relatórios).
create or replace function public.pode_ver_obra(p_obra_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case public.meu_perfil()
    when 'financeiro' then true
    when 'administrador_master' then true
    when 'suprimentos' then true
    when 'engenheiro' then exists (
      select 1 from public.obras o where o.id = p_obra_id and o.engenheiro_id = auth.uid()
    ) or exists (
      select 1 from public.obra_acessos a where a.obra_id = p_obra_id and a.user_id = auth.uid()
    )
    when 'administrador' then exists (
      select 1 from public.obras o where o.id = p_obra_id and o.administrador_id = auth.uid()
    ) or exists (
      select 1 from public.obra_acessos a where a.obra_id = p_obra_id and a.user_id = auth.uid()
    )
    else false
  end
$$;

-- Baixa de pagamento: Financeiro e Administrador master (todas as obras).
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

-- Pendências de pagamento: Financeiro e Administrador master.
create or replace function public.minhas_pendencias()
returns setof public.pagamentos
language sql stable security invoker set search_path = ''
as $$
  select p.*
    from public.pagamentos p
    join public.obras o on o.id = p.obra_id
   where (p.status = 'aguardando_engenheiro' and o.engenheiro_id = auth.uid())
      or (p.status = 'aguardando_administrador' and o.administrador_id = auth.uid())
      or (p.status = 'aguardando_pagamento' and public.pode_baixar())
$$;

create or replace function public._trg_validar_obra()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.engenheiro_id is not null and not exists (
    select 1 from public.profiles p where p.id = new.engenheiro_id and p.perfil = 'engenheiro' and p.ativo
  ) then
    raise exception 'O engenheiro responsável deve ser um usuário ativo com perfil Engenheiro.';
  end if;
  if new.administrador_id is not null and not exists (
    select 1 from public.profiles p
     where p.id = new.administrador_id and p.perfil in ('administrador', 'administrador_master') and p.ativo
  ) then
    raise exception 'O administrador responsável deve ser um usuário ativo com perfil Administrador ou Administrador master.';
  end if;
  return new;
end
$$;

-- Inteligência de Compras: administradores e administrador master também podem consultar.
drop policy if exists nf_notas_select on public.nf_notas;
drop policy if exists nf_itens_select on public.nf_itens;
create policy nf_notas_select on public.nf_notas for select to authenticated
  using (public.meu_perfil() in ('financeiro', 'suprimentos', 'administrador', 'administrador_master'));
create policy nf_itens_select on public.nf_itens for select to authenticated
  using (public.meu_perfil() in ('financeiro', 'suprimentos', 'administrador', 'administrador_master'));

-- Comprovante e envio de arquivo de quem pode dar baixa.
create or replace function public.registrar_documento(
  p_pagamento_id uuid,
  p_tipo public.tipo_documento,
  p_nome_arquivo text,
  p_storage_path text,
  p_mime_type text,
  p_tamanho bigint,
  p_sha256 text,
  p_substitui_id uuid default null,
  p_motivo text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_antigo public.documentos;
  v_id uuid := gen_random_uuid();
  v_versao int := 1;
  v_original uuid;
  v_solicitante_op boolean;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  v_solicitante_op := p.ordem_id is not null and p.created_by = auth.uid();

  if p_tipo = 'comprovante' then
    if not public.pode_baixar() then
      raise exception 'Somente o Financeiro anexa comprovantes de pagamento.' using errcode = '42501';
    end if;
    if p.status not in ('aguardando_pagamento', 'pago') then
      raise exception 'Comprovantes só podem ser anexados a pagamentos liberados ou pagos.';
    end if;
  else
    if not public.pode_atuar_obra(p.obra_id) and not v_solicitante_op then
      raise exception 'Você não tem permissão para anexar documentos nesta obra.' using errcode = '42501';
    end if;
    if p.status in ('pago', 'cancelado') then
      raise exception 'Não é possível anexar documentos a pagamentos pagos ou cancelados.';
    end if;
  end if;

  if p_storage_path not like p.obra_id::text || '/' || p.id::text || '/%' then
    raise exception 'Caminho de arquivo inválido.';
  end if;
  if not exists (select 1 from storage.objects s where s.bucket_id = 'documentos' and s.name = p_storage_path) then
    raise exception 'Arquivo não encontrado no armazenamento.';
  end if;

  if p_substitui_id is not null then
    select * into v_antigo from public.documentos d where d.id = p_substitui_id for update;
    if not found or v_antigo.pagamento_id <> p.id or not v_antigo.ativo then
      raise exception 'Documento a substituir não encontrado ou já substituído.';
    end if;
    if nullif(trim(p_motivo), '') is null then
      raise exception 'Informe o motivo da substituição.';
    end if;
    v_versao := v_antigo.versao + 1;
    v_original := coalesce(v_antigo.documento_original_id, v_antigo.id);
  end if;

  insert into public.documentos (id, pagamento_id, obra_id, tipo, nome_arquivo, storage_path, mime_type,
                                 tamanho, sha256, versao, documento_original_id, enviado_por, pagamento_versao)
  values (v_id, p.id, p.obra_id, p_tipo, p_nome_arquivo, p_storage_path, p_mime_type, p_tamanho,
          lower(p_sha256), v_versao, coalesce(v_original, v_id), auth.uid(), p.versao);

  if p_substitui_id is not null then
    update public.documentos
       set ativo = false, substituido_por = v_id, substituido_em = now(), motivo_substituicao = trim(p_motivo)
     where id = p_substitui_id;
    perform public._auditar('documento', v_id::text, 'substituiu_documento',
      'Documento substituído: ' || v_antigo.nome_arquivo || ' → ' || p_nome_arquivo
        || ' (versão ' || v_versao || '). Motivo: ' || trim(p_motivo),
      p.obra_id, p.id,
      jsonb_build_object('documento_id', v_antigo.id, 'arquivo', v_antigo.nome_arquivo, 'sha256', v_antigo.sha256, 'versao', v_antigo.versao),
      jsonb_build_object('documento_id', v_id, 'arquivo', p_nome_arquivo, 'sha256', lower(p_sha256), 'versao', v_versao, 'tipo', p_tipo));
  else
    perform public._auditar('documento', v_id::text, 'anexou_documento',
      'Anexou ' || replace(p_tipo::text, '_', ' ') || ': ' || p_nome_arquivo,
      p.obra_id, p.id, null,
      jsonb_build_object('documento_id', v_id, 'arquivo', p_nome_arquivo, 'tipo', p_tipo, 'sha256', lower(p_sha256), 'tamanho', p_tamanho));
  end if;

  if p_tipo <> 'comprovante' and (
       p_substitui_id is not null
       or exists (select 1 from public.assinaturas a where a.pagamento_id = p.id)
     ) then
    perform public._nova_versao(p.id, coalesce(p_motivo, 'documento anexado'));
  end if;

  return v_id;
end
$$;

create or replace function public.pode_enviar_arquivo(p_nome text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.pagamentos p
     where p.obra_id = public._uuid_ou_nulo(split_part(p_nome, '/', 1))
       and p.id = public._uuid_ou_nulo(split_part(p_nome, '/', 2))
       and (public.pode_atuar_obra(p.obra_id)
            or public.pode_baixar()
            or (p.ordem_id is not null and p.created_by = auth.uid() and p.status not in ('pago', 'cancelado')))
  )
$$;

