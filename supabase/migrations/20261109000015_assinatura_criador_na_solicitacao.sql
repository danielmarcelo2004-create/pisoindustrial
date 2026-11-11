-- OP assinada pelo engenheiro na própria solicitação. A assinatura é aplicada ao PDF oficial no envio.
-- A assinatura vale só para o conteúdo em que foi feita: qualquer alteração exige assinar de novo.
alter table public.ordens_pagamento
  add column if not exists assinatura_criador_pos jsonb,
  add column if not exists assinatura_criador_hash text,
  add column if not exists assinatura_criador_em timestamptz;

create or replace function public.conteudo_op_hash(p_ordem_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_object(
      'favorecido', o.favorecido, 'cpf', o.cpf_cnpj, 'descricao', o.descricao, 'vencimento', o.vencimento,
      'forma', o.forma_pagamento, 'dados', o.dados_bancarios, 'obs', o.observacoes, 'nf', o.numero_nf,
      'desconto', o.desconto, 'obra', o.obra_id,
      'itens', (select jsonb_agg(jsonb_build_object('d', i.descricao, 'u', i.unidade, 'q', i.quantidade, 'v', i.valor_unitario) order by i.posicao)
                  from public.ordem_itens i where i.ordem_id = o.id),
      'parcelas', (select jsonb_agg(jsonb_build_object('n', c.numero, 'v', c.valor, 'd', c.vencimento) order by c.numero)
                     from public.ordem_parcelas c where c.ordem_id = o.id))::text, 'UTF8')), 'hex')
  from public.ordens_pagamento o
  where o.id = p_ordem_id
$$;

create or replace function public.registrar_assinatura_criador(p_ordem_id uuid, p_pos jsonb)
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
  if public.meu_perfil() <> 'engenheiro' then
    raise exception 'Somente o engenheiro assina a própria solicitação.' using errcode = '42501';
  end if;
  if o.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  if p_pos is null or jsonb_typeof(p_pos) <> 'object' then
    raise exception 'Posicione a assinatura no documento.';
  end if;
  update public.ordens_pagamento
     set assinatura_criador_pos = p_pos,
         assinatura_criador_hash = public.conteudo_op_hash(p_ordem_id),
         assinatura_criador_em = now()
   where id = p_ordem_id;
end
$$;

-- Ao enviar, a assinatura do engenheiro criador (aplicada ao PDF oficial) vira documento assinado e
-- a etapa dele fica concluída: a OP segue para o administrador.
create or replace function public.concluir_criacao_assinada(
  p_pagamento_id uuid, p_storage_path text, p_nome text, p_mime text, p_tamanho bigint, p_sha256 text
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  o public.ordens_pagamento;
  v_op_doc public.documentos;
  v_doc uuid := gen_random_uuid();
  v_nome text;
  v_conteudo jsonb;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or p.ordem_id is null or p.created_by <> auth.uid() then
    raise exception 'Pagamento não encontrado.';
  end if;
  select * into o from public.ordens_pagamento where id = p.ordem_id;
  if public.meu_perfil() <> 'engenheiro' or o.solicitante_id <> auth.uid() then
    raise exception 'Somente o engenheiro que criou a OP conclui a própria assinatura.' using errcode = '42501';
  end if;
  if p.status <> 'aguardando_engenheiro' then
    return;
  end if;
  if p_storage_path not like p.obra_id::text || '/' || p.id::text || '/%' then
    raise exception 'Caminho de arquivo inválido.';
  end if;
  if not exists (select 1 from storage.objects s where s.bucket_id = 'documentos' and s.name = p_storage_path) then
    raise exception 'Arquivo não encontrado no armazenamento.';
  end if;
  select * into v_op_doc from public.documentos d
   where d.pagamento_id = p.id and d.tipo = 'ordem_pagamento' and d.ativo
   order by d.created_at desc limit 1;
  if not found then
    raise exception 'PDF oficial da OP não encontrado.';
  end if;
  v_nome := p_nome;

  insert into public.documentos (id, pagamento_id, obra_id, tipo, nome_arquivo, storage_path, mime_type, tamanho, sha256,
                                 versao, documento_original_id, base_assinatura_id, enviado_por, pagamento_versao)
  values (v_doc, p.id, p.obra_id, 'documento_assinado', v_nome, p_storage_path, p_mime, p_tamanho, lower(p_sha256),
          2, v_op_doc.id, v_op_doc.id, auth.uid(), p.versao);

  v_conteudo := public._conteudo_assinavel(p.id);
  insert into public.assinaturas (pagamento_id, etapa, decisao, user_id, user_nome, pagamento_versao,
                                  hash_integridade, conteudo_assinado)
  select p.id, 'engenheiro', 'aprovado', auth.uid(), pr.nome, p.versao,
         encode(sha256(convert_to(v_conteudo::text, 'UTF8')), 'hex'), v_conteudo
    from public.profiles pr where pr.id = auth.uid();

  update public.pagamentos set status = 'aguardando_administrador' where id = p.id;
  perform public._auditar('pagamento', p.id::text, 'assinou', 'Engenheiro assinou a OP na solicitação',
    p.obra_id, p.id, null, jsonb_build_object('etapa', 'engenheiro'));
  perform public._notificar_etapa(p.id);
end
$$;

revoke all on function public.conteudo_op_hash(uuid) from public, anon;
revoke all on function public.registrar_assinatura_criador(uuid, jsonb) from public, anon;
revoke all on function public.concluir_criacao_assinada(uuid, text, text, text, bigint, text) from public, anon;
grant execute on function public.conteudo_op_hash(uuid) to authenticated;
grant execute on function public.registrar_assinatura_criador(uuid, jsonb) to authenticated;
grant execute on function public.concluir_criacao_assinada(uuid, text, text, text, bigint, text) to authenticated;

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
  -- Engenheiro que cria a OP assina na própria solicitação; a assinatura vale só para o conteúdo atual.
  if public.meu_perfil() = 'engenheiro' then
    if v_op.assinatura_criador_hash is null then
      raise exception 'Assine a OP antes de enviar.' using errcode = '42501';
    end if;
    if v_op.assinatura_criador_hash <> public.conteudo_op_hash(p_id) then
      raise exception 'A OP foi alterada depois da sua assinatura. Assine novamente antes de enviar.' using errcode = '42501';
    end if;
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
