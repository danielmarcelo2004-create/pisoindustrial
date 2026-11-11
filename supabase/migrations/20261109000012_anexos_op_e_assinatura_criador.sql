-- Anexos da OP em rascunho (comprovante, recibo ou nota). Quem é engenheiro ou administrador assina antes de anexar;
-- financeiro e suprimentos anexam sem assinar. Só a versão final fica anexada; ao enviar, vira comprovante do pagamento.
create table public.ordem_anexos (
  id uuid primary key default gen_random_uuid(),
  ordem_id uuid not null references public.ordens_pagamento (id) on delete cascade,
  storage_path text not null unique,
  nome_arquivo text not null,
  mime_type text,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  assinado boolean not null default false,
  enviado_por uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.ordem_anexos enable row level security;
create policy ordem_anexos_select on public.ordem_anexos for select to authenticated
  using (exists (select 1 from public.ordens_pagamento o where o.id = ordem_id
                 and (o.solicitante_id = auth.uid() or public.pode_ver_obra(o.obra_id))));
revoke all on public.ordem_anexos from anon;
revoke insert, update, delete, truncate on public.ordem_anexos from authenticated;

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
  or (
    split_part(p_nome, '/', 2) = 'ops'
    and exists (select 1 from public.ordens_pagamento o
                 where o.id = public._uuid_ou_nulo(split_part(p_nome, '/', 3))
                   and o.obra_id = public._uuid_ou_nulo(split_part(p_nome, '/', 1))
                   and o.solicitante_id = auth.uid() and o.status = 'em_elaboracao')
  )
$$;

create or replace function public.eh_assinante_da_etapa(p public.pagamentos)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.obras o
     where o.id = p.obra_id
       and ((p.status = 'aguardando_engenheiro' and (o.engenheiro_id = auth.uid() or (p.ordem_id is not null and p.created_by = auth.uid())))
         or (p.status = 'aguardando_administrador' and o.administrador_id = auth.uid()))
  )
$$;

revoke all on function public.eh_assinante_da_etapa(public.pagamentos) from public, anon;
grant execute on function public.eh_assinante_da_etapa(public.pagamentos) to authenticated;

