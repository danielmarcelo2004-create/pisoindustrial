-- =============================================================================
-- Solicitações de Ordem de Pagamento (OP) — especificação, seção 5.2
--
--   * O engenheiro preenche a solicitação (rascunho = "em elaboração").
--   * Ao enviar, o sistema numera a OP, cria o pagamento correspondente e anexa
--     o PDF gerado. A OP segue DIRETAMENTE ao administrador da obra (sem passar
--     por Suprimentos). Se a obra não tiver administrador, segue ao Financeiro.
--   * O status da OP acompanha o pagamento: enviada → em análise → aprovada /
--     rejeitada → paga.
-- =============================================================================

create type public.status_op as enum ('em_elaboracao', 'enviada', 'em_analise', 'aprovada', 'rejeitada', 'paga', 'cancelada');

create sequence public.ordens_pagamento_seq;

create table public.ordens_pagamento (
  id uuid primary key default gen_random_uuid(),
  numero text unique,
  obra_id uuid not null references public.obras (id),
  solicitante_id uuid not null references public.profiles (id) default auth.uid(),
  fornecedor_id uuid references public.fornecedores (id),
  favorecido text not null check (length(trim(favorecido)) > 0),
  cpf_cnpj text check (cpf_cnpj is null or cpf_cnpj ~ '^([0-9]{11}|[0-9]{14})$'),
  descricao text not null check (length(trim(descricao)) > 0),
  vencimento date,
  forma_pagamento public.forma_pagamento not null default 'pix',
  dados_bancarios text,
  observacoes text,
  status public.status_op not null default 'em_elaboracao',
  enviada_em timestamptz,
  analisada_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ordens_obra_idx on public.ordens_pagamento (obra_id);
create index ordens_solicitante_idx on public.ordens_pagamento (solicitante_id);
create trigger ordens_updated before update on public.ordens_pagamento
  for each row execute function public._tocar_updated_at();

create table public.ordem_itens (
  id uuid primary key default gen_random_uuid(),
  ordem_id uuid not null references public.ordens_pagamento (id) on delete cascade,
  posicao integer not null,
  descricao text not null check (length(trim(descricao)) > 0),
  unidade text,
  quantidade numeric(15, 3) not null check (quantidade > 0),
  valor_unitario numeric(14, 2) not null check (valor_unitario >= 0),
  total numeric(14, 2) generated always as (round(quantidade * valor_unitario, 2)) stored
);
create index ordem_itens_ordem_idx on public.ordem_itens (ordem_id, posicao);

alter table public.pagamentos add column ordem_id uuid unique references public.ordens_pagamento (id);

-- -----------------------------------------------------------------------------
-- Leitura
-- -----------------------------------------------------------------------------
alter table public.ordens_pagamento enable row level security;
alter table public.ordem_itens enable row level security;

create policy ordens_select on public.ordens_pagamento for select to authenticated
  using (solicitante_id = auth.uid()
         or (status <> 'em_elaboracao' and public.pode_ver_obra(obra_id)));
create policy ordem_itens_select on public.ordem_itens for select to authenticated
  using (exists (select 1 from public.ordens_pagamento o where o.id = ordem_id));

revoke all on public.ordens_pagamento, public.ordem_itens from anon;
revoke insert, update, delete, truncate on public.ordens_pagamento, public.ordem_itens from authenticated;

-- -----------------------------------------------------------------------------
-- RPC: salvar rascunho (criar ou alterar) — somente o engenheiro solicitante
--   p_itens: [{"descricao","unidade","quantidade","valor_unitario"}, ...]
-- -----------------------------------------------------------------------------
create or replace function public.salvar_op(
  p_id uuid,
  p_obra_id uuid,
  p_favorecido text,
  p_cpf_cnpj text,
  p_descricao text,
  p_vencimento date,
  p_forma_pagamento public.forma_pagamento,
  p_dados_bancarios text,
  p_observacoes text,
  p_itens jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_op public.ordens_pagamento;
  v_item jsonb;
  v_pos int := 0;
  v_doc text := nullif(regexp_replace(coalesce(p_cpf_cnpj, ''), '\D', '', 'g'), '');
  v_forn uuid;
begin
  if public.meu_perfil() is distinct from 'engenheiro' then
    raise exception 'Somente engenheiros solicitam Ordens de Pagamento.' using errcode = '42501';
  end if;
  if not public.pode_ver_obra(p_obra_id) then
    raise exception 'Você não está vinculado a esta obra.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.obras o where o.id = p_obra_id and o.status = 'ativa') then
    raise exception 'A obra não está ativa.';
  end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Informe ao menos um item.';
  end if;
  if v_doc is not null and length(v_doc) not in (11, 14) then
    raise exception 'CPF deve ter 11 dígitos e CNPJ 14 dígitos.';
  end if;
  if v_doc is not null then
    select f.id into v_forn from public.fornecedores f where f.cpf_cnpj = v_doc;
  end if;

  if v_id is null then
    insert into public.ordens_pagamento (obra_id, solicitante_id, fornecedor_id, favorecido, cpf_cnpj, descricao,
                                         vencimento, forma_pagamento, dados_bancarios, observacoes)
    values (p_obra_id, auth.uid(), v_forn, trim(p_favorecido), v_doc, trim(p_descricao), p_vencimento,
            p_forma_pagamento, nullif(trim(p_dados_bancarios), ''), nullif(trim(p_observacoes), ''))
    returning id into v_id;
  else
    select * into v_op from public.ordens_pagamento where id = v_id for update;
    if not found or v_op.solicitante_id <> auth.uid() then
      raise exception 'Solicitação não encontrada.';
    end if;
    if v_op.status <> 'em_elaboracao' then
      raise exception 'A solicitação já foi enviada e não pode mais ser alterada.';
    end if;
    update public.ordens_pagamento set
      obra_id = p_obra_id, fornecedor_id = v_forn, favorecido = trim(p_favorecido), cpf_cnpj = v_doc,
      descricao = trim(p_descricao), vencimento = p_vencimento, forma_pagamento = p_forma_pagamento,
      dados_bancarios = nullif(trim(p_dados_bancarios), ''), observacoes = nullif(trim(p_observacoes), '')
    where id = v_id;
    delete from public.ordem_itens where ordem_id = v_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    v_pos := v_pos + 1;
    insert into public.ordem_itens (ordem_id, posicao, descricao, unidade, quantidade, valor_unitario)
    values (v_id, v_pos, trim(v_item ->> 'descricao'), nullif(trim(v_item ->> 'unidade'), ''),
            (v_item ->> 'quantidade')::numeric, (v_item ->> 'valor_unitario')::numeric);
  end loop;
  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: excluir rascunho
-- -----------------------------------------------------------------------------
create or replace function public.excluir_op(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.ordens_pagamento
   where id = p_id and solicitante_id = auth.uid() and status = 'em_elaboracao';
  if not found then
    raise exception 'Somente rascunhos do próprio solicitante podem ser excluídos.';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: enviar OP — numera, cria o pagamento e encaminha ao administrador.
-- Retorna o id do pagamento (o PDF é anexado em seguida pelo servidor).
-- -----------------------------------------------------------------------------
create or replace function public.enviar_op(p_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_op public.ordens_pagamento;
  o public.obras;
  v_total numeric(14, 2);
  v_fluxo public.fluxo_aprovacao;
  v_pag uuid;
  v_numero text;
begin
  select * into v_op from public.ordens_pagamento where id = p_id for update;
  if not found or v_op.solicitante_id <> auth.uid() then
    raise exception 'Solicitação não encontrada.';
  end if;
  if v_op.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  if public.meu_perfil() is distinct from 'engenheiro' or not public.pode_ver_obra(v_op.obra_id) then
    raise exception 'Você não está vinculado a esta obra.' using errcode = '42501';
  end if;
  if v_op.vencimento is null then
    raise exception 'Informe a data de vencimento antes de enviar.';
  end if;
  select coalesce(sum(i.total), 0) into v_total from public.ordem_itens i where i.ordem_id = p_id;
  if v_total <= 0 then
    raise exception 'O valor total da OP deve ser maior que zero.';
  end if;
  select * into o from public.obras where id = v_op.obra_id;
  if o.status <> 'ativa' then
    raise exception 'A obra não está ativa.';
  end if;

  -- Regra da OP: segue direto ao administrador da obra; sem administrador, ao Financeiro.
  v_fluxo := case when o.administrador_id is not null then 'B'::public.fluxo_aprovacao else 'C'::public.fluxo_aprovacao end;
  v_numero := 'OP-' || to_char(now() at time zone 'America/Sao_Paulo', 'YYYY') || '-'
              || lpad(nextval('public.ordens_pagamento_seq')::text, 5, '0');

  update public.ordens_pagamento
     set numero = v_numero, status = 'enviada', enviada_em = now()
   where id = p_id;

  insert into public.pagamentos (obra_id, fornecedor_id, favorecido, descricao, valor, vencimento, forma_pagamento,
                                 numero_documento, observacoes, fluxo, status, created_by, ordem_id)
  values (o.id, v_op.fornecedor_id, v_op.favorecido, v_op.descricao, v_total, v_op.vencimento, v_op.forma_pagamento,
          v_numero, v_op.observacoes, v_fluxo, public._status_inicial(v_fluxo), auth.uid(), p_id)
  returning id into v_pag;

  perform public._auditar('pagamento', v_pag::text, 'criou',
    'Ordem de pagamento ' || v_numero || ' solicitada pelo engenheiro'
      || case when v_fluxo = 'B' then ' e encaminhada ao administrador' else ' e encaminhada ao Financeiro (obra sem administrador)' end,
    o.id, v_pag, null, (select to_jsonb(p) from public.pagamentos p where p.id = v_pag));
  perform public._notificar_etapa(v_pag);
  return v_pag;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: marcar OP como "em análise" quando o administrador a abre
-- -----------------------------------------------------------------------------
create or replace function public.marcar_op_em_analise(p_pagamento_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.ordens_pagamento op
     set status = 'em_analise', analisada_em = now()
    from public.pagamentos p
    join public.obras o on o.id = p.obra_id
   where p.id = p_pagamento_id
     and op.id = p.ordem_id
     and op.status = 'enviada'
     and p.status = 'aguardando_administrador'
     and o.administrador_id = auth.uid();
end
$$;

-- -----------------------------------------------------------------------------
-- Status da OP acompanha o pagamento
-- -----------------------------------------------------------------------------
create or replace function public._trg_sincronizar_op()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_novo public.status_op;
  v_op public.ordens_pagamento;
begin
  if new.ordem_id is null or new.status is not distinct from old.status then
    return new;
  end if;
  select * into v_op from public.ordens_pagamento where id = new.ordem_id;

  v_novo := case new.status
    when 'aguardando_administrador' then 'enviada'
    when 'aguardando_engenheiro' then 'enviada'
    when 'aguardando_pagamento' then
      case when exists (select 1 from public.assinaturas a
                         where a.pagamento_id = new.id and a.decisao = 'aprovado' and a.pagamento_versao = new.versao)
           then 'aprovada' else 'em_analise' end
    when 'rejeitado' then 'rejeitada'
    when 'pago' then 'paga'
    when 'cancelado' then 'cancelada'
  end::public.status_op;

  if v_novo is distinct from v_op.status then
    update public.ordens_pagamento set status = v_novo where id = new.ordem_id;
    -- Rejeição e pagamento já notificam quem cadastrou (o engenheiro).
    if v_novo = 'aprovada' then
      perform public._notificar(v_op.solicitante_id, 'Sua OP foi aprovada',
        v_op.numero || ' — ' || v_op.favorecido || ' foi aprovada e seguiu para o Financeiro.',
        '/ops/' || v_op.id, new.id);
    end if;
  end if;
  return new;
end
$$;
create trigger pagamentos_sincronizar_op after update of status on public.pagamentos
  for each row execute function public._trg_sincronizar_op();

-- -----------------------------------------------------------------------------
-- Ajustes nas regras existentes para a OP
-- -----------------------------------------------------------------------------

-- O engenheiro solicitante pode anexar o PDF da OP ao pagamento gerado por ela.
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
            or (p.ordem_id is not null and p.created_by = auth.uid() and p.status not in ('pago', 'cancelado')))
  )
$$;

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

  if p_tipo <> 'comprovante' and (
       p_substitui_id is not null
       or exists (select 1 from public.assinaturas a where a.pagamento_id = p.id)
     ) then
    perform public._nova_versao(p.id, coalesce(p_motivo, 'documento anexado'));
  end if;

  return v_id;
end
$$;

-- Mudança de fluxo da obra: a OP continua com o administrador (regra própria);
-- só é reencaminhada se a obra ficar sem administrador.
create or replace function public._trg_obra_fluxo_alterado()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  r public.pagamentos;
  v_novo public.status_pagamento;
begin
  if new.fluxo is not distinct from old.fluxo
     and new.engenheiro_id is not distinct from old.engenheiro_id
     and new.administrador_id is not distinct from old.administrador_id then
    return new;
  end if;

  for r in
    select * from public.pagamentos
     where obra_id = new.id and status in ('aguardando_engenheiro', 'aguardando_administrador')
     for update
  loop
    v_novo := r.status;
    if r.ordem_id is not null then
      if r.status = 'aguardando_administrador' and new.administrador_id is null then
        v_novo := 'aguardando_pagamento';
      end if;
    elsif r.status = 'aguardando_engenheiro' and new.fluxo <> 'A' then
      v_novo := public._status_inicial(new.fluxo);
    elsif r.status = 'aguardando_administrador' and new.fluxo = 'C' then
      v_novo := 'aguardando_pagamento';
    end if;

    if v_novo <> r.status then
      update public.pagamentos set status = v_novo, fluxo = case when r.ordem_id is null then new.fluxo else 'C' end where id = r.id;
      perform public._auditar('pagamento', r.id::text, 'reencaminhou',
        case when r.ordem_id is null
          then 'Fluxo da obra alterado de ' || old.fluxo || ' para ' || new.fluxo || '; pagamento reencaminhado.'
          else 'A obra ficou sem administrador; OP encaminhada ao Financeiro.' end,
        new.id, r.id, jsonb_build_object('status', r.status, 'fluxo', r.fluxo),
        jsonb_build_object('status', v_novo));
      perform public._notificar_etapa(r.id);
    elsif (r.status = 'aguardando_engenheiro' and new.engenheiro_id is distinct from old.engenheiro_id)
       or (r.status = 'aguardando_administrador' and new.administrador_id is distinct from old.administrador_id) then
      perform public._auditar('pagamento', r.id::text, 'reencaminhou',
        'Responsável da obra alterado; pendência encaminhada ao novo responsável.',
        new.id, r.id, null, null);
      perform public._notificar_etapa(r.id);
    end if;
  end loop;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- Privilégios
-- -----------------------------------------------------------------------------
revoke all on function public._trg_sincronizar_op() from public, anon, authenticated;
revoke all on function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb) from public, anon;
revoke all on function public.excluir_op(uuid) from public, anon;
revoke all on function public.enviar_op(uuid) from public, anon;
revoke all on function public.marcar_op_em_analise(uuid) from public, anon;
grant execute on function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb) to authenticated;
grant execute on function public.excluir_op(uuid) to authenticated;
grant execute on function public.enviar_op(uuid) to authenticated;
grant execute on function public.marcar_op_em_analise(uuid) to authenticated;
