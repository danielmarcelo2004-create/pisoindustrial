-- Assinatura com imagem: o engenheiro (ou o administrador) que assina a etapa atual pode anexar
-- a versão assinada do documento. Antes, só quem "atua" na obra (financeiro, suprimentos com acesso)
-- conseguia, e a assinatura do engenheiro não gerava a versão assinada no anexo.

-- Quem é o assinante da etapa atual deste pagamento.
create or replace function public.eh_assinante_da_etapa(p public.pagamentos)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.obras o
     where o.id = p.obra_id
       and ((p.status = 'aguardando_engenheiro' and o.engenheiro_id = auth.uid())
         or (p.status = 'aguardando_administrador' and o.administrador_id = auth.uid()))
  )
$$;

revoke all on function public.eh_assinante_da_etapa(public.pagamentos) from public, anon;
grant execute on function public.eh_assinante_da_etapa(public.pagamentos) to authenticated;

-- Regra de envio de arquivos (pagamentos, medições e assinantes da etapa).
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
            or public.eh_assinante_da_etapa(p))
  )
  or (
    split_part(p_nome, '/', 2) = 'medicoes'
    and (public.is_financeiro() or public.meu_perfil() = 'suprimentos')
    and public.pode_ver_obra(public._uuid_ou_nulo(split_part(p_nome, '/', 1)))
  )
$$;

-- Registro de documento: mesma função da versão atual, com a permissão do assinante da etapa.
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
    if not public.pode_atuar_obra(p.obra_id) and not v_solicitante_op
       and not (p_tipo = 'documento_assinado' and public.eh_assinante_da_etapa(p)) then
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