create or replace function public.registrar_anexo_op(
  p_ordem_id uuid, p_storage_path text, p_nome text, p_mime text, p_sha256 text, p_assinado boolean
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  o public.ordens_pagamento;
  v_id uuid;
begin
  select * into o from public.ordens_pagamento where id = p_ordem_id;
  if not found or o.solicitante_id <> auth.uid() then
    raise exception 'Solicitação não encontrada.';
  end if;
  if o.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  if p_storage_path not like o.obra_id::text || '/ops/' || o.id::text || '/%' then
    raise exception 'Caminho de arquivo inválido.';
  end if;
  if public.meu_perfil() in ('engenheiro', 'administrador', 'administrador_master') and not coalesce(p_assinado, false) then
    raise exception 'Assine o arquivo antes de anexar.' using errcode = '42501';
  end if;
  if not exists (select 1 from storage.objects s where s.bucket_id = 'documentos' and s.name = p_storage_path) then
    raise exception 'Arquivo não encontrado no armazenamento.';
  end if;
  insert into public.ordem_anexos (ordem_id, storage_path, nome_arquivo, mime_type, sha256, assinado)
  values (p_ordem_id, p_storage_path, p_nome, p_mime, lower(p_sha256), coalesce(p_assinado, false))
  returning id into v_id;
  return v_id;
end
$$;

create or replace function public.remover_anexo_op(p_anexo_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  a public.ordem_anexos;
  o public.ordens_pagamento;
begin
  select * into a from public.ordem_anexos where id = p_anexo_id;
  if not found then
    raise exception 'Anexo não encontrado.';
  end if;
  select * into o from public.ordens_pagamento where id = a.ordem_id;
  if o.solicitante_id <> auth.uid() or o.status <> 'em_elaboracao' then
    raise exception 'Só é possível remover anexos de uma solicitação em rascunho.' using errcode = '42501';
  end if;
  delete from public.ordem_anexos where id = p_anexo_id;
end
$$;

revoke all on function public.registrar_anexo_op(uuid, text, text, text, text, boolean) from public, anon;
revoke all on function public.remover_anexo_op(uuid) from public, anon;
grant execute on function public.registrar_anexo_op(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function public.remover_anexo_op(uuid) to authenticated;

create or replace function public.minhas_pendencias()
returns setof public.pagamentos
language sql stable security invoker set search_path = ''
as $$
  select p.*
    from public.pagamentos p
    join public.obras o on o.id = p.obra_id
   where (p.status = 'aguardando_engenheiro' and (o.engenheiro_id = auth.uid() or (p.ordem_id is not null and p.created_by = auth.uid())))
      or (p.status = 'aguardando_administrador' and o.administrador_id = auth.uid())
      or (p.status = 'aguardando_pagamento' and public.pode_baixar())
$$;

create or replace function public.decidir_aprovacao(
  p_itens jsonb,
  p_decisao public.decisao_aprovacao,
  p_comentario text default null,
  p_ip text default null,
  p_user_agent text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_item jsonb;
  p public.pagamentos;
  o public.obras;
  v_etapa public.etapa_aprovacao;
  v_conteudo jsonb;
  v_hash text;
  v_lote uuid := gen_random_uuid();
  v_nome text;
  v_status_novo public.status_pagamento;
  v_resumo text;
begin
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Selecione ao menos um documento.';
  end if;
  if p_decisao = 'rejeitado' and nullif(trim(p_comentario), '') is null then
    raise exception 'Informe o motivo da rejeição.';
  end if;
  select nome into v_nome from public.profiles where id = auth.uid() and ativo;
  if v_nome is null then
    raise exception 'Usuário inválido.' using errcode = '42501';
  end if;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    select * into p from public.pagamentos where id = public._uuid_ou_nulo(v_item ->> 'id') for update;
    if not found or not public.pode_ver_obra(p.obra_id) then
      raise exception 'Pagamento não encontrado.';
    end if;
    select * into o from public.obras where id = p.obra_id;

    if p.status = 'aguardando_engenheiro' and (o.engenheiro_id = auth.uid() or (p.ordem_id is not null and p.created_by = auth.uid())) then
      v_etapa := 'engenheiro';
    elsif p.status = 'aguardando_administrador' and o.administrador_id = auth.uid() then
      v_etapa := 'administrador';
    else
      raise exception 'O pagamento nº % não está aguardando a sua assinatura.', p.numero using errcode = '42501';
    end if;

    if (v_item ->> 'versao')::int is distinct from p.versao then
      raise exception 'O pagamento nº % foi alterado depois que você o conferiu (versão atual: %). Confira novamente.',
        p.numero, p.versao;
    end if;

    -- Quem aprova precisa ter posicionado a própria assinatura no documento desta versão
    -- (quando o pagamento tem documento assinável). Assim o documento leva a assinatura de cada etapa.
    if p_decisao = 'aprovado'
       and exists (select 1 from public.documentos d where d.pagamento_id = p.id and d.ativo
                   and d.tipo not in ('comprovante', 'documento_assinado')
                   and d.mime_type in ('application/pdf', 'image/png', 'image/jpeg'))
       and not exists (select 1 from public.documentos d where d.pagamento_id = p.id and d.ativo
                       and d.tipo = 'documento_assinado' and d.enviado_por = auth.uid() and d.pagamento_versao = p.versao) then
      raise exception 'Posicione sua assinatura no documento antes de aprovar (use "Abrir e posicionar a assinatura" na tela do pagamento).'
        using errcode = '42501';
    end if;

    v_conteudo := public._conteudo_assinavel(p.id);
    v_hash := encode(sha256(convert_to(v_conteudo::text, 'UTF8')), 'hex');

    insert into public.assinaturas (pagamento_id, etapa, decisao, user_id, user_nome, pagamento_versao,
                                    hash_integridade, conteudo_assinado, comentario, lote_id, ip, user_agent)
    values (p.id, v_etapa, p_decisao, auth.uid(), v_nome, p.versao, v_hash, v_conteudo,
            nullif(trim(p_comentario), ''), v_lote, p_ip, left(p_user_agent, 500));

    if p_decisao = 'rejeitado' then
      v_status_novo := 'rejeitado';
      update public.pagamentos set status = v_status_novo, rejeicao_motivo = trim(p_comentario) where id = p.id;
    elsif v_etapa = 'engenheiro' then
      v_status_novo := 'aguardando_administrador';
      update public.pagamentos set status = v_status_novo where id = p.id;
    else
      v_status_novo := 'aguardando_pagamento';
      update public.pagamentos set status = v_status_novo where id = p.id;
    end if;

    perform public._auditar('pagamento', p.id::text,
      case p_decisao when 'aprovado' then 'assinou' else 'rejeitou' end,
      case p_decisao
        when 'aprovado' then 'Assinatura eletrônica (' || v_etapa || '), versão ' || p.versao || ', hash ' || left(v_hash, 12) || '…'
        else 'Rejeitado pelo ' || v_etapa || ': ' || trim(p_comentario)
      end
        || case when jsonb_array_length(p_itens) > 1 then ' [assinatura em lote]' else '' end,
      p.obra_id, p.id,
      jsonb_build_object('status', p.status),
      jsonb_build_object('status', v_status_novo, 'hash_integridade', v_hash, 'lote_id', v_lote));

    v_resumo := 'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ' (' || o.nome || ')';
    if p_decisao = 'rejeitado' then
      perform public._notificar(p.created_by, 'Pagamento rejeitado',
        v_resumo || '. Motivo: ' || trim(p_comentario), '/pagamentos/' || p.id, p.id);
      perform public._notificar_financeiro('Pagamento rejeitado',
        v_resumo || '. Motivo: ' || trim(p_comentario), '/pagamentos/' || p.id, p.id);
    else
      perform public._notificar_etapa(p.id);
    end if;
  end loop;

  return v_lote;
end
$$;

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
  v_anexo public.ordem_anexos;
  v_doc uuid;
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

  -- OP do Financeiro ou Suprimentos: passa pelo engenheiro responsável da obra e depois pelo administrador (fluxo A).
  -- Se faltar engenheiro ou administrador na obra, segue como antes (B com administrador; C sem).
  v_fluxo := case
    when public.meu_perfil() = 'engenheiro' and o.administrador_id is not null
      then 'A'::public.fluxo_aprovacao
    when public.meu_perfil() in ('financeiro', 'suprimentos') and o.engenheiro_id is not null and o.administrador_id is not null
      then 'A'::public.fluxo_aprovacao
    when o.administrador_id is not null then 'B'::public.fluxo_aprovacao
    else 'C'::public.fluxo_aprovacao
  end;
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

  -- Anexos da OP (comprovantes/recibos/notas assinados) viram comprovantes do pagamento.
  for v_anexo in select * from public.ordem_anexos where ordem_id = p_id order by created_at loop
    v_doc := gen_random_uuid();
    insert into public.documentos (id, pagamento_id, obra_id, tipo, nome_arquivo, storage_path, mime_type, sha256,
                                   versao, documento_original_id, enviado_por, pagamento_versao)
    values (v_doc, v_pag, o.id, 'comprovante', v_anexo.nome_arquivo, v_anexo.storage_path, v_anexo.mime_type, v_anexo.sha256,
            1, v_doc, auth.uid(), 1);
  end loop;

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
