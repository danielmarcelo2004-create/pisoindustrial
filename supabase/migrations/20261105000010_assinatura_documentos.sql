-- Assinatura de documentos com imagem (PNG/JPG) guardada no perfil.
-- A assinatura é uma marca visual: o sistema registra quem assinou, quando e o hash do arquivo.
alter table public.profiles add column if not exists assinatura_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assinaturas', 'assinaturas', false, 2097152, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

-- Cada pessoa grava a própria assinatura em uma pasta com o seu identificador.
create policy assinaturas_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'assinaturas' and name like auth.uid()::text || '/%');
create policy assinaturas_update on storage.objects for update to authenticated
  using (bucket_id = 'assinaturas' and name like auth.uid()::text || '/%')
  with check (bucket_id = 'assinaturas' and name like auth.uid()::text || '/%');
create policy assinaturas_delete on storage.objects for delete to authenticated
  using (bucket_id = 'assinaturas' and name like auth.uid()::text || '/%');
create policy assinaturas_select on storage.objects for select to authenticated
  using (bucket_id = 'assinaturas' and (name like auth.uid()::text || '/%' or public.is_financeiro()));

create or replace function public.definir_assinatura(p_path text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_path is null or p_path not like auth.uid()::text || '/%' then
    raise exception 'Caminho de assinatura inválido.';
  end if;
  update public.profiles set assinatura_path = p_path where id = auth.uid();
end
$$;

revoke all on function public.definir_assinatura(text) from public, anon;
grant execute on function public.definir_assinatura(text) to authenticated;

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

  if p_tipo = 'documento_assinado' then
    if public.meu_perfil() not in ('engenheiro', 'administrador', 'administrador_master', 'financeiro', 'suprimentos') then
      raise exception 'Seu perfil não assina documentos.' using errcode = '42501';
    end if;
  elsif p_tipo = 'comprovante' then
    if not public.is_financeiro() then
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

  if p_tipo not in ('comprovante', 'documento_assinado') and (
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
            or public.is_financeiro()
            or (p.ordem_id is not null and p.created_by = auth.uid() and p.status not in ('pago', 'cancelado'))
            or public.meu_perfil() in ('engenheiro', 'administrador', 'administrador_master'))
  )
$$;


