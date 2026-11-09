-- Cadeia de assinaturas: aprovar exige que quem aprova tenha assinado o documento da versão atual.
-- O administrador assina sobre a versão já assinada pelo engenheiro, então o documento final leva as duas.

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

    if p.status = 'aguardando_engenheiro' and o.engenheiro_id = auth.uid() then
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
                   and d.tipo not in ('comprovante', 'ordem_pagamento', 'documento_assinado')
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
