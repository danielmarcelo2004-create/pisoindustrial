-- Cadeia de assinaturas: cada versão assinada aponta para a versão que ela assina.
-- O engenheiro assina o original; o administrador assina a versão do engenheiro (a mais recente).
-- Assim o histórico fica completo e só a versão mais recente pode receber a próxima assinatura.
alter table public.documentos add column if not exists base_assinatura_id uuid references public.documentos (id);

-- Documento original (raiz) de uma cadeia de assinaturas.
create or replace function public._raiz_assinatura(p_id uuid)
returns uuid
language sql stable set search_path = ''
as $$
  with recursive cadeia as (
    select d.id, d.base_assinatura_id from public.documentos d where d.id = p_id
    union all
    select b.id, b.base_assinatura_id from public.documentos b join cadeia c on b.id = c.base_assinatura_id
  )
  select id from cadeia where base_assinatura_id is null limit 1
$$;

create or replace function public.registrar_assinatura(
  p_pagamento_id uuid,
  p_base_id uuid,
  p_nome_arquivo text,
  p_storage_path text,
  p_mime_type text,
  p_tamanho bigint,
  p_sha256 text
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  b public.documentos;
  v_raiz uuid;
  v_id uuid := gen_random_uuid();
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  if public.meu_perfil() not in ('engenheiro', 'administrador', 'administrador_master') then
    raise exception 'Somente engenheiro e administrador assinam documentos.' using errcode = '42501';
  end if;
  if p.status in ('pago', 'cancelado', 'rejeitado') then
    raise exception 'Este pagamento não recebe novas assinaturas.';
  end if;

  select * into b from public.documentos where id = p_base_id;
  if not found or b.pagamento_id <> p.id or not b.ativo then
    raise exception 'Documento a assinar não encontrado.';
  end if;
  if b.pagamento_versao <> p.versao then
    raise exception 'Esta versão do documento é anterior à versão atual do pagamento. Assine a versão mais recente.';
  end if;
  if exists (select 1 from public.documentos d where d.base_assinatura_id = b.id) then
    raise exception 'Esta versão já recebeu assinatura. Assine a versão mais recente.';
  end if;

  v_raiz := public._raiz_assinatura(b.id);
  if exists (select 1 from public.documentos d
              where d.tipo = 'documento_assinado' and d.pagamento_versao = p.versao
                and public._raiz_assinatura(d.id) = v_raiz and d.enviado_por = auth.uid()) then
    raise exception 'Você já assinou esta versão do documento.';
  end if;

  if p_storage_path not like p.obra_id::text || '/' || p.id::text || '/%' then
    raise exception 'Caminho de arquivo inválido.';
  end if;
  if not exists (select 1 from storage.objects s where s.bucket_id = 'documentos' and s.name = p_storage_path) then
    raise exception 'Arquivo não encontrado no armazenamento.';
  end if;

  insert into public.documentos (id, pagamento_id, obra_id, tipo, nome_arquivo, storage_path, mime_type, tamanho, sha256,
                                 versao, documento_original_id, enviado_por, pagamento_versao, base_assinatura_id)
  values (v_id, p.id, p.obra_id, 'documento_assinado', p_nome_arquivo, p_storage_path, p_mime_type, p_tamanho,
          lower(p_sha256), b.versao + 1, v_raiz, auth.uid(), p.versao, b.id);

  perform public._auditar('pagamento', p.id::text, 'anexou_documento', 'Documento assinado: ' || p_nome_arquivo,
    p.obra_id, p.id, null, jsonb_build_object('documento_id', v_id, 'base_id', b.id));
  return v_id;
end
$$;

revoke all on function public.registrar_assinatura(uuid, uuid, text, text, text, bigint, text) from public, anon;
grant execute on function public.registrar_assinatura(uuid, uuid, text, text, text, bigint, text) to authenticated;
