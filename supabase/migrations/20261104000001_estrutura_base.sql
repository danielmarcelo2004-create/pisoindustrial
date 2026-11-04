-- =============================================================================
-- Sistema Financeiro de Obras — estrutura base
--
-- Princípios (especificação, seções 3, 9 e 10):
--   * Cada pessoa tem credencial individual (auth.users + public.profiles).
--   * O isolamento por obra é aplicado NO BANCO (Row Level Security), não só na
--     interface. Toda leitura passa pelas policies abaixo.
--   * Pagamentos, documentos e assinaturas só são alterados por funções
--     (RPC) que validam permissão, registram auditoria e disparam notificações
--     na mesma transação. Não há policy de INSERT/UPDATE/DELETE direto nessas
--     tabelas.
--   * A auditoria é imutável: triggers bloqueiam UPDATE/DELETE/TRUNCATE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
create type public.perfil_usuario as enum ('financeiro', 'suprimentos', 'engenheiro', 'administrador');
create type public.fluxo_aprovacao as enum ('A', 'B', 'C');
create type public.status_obra as enum ('ativa', 'suspensa', 'concluida');
create type public.status_pagamento as enum (
  'aguardando_engenheiro',
  'aguardando_administrador',
  'aguardando_pagamento',
  'pago',
  'rejeitado',
  'cancelado'
);
create type public.tipo_documento as enum ('boleto', 'nota_fiscal', 'ordem_pagamento', 'comprovante', 'outro');
create type public.etapa_aprovacao as enum ('engenheiro', 'administrador');
create type public.decisao_aprovacao as enum ('aprovado', 'rejeitado');
create type public.forma_pagamento as enum ('boleto', 'pix', 'transferencia', 'dinheiro', 'cartao', 'outro');

-- -----------------------------------------------------------------------------
-- Tabelas
-- -----------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  nome text not null check (length(trim(nome)) > 0),
  email text not null unique,
  telefone text,
  perfil public.perfil_usuario not null,
  ativo boolean not null default true,
  troca_senha_pendente boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.profiles.telefone is 'Telefone/WhatsApp para alertas (o WhatsApp é apenas canal de aviso).';

create table public.obras (
  id uuid primary key default gen_random_uuid(),
  codigo text unique,
  nome text not null check (length(trim(nome)) > 0),
  cliente text,
  endereco text,
  cidade text not null check (length(trim(cidade)) > 0),
  uf char(2) not null check (uf ~ '^[A-Z]{2}$'),
  engenheiro_id uuid references public.profiles (id),
  administrador_id uuid references public.profiles (id),
  fluxo public.fluxo_aprovacao not null default 'C',
  status public.status_obra not null default 'ativa',
  observacoes text,
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint obras_fluxo_responsaveis check (
    (fluxo <> 'A' or (engenheiro_id is not null and administrador_id is not null))
    and (fluxo <> 'B' or administrador_id is not null)
  )
);
comment on column public.obras.fluxo is 'A: engenheiro e depois administrador; B: somente administrador; C: direto ao financeiro.';

-- Acessos explícitos concedidos pelo Financeiro (Suprimentos, e vínculos extras
-- de engenheiros/administradores além do responsável principal).
create table public.obra_acessos (
  obra_id uuid not null references public.obras (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  concedido_por uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (obra_id, user_id)
);
create index obra_acessos_user_idx on public.obra_acessos (user_id);

create table public.fornecedores (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) > 0),
  cpf_cnpj text unique check (cpf_cnpj is null or cpf_cnpj ~ '^([0-9]{11}|[0-9]{14})$'),
  email text,
  telefone text,
  cidade text,
  uf char(2) check (uf is null or uf ~ '^[A-Z]{2}$'),
  chave_pix text,
  banco text,
  agencia text,
  conta text,
  observacoes text,
  ativo boolean not null default true,
  created_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pagamentos (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity unique,
  obra_id uuid not null references public.obras (id),
  fornecedor_id uuid references public.fornecedores (id),
  favorecido text not null check (length(trim(favorecido)) > 0),
  descricao text not null check (length(trim(descricao)) > 0),
  valor numeric(14, 2) not null check (valor > 0),
  vencimento date not null,
  forma_pagamento public.forma_pagamento not null default 'boleto',
  numero_documento text,
  observacoes text,
  fluxo public.fluxo_aprovacao not null,
  status public.status_pagamento not null,
  versao integer not null default 1,
  rejeicao_motivo text,
  cancelamento_motivo text,
  pago_em date,
  valor_pago numeric(14, 2),
  pago_por uuid references public.profiles (id),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pagamentos_obra_idx on public.pagamentos (obra_id);
create index pagamentos_status_venc_idx on public.pagamentos (status, vencimento);
create index pagamentos_fornecedor_idx on public.pagamentos (fornecedor_id);

create table public.documentos (
  id uuid primary key default gen_random_uuid(),
  pagamento_id uuid not null references public.pagamentos (id),
  obra_id uuid not null references public.obras (id),
  tipo public.tipo_documento not null,
  nome_arquivo text not null,
  storage_path text not null unique,
  mime_type text,
  tamanho bigint,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  versao integer not null default 1,
  -- Primeiro documento da cadeia de versões (ele mesmo na versão 1).
  documento_original_id uuid references public.documentos (id),
  substituido_por uuid references public.documentos (id),
  substituido_em timestamptz,
  motivo_substituicao text,
  ativo boolean not null default true,
  enviado_por uuid not null references public.profiles (id),
  pagamento_versao integer not null,
  created_at timestamptz not null default now()
);
create index documentos_pagamento_idx on public.documentos (pagamento_id);

create table public.assinaturas (
  id uuid primary key default gen_random_uuid(),
  pagamento_id uuid not null references public.pagamentos (id),
  etapa public.etapa_aprovacao not null,
  decisao public.decisao_aprovacao not null,
  user_id uuid not null references public.profiles (id),
  user_nome text not null,
  pagamento_versao integer not null,
  -- SHA-256 do conteúdo canônico assinado (dados do pagamento + hashes dos
  -- documentos ativos naquela versão). Permite verificar integridade depois.
  hash_integridade text not null,
  conteudo_assinado jsonb not null,
  comentario text,
  lote_id uuid,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index assinaturas_pagamento_idx on public.assinaturas (pagamento_id);

create table public.auditoria (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid,
  user_nome text,
  user_perfil public.perfil_usuario,
  entidade text not null,
  entidade_id text,
  obra_id uuid,
  pagamento_id uuid,
  acao text not null,
  descricao text,
  dados_antes jsonb,
  dados_depois jsonb
);
create index auditoria_pagamento_idx on public.auditoria (pagamento_id, created_at);
create index auditoria_obra_idx on public.auditoria (obra_id, created_at);
create index auditoria_created_idx on public.auditoria (created_at desc);

create table public.notificacoes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  titulo text not null,
  mensagem text,
  link text,
  pagamento_id uuid references public.pagamentos (id),
  lida_em timestamptz,
  -- Fila para o futuro envio de alertas por WhatsApp ('pendente' quando o
  -- destinatário tem telefone cadastrado). O envio não faz parte desta versão.
  whatsapp_status text check (whatsapp_status in ('pendente', 'enviado', 'falhou', 'ignorado')),
  created_at timestamptz not null default now()
);
create index notificacoes_user_idx on public.notificacoes (user_id, lida_em, created_at desc);

-- -----------------------------------------------------------------------------
-- Funções auxiliares de permissão (SECURITY DEFINER para evitar recursão de RLS)
-- -----------------------------------------------------------------------------
create or replace function public.meu_perfil()
returns public.perfil_usuario
language sql stable security definer set search_path = ''
as $$
  select p.perfil from public.profiles p where p.id = auth.uid() and p.ativo
$$;

create or replace function public.is_financeiro()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(public.meu_perfil() = 'financeiro', false)
$$;

-- Pode VER a obra e seus pagamentos/documentos.
--   Financeiro e Suprimentos: todas as obras (Suprimentos visualiza todas).
--   Engenheiro/Administrador: somente obras em que é responsável ou foi vinculado.
create or replace function public.pode_ver_obra(p_obra_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case public.meu_perfil()
    when 'financeiro' then true
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

-- Pode ATUAR (cadastrar pagamentos, anexar documentos, editar) na obra.
--   Financeiro: todas. Suprimentos: somente obras liberadas pelo Financeiro.
create or replace function public.pode_atuar_obra(p_obra_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case public.meu_perfil()
    when 'financeiro' then true
    when 'suprimentos' then exists (
      select 1 from public.obra_acessos a where a.obra_id = p_obra_id and a.user_id = auth.uid()
    )
    else false
  end
$$;

create or replace function public._uuid_ou_nulo(p_texto text)
returns uuid
language plpgsql immutable set search_path = ''
as $$
begin
  return p_texto::uuid;
exception when others then
  return null;
end
$$;

-- -----------------------------------------------------------------------------
-- updated_at
-- -----------------------------------------------------------------------------
create or replace function public._tocar_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger profiles_updated before update on public.profiles for each row execute function public._tocar_updated_at();
create trigger obras_updated before update on public.obras for each row execute function public._tocar_updated_at();
create trigger fornecedores_updated before update on public.fornecedores for each row execute function public._tocar_updated_at();
create trigger pagamentos_updated before update on public.pagamentos for each row execute function public._tocar_updated_at();

-- -----------------------------------------------------------------------------
-- Auditoria
-- -----------------------------------------------------------------------------
create or replace function public._auditar(
  p_entidade text,
  p_entidade_id text,
  p_acao text,
  p_descricao text,
  p_obra_id uuid default null,
  p_pagamento_id uuid default null,
  p_antes jsonb default null,
  p_depois jsonb default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_nome text;
  v_perfil public.perfil_usuario;
begin
  select p.nome, p.perfil into v_nome, v_perfil from public.profiles p where p.id = auth.uid();
  insert into public.auditoria (user_id, user_nome, user_perfil, entidade, entidade_id, obra_id,
                                pagamento_id, acao, descricao, dados_antes, dados_depois)
  values (auth.uid(), coalesce(v_nome, case when auth.uid() is null then 'Sistema' end), v_perfil,
          p_entidade, p_entidade_id, p_obra_id, p_pagamento_id, p_acao, p_descricao, p_antes, p_depois);
end
$$;

-- Mantém apenas as chaves alteradas entre dois registros.
create or replace function public._diff_jsonb(p_antes jsonb, p_depois jsonb, out antes jsonb, out depois jsonb)
language sql immutable set search_path = ''
as $$
  select
    coalesce(jsonb_object_agg(k, p_antes -> k) filter (where p_antes -> k is distinct from p_depois -> k), '{}'::jsonb),
    coalesce(jsonb_object_agg(k, p_depois -> k) filter (where p_antes -> k is distinct from p_depois -> k), '{}'::jsonb)
  from (select jsonb_object_keys(p_antes || p_depois) as k) chaves
  where k not in ('updated_at', 'created_at')
$$;

-- Trigger genérico para tabelas cadastrais (obras, acessos, fornecedores, usuários).
create or replace function public._trg_auditar_cadastro()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_antes jsonb;
  v_depois jsonb;
  v_obra uuid;
  v_id text;
  v_acao text;
  v_desc text;
begin
  if tg_op = 'INSERT' then
    v_depois := to_jsonb(new);
    v_acao := 'criou';
  elsif tg_op = 'UPDATE' then
    select d.antes, d.depois into v_antes, v_depois from public._diff_jsonb(to_jsonb(old), to_jsonb(new)) d;
    if v_depois = '{}'::jsonb then
      return new;
    end if;
    v_acao := 'alterou';
  else
    v_antes := to_jsonb(old);
    v_acao := 'removeu';
  end if;

  v_id := coalesce(to_jsonb(new), to_jsonb(old)) ->> 'id';
  if tg_table_name = 'obras' then
    v_obra := (coalesce(to_jsonb(new), to_jsonb(old)) ->> 'id')::uuid;
  elsif tg_table_name = 'obra_acessos' then
    v_obra := (coalesce(to_jsonb(new), to_jsonb(old)) ->> 'obra_id')::uuid;
    v_id := coalesce(to_jsonb(new), to_jsonb(old)) ->> 'user_id';
  end if;

  v_desc := case tg_table_name
    when 'obras' then case v_acao when 'criou' then 'Obra cadastrada' when 'alterou' then 'Obra alterada' else 'Obra removida' end
    when 'obra_acessos' then case v_acao when 'criou' then 'Acesso à obra concedido' else 'Acesso à obra revogado' end
    when 'fornecedores' then case v_acao when 'criou' then 'Fornecedor cadastrado' when 'alterou' then 'Fornecedor alterado' else 'Fornecedor removido' end
    when 'profiles' then case v_acao when 'criou' then 'Usuário criado' when 'alterou' then 'Usuário alterado' else 'Usuário removido' end
    else tg_table_name
  end;

  perform public._auditar(tg_table_name, v_id, v_acao, v_desc, v_obra, null, v_antes, v_depois);
  return coalesce(new, old);
end
$$;

create trigger auditar_obras after insert or update or delete on public.obras
  for each row execute function public._trg_auditar_cadastro();
create trigger auditar_obra_acessos after insert or delete on public.obra_acessos
  for each row execute function public._trg_auditar_cadastro();
create trigger auditar_fornecedores after insert or update or delete on public.fornecedores
  for each row execute function public._trg_auditar_cadastro();
create trigger auditar_profiles after insert or update or delete on public.profiles
  for each row execute function public._trg_auditar_cadastro();

-- Auditoria imutável (vale inclusive para o service role).
create or replace function public._trg_auditoria_imutavel()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'O histórico de auditoria não pode ser alterado nem apagado.';
end
$$;
create trigger auditoria_sem_update before update or delete on public.auditoria
  for each row execute function public._trg_auditoria_imutavel();
create trigger auditoria_sem_truncate before truncate on public.auditoria
  for each statement execute function public._trg_auditoria_imutavel();

-- Assinaturas também são imutáveis.
create trigger assinaturas_imutaveis before update or delete on public.assinaturas
  for each row execute function public._trg_auditoria_imutavel();

-- -----------------------------------------------------------------------------
-- Validações de cadastro
-- -----------------------------------------------------------------------------
create or replace function public._trg_validar_obra()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.engenheiro_id is not null and not exists (
    select 1 from public.profiles p where p.id = new.engenheiro_id and p.perfil = 'engenheiro' and p.ativo
  ) then
    raise exception 'O engenheiro responsável deve ser um usuário ativo com perfil Engenheiro.';
  end if;
  if new.administrador_id is not null and not exists (
    select 1 from public.profiles p where p.id = new.administrador_id and p.perfil = 'administrador' and p.ativo
  ) then
    raise exception 'O administrador responsável deve ser um usuário ativo com perfil Administrador da obra.';
  end if;
  return new;
end
$$;
create trigger obras_validar before insert or update of engenheiro_id, administrador_id on public.obras
  for each row execute function public._trg_validar_obra();

create or replace function public._trg_validar_profile()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.id = auth.uid() and (new.perfil <> old.perfil or (old.ativo and not new.ativo)) then
    raise exception 'Você não pode alterar o próprio perfil nem desativar o próprio acesso.';
  end if;
  if new.email <> old.email then
    raise exception 'O e-mail de login não pode ser alterado por aqui.';
  end if;
  return new;
end
$$;
create trigger profiles_validar before update on public.profiles
  for each row execute function public._trg_validar_profile();

-- -----------------------------------------------------------------------------
-- Notificações
-- -----------------------------------------------------------------------------
create or replace function public._notificar(
  p_user_id uuid, p_titulo text, p_mensagem text, p_link text, p_pagamento_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tel text;
begin
  if p_user_id is null then
    return;
  end if;
  select p.telefone into v_tel from public.profiles p where p.id = p_user_id and p.ativo;
  if not found then
    return;
  end if;
  insert into public.notificacoes (user_id, titulo, mensagem, link, pagamento_id, whatsapp_status)
  values (p_user_id, p_titulo, p_mensagem, p_link, p_pagamento_id,
          case when nullif(trim(v_tel), '') is not null then 'pendente' end);
end
$$;

create or replace function public._notificar_financeiro(
  p_titulo text, p_mensagem text, p_link text, p_pagamento_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
begin
  for r in select p.id from public.profiles p where p.perfil = 'financeiro' and p.ativo loop
    perform public._notificar(r.id, p_titulo, p_mensagem, p_link, p_pagamento_id);
  end loop;
end
$$;

-- Avisa o responsável pela etapa atual do pagamento.
create or replace function public._notificar_etapa(p_pagamento_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  o public.obras;
  v_link text;
  v_resumo text;
begin
  select * into p from public.pagamentos where id = p_pagamento_id;
  select * into o from public.obras where id = p.obra_id;
  v_link := '/pagamentos/' || p.id;
  v_resumo := 'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ' — R$ '
              || to_char(p.valor, 'FM999G999G990D00') || ' (' || o.nome || ')';

  if p.status = 'aguardando_engenheiro' then
    perform public._notificar(o.engenheiro_id, 'Documento aguardando sua assinatura', v_resumo, v_link, p.id);
  elsif p.status = 'aguardando_administrador' then
    perform public._notificar(o.administrador_id, 'Documento aguardando sua assinatura', v_resumo, v_link, p.id);
  elsif p.status = 'aguardando_pagamento' then
    perform public._notificar_financeiro('Pagamento liberado para pagamento', v_resumo, v_link, p.id);
  end if;
end
$$;

create or replace function public.marcar_notificacoes_lidas(p_ids uuid[] default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.notificacoes
     set lida_em = now()
   where user_id = auth.uid()
     and lida_em is null
     and (p_ids is null or id = any (p_ids))
$$;

-- -----------------------------------------------------------------------------
-- Pagamentos: regras de fluxo
-- -----------------------------------------------------------------------------
create or replace function public._status_inicial(p_fluxo public.fluxo_aprovacao)
returns public.status_pagamento
language sql immutable set search_path = ''
as $$
  select case p_fluxo
    when 'A' then 'aguardando_engenheiro'::public.status_pagamento
    when 'B' then 'aguardando_administrador'::public.status_pagamento
    else 'aguardando_pagamento'::public.status_pagamento
  end
$$;

-- Conteúdo canônico que é assinado: dados do pagamento + documentos ativos.
create or replace function public._conteudo_assinavel(p_pagamento_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'pagamento_id', p.id,
    'numero', p.numero,
    'versao', p.versao,
    'obra_id', p.obra_id,
    'fornecedor_id', p.fornecedor_id,
    'favorecido', p.favorecido,
    'descricao', p.descricao,
    'valor', p.valor,
    'vencimento', p.vencimento,
    'forma_pagamento', p.forma_pagamento,
    'numero_documento', p.numero_documento,
    'documentos', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'tipo', d.tipo, 'nome', d.nome_arquivo,
                                          'versao', d.versao, 'sha256', d.sha256) order by d.created_at, d.id)
        from public.documentos d
       where d.pagamento_id = p.id and d.ativo and d.tipo <> 'comprovante'
    ), '[]'::jsonb)
  )
  from public.pagamentos p
  where p.id = p_pagamento_id
$$;

-- Registra uma nova versão do pagamento após alteração de conteúdo. Se já havia
-- aprovação na versão anterior e o pagamento ainda não foi pago, o fluxo de
-- assinaturas recomeça: documento assinado nunca é alterado silenciosamente.
create or replace function public._nova_versao(p_pagamento_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_tinha_aprovacao boolean;
  v_status_novo public.status_pagamento;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;

  select exists (
    select 1 from public.assinaturas a
     where a.pagamento_id = p.id and a.pagamento_versao = p.versao and a.decisao = 'aprovado'
  ) into v_tinha_aprovacao;

  update public.pagamentos set versao = versao + 1 where id = p.id;

  if v_tinha_aprovacao and p.status in ('aguardando_engenheiro', 'aguardando_administrador', 'aguardando_pagamento') then
    v_status_novo := public._status_inicial(p.fluxo);
    update public.pagamentos set status = v_status_novo where id = p.id;
    perform public._auditar('pagamento', p.id::text, 'fluxo_reiniciado',
      'Conteúdo alterado após assinatura: nova versão ' || (p.versao + 1)
        || ' precisa ser assinada novamente. Motivo: ' || coalesce(p_motivo, 'não informado'),
      p.obra_id, p.id,
      jsonb_build_object('status', p.status, 'versao', p.versao),
      jsonb_build_object('status', v_status_novo, 'versao', p.versao + 1));
    perform public._notificar_etapa(p.id);
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: criar pagamento (Suprimentos nas obras liberadas, ou Financeiro)
-- -----------------------------------------------------------------------------
create or replace function public.criar_pagamento(
  p_obra_id uuid,
  p_fornecedor_id uuid,
  p_favorecido text,
  p_descricao text,
  p_valor numeric,
  p_vencimento date,
  p_forma_pagamento public.forma_pagamento,
  p_numero_documento text default null,
  p_observacoes text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  o public.obras;
  v_id uuid;
  v_favorecido text := nullif(trim(p_favorecido), '');
begin
  if not public.pode_atuar_obra(p_obra_id) then
    raise exception 'Você não tem permissão para cadastrar pagamentos nesta obra.' using errcode = '42501';
  end if;
  select * into o from public.obras where id = p_obra_id;
  if not found then
    raise exception 'Obra não encontrada.';
  end if;
  if o.status <> 'ativa' then
    raise exception 'A obra % não está ativa.', o.nome;
  end if;

  if p_fornecedor_id is not null then
    select coalesce(v_favorecido, f.nome) into v_favorecido from public.fornecedores f where f.id = p_fornecedor_id;
    if not found then
      raise exception 'Fornecedor não encontrado.';
    end if;
  end if;

  insert into public.pagamentos (obra_id, fornecedor_id, favorecido, descricao, valor, vencimento,
                                 forma_pagamento, numero_documento, observacoes, fluxo, status, created_by)
  values (p_obra_id, p_fornecedor_id, v_favorecido, trim(p_descricao), p_valor, p_vencimento,
          p_forma_pagamento, nullif(trim(p_numero_documento), ''), nullif(trim(p_observacoes), ''),
          o.fluxo, public._status_inicial(o.fluxo), auth.uid())
  returning id into v_id;

  perform public._auditar('pagamento', v_id::text, 'criou', 'Pagamento cadastrado (fluxo ' || o.fluxo || ')',
    p_obra_id, v_id, null, (select to_jsonb(p) from public.pagamentos p where p.id = v_id));
  perform public._notificar_etapa(v_id);
  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: atualizar dados do pagamento (gera nova versão)
-- -----------------------------------------------------------------------------
create or replace function public.atualizar_pagamento(
  p_id uuid,
  p_fornecedor_id uuid,
  p_favorecido text,
  p_descricao text,
  p_valor numeric,
  p_vencimento date,
  p_forma_pagamento public.forma_pagamento,
  p_numero_documento text,
  p_observacoes text,
  p_motivo text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_antes jsonb;
  v_depois jsonb;
  v_diff_antes jsonb;
  v_diff_depois jsonb;
  v_conteudo_mudou boolean;
begin
  select * into p from public.pagamentos where id = p_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  if not public.pode_atuar_obra(p.obra_id) then
    raise exception 'Você não tem permissão para alterar pagamentos desta obra.' using errcode = '42501';
  end if;
  if p.status in ('pago', 'cancelado') then
    raise exception 'Pagamentos pagos ou cancelados não podem ser alterados.';
  end if;

  v_antes := to_jsonb(p);
  update public.pagamentos set
    fornecedor_id = p_fornecedor_id,
    favorecido = coalesce(nullif(trim(p_favorecido), ''), (select f.nome from public.fornecedores f where f.id = p_fornecedor_id), favorecido),
    descricao = trim(p_descricao),
    valor = p_valor,
    vencimento = p_vencimento,
    forma_pagamento = p_forma_pagamento,
    numero_documento = nullif(trim(p_numero_documento), ''),
    observacoes = nullif(trim(p_observacoes), '')
  where id = p_id;
  select to_jsonb(x) into v_depois from public.pagamentos x where x.id = p_id;

  select d.antes, d.depois into v_diff_antes, v_diff_depois from public._diff_jsonb(v_antes, v_depois) d;
  if v_diff_depois = '{}'::jsonb then
    return;
  end if;

  perform public._auditar('pagamento', p_id::text, 'alterou',
    'Dados do pagamento alterados' || coalesce('. Motivo: ' || nullif(trim(p_motivo), ''), ''),
    p.obra_id, p_id, v_diff_antes, v_diff_depois);

  -- Observações não fazem parte do conteúdo assinado.
  v_conteudo_mudou := exists (select 1 from jsonb_object_keys(v_diff_depois) k where k <> 'observacoes');
  if v_conteudo_mudou then
    perform public._nova_versao(p_id, p_motivo);
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: registrar documento já enviado ao Storage (anexo ou substituição)
-- -----------------------------------------------------------------------------
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
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;

  if p_tipo = 'comprovante' then
    if not public.is_financeiro() then
      raise exception 'Somente o Financeiro anexa comprovantes de pagamento.' using errcode = '42501';
    end if;
    if p.status not in ('aguardando_pagamento', 'pago') then
      raise exception 'Comprovantes só podem ser anexados a pagamentos liberados ou pagos.';
    end if;
  else
    if not public.pode_atuar_obra(p.obra_id) then
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

  -- Documentos que compõem o conteúdo assinável geram nova versão do pagamento
  -- (exceto anexos feitos no momento do cadastro, antes de qualquer decisão).
  if p_tipo <> 'comprovante' and (
       p_substitui_id is not null
       or exists (select 1 from public.assinaturas a where a.pagamento_id = p.id)
     ) then
    perform public._nova_versao(p.id, coalesce(p_motivo, 'documento anexado'));
  end if;

  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: aprovar / rejeitar (assinatura eletrônica), individual ou em lote
--   p_itens: [{"id": "<uuid>", "versao": <int>}, ...] — a versão conferida pelo
--   usuário. Se o pagamento mudou desde a conferência, a operação é recusada.
--   Todo o lote é atômico; cada pagamento recebe seu próprio registro.
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- RPC: reenviar pagamento rejeitado (após correções)
-- -----------------------------------------------------------------------------
create or replace function public.reenviar_pagamento(p_id uuid, p_observacao text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  o public.obras;
  v_status public.status_pagamento;
begin
  select * into p from public.pagamentos where id = p_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  if not public.pode_atuar_obra(p.obra_id) then
    raise exception 'Você não tem permissão para reenviar pagamentos desta obra.' using errcode = '42501';
  end if;
  if p.status <> 'rejeitado' then
    raise exception 'Somente pagamentos rejeitados podem ser reenviados.';
  end if;
  select * into o from public.obras where id = p.obra_id;
  v_status := public._status_inicial(o.fluxo);

  update public.pagamentos
     set status = v_status, fluxo = o.fluxo, versao = versao + 1, rejeicao_motivo = null
   where id = p_id;

  perform public._auditar('pagamento', p_id::text, 'reenviou',
    'Pagamento reenviado para aprovação (versão ' || (p.versao + 1) || ')'
      || coalesce('. ' || nullif(trim(p_observacao), ''), ''),
    p.obra_id, p_id,
    jsonb_build_object('status', p.status, 'versao', p.versao, 'fluxo', p.fluxo),
    jsonb_build_object('status', v_status, 'versao', p.versao + 1, 'fluxo', o.fluxo));
  perform public._notificar_etapa(p_id);
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: baixa (pagamento efetuado) — somente Financeiro
-- -----------------------------------------------------------------------------
create or replace function public.registrar_baixa(
  p_id uuid, p_pago_em date, p_valor_pago numeric default null, p_observacao text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro registra a baixa de pagamentos.' using errcode = '42501';
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

-- -----------------------------------------------------------------------------
-- RPC: cancelar pagamento
-- -----------------------------------------------------------------------------
create or replace function public.cancelar_pagamento(p_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
begin
  select * into p from public.pagamentos where id = p_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  if not public.pode_atuar_obra(p.obra_id) then
    raise exception 'Você não tem permissão para cancelar pagamentos desta obra.' using errcode = '42501';
  end if;
  if p.status in ('pago', 'cancelado') then
    raise exception 'Este pagamento não pode ser cancelado.';
  end if;
  if nullif(trim(p_motivo), '') is null then
    raise exception 'Informe o motivo do cancelamento.';
  end if;

  update public.pagamentos set status = 'cancelado', cancelamento_motivo = trim(p_motivo) where id = p_id;
  perform public._auditar('pagamento', p_id::text, 'cancelou', 'Pagamento cancelado. Motivo: ' || trim(p_motivo),
    p.obra_id, p_id, jsonb_build_object('status', p.status), jsonb_build_object('status', 'cancelado'));

  if p.status = 'aguardando_pagamento' then
    perform public._notificar_financeiro('Pagamento cancelado',
      'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ' foi cancelado.', '/pagamentos/' || p.id, p.id);
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- RPC: concluir troca de senha do primeiro acesso
-- -----------------------------------------------------------------------------
create or replace function public.confirmar_troca_senha()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.profiles set troca_senha_pendente = false where id = auth.uid() and troca_senha_pendente;
end
$$;

-- -----------------------------------------------------------------------------
-- Pendências de assinatura/pagamento do usuário logado
-- -----------------------------------------------------------------------------
create or replace function public.minhas_pendencias()
returns setof public.pagamentos
language sql stable security invoker set search_path = ''
as $$
  select p.*
    from public.pagamentos p
    join public.obras o on o.id = p.obra_id
   where (p.status = 'aguardando_engenheiro' and o.engenheiro_id = auth.uid())
      or (p.status = 'aguardando_administrador' and o.administrador_id = auth.uid())
      or (p.status = 'aguardando_pagamento' and public.is_financeiro())
$$;

-- -----------------------------------------------------------------------------
-- Mudança de fluxo/responsáveis da obra: reencaminha pagamentos pendentes
-- -----------------------------------------------------------------------------
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
    if r.status = 'aguardando_engenheiro' and new.fluxo <> 'A' then
      v_novo := public._status_inicial(new.fluxo);
    elsif r.status = 'aguardando_administrador' and new.fluxo = 'C' then
      v_novo := 'aguardando_pagamento';
    end if;

    if v_novo <> r.status then
      update public.pagamentos set status = v_novo, fluxo = new.fluxo where id = r.id;
      perform public._auditar('pagamento', r.id::text, 'reencaminhou',
        'Fluxo da obra alterado de ' || old.fluxo || ' para ' || new.fluxo || '; pagamento reencaminhado.',
        new.id, r.id, jsonb_build_object('status', r.status, 'fluxo', r.fluxo),
        jsonb_build_object('status', v_novo, 'fluxo', new.fluxo));
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
create trigger obras_fluxo_alterado after update on public.obras
  for each row execute function public._trg_obra_fluxo_alterado();

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.obras enable row level security;
alter table public.obra_acessos enable row level security;
alter table public.fornecedores enable row level security;
alter table public.pagamentos enable row level security;
alter table public.documentos enable row level security;
alter table public.assinaturas enable row level security;
alter table public.auditoria enable row level security;
alter table public.notificacoes enable row level security;

-- profiles: usuários ativos veem a lista (nomes para exibição); só o Financeiro
-- cria e altera.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.meu_perfil() is not null);
create policy profiles_insert on public.profiles for insert to authenticated
  with check (public.is_financeiro());
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_financeiro()) with check (public.is_financeiro());

-- obras
create policy obras_select on public.obras for select to authenticated
  using (public.pode_ver_obra(id));
create policy obras_insert on public.obras for insert to authenticated
  with check (public.is_financeiro());
create policy obras_update on public.obras for update to authenticated
  using (public.is_financeiro()) with check (public.is_financeiro());

-- obra_acessos
create policy obra_acessos_select on public.obra_acessos for select to authenticated
  using (public.is_financeiro() or user_id = auth.uid() or public.pode_ver_obra(obra_id));
create policy obra_acessos_insert on public.obra_acessos for insert to authenticated
  with check (public.is_financeiro());
create policy obra_acessos_delete on public.obra_acessos for delete to authenticated
  using (public.is_financeiro());

-- fornecedores: todos os usuários ativos consultam; Financeiro e Suprimentos cadastram.
create policy fornecedores_select on public.fornecedores for select to authenticated
  using (public.meu_perfil() is not null);
create policy fornecedores_insert on public.fornecedores for insert to authenticated
  with check (public.meu_perfil() in ('financeiro', 'suprimentos'));
create policy fornecedores_update on public.fornecedores for update to authenticated
  using (public.meu_perfil() in ('financeiro', 'suprimentos'))
  with check (public.meu_perfil() in ('financeiro', 'suprimentos'));

-- pagamentos / documentos / assinaturas: somente leitura via RLS; escrita só por RPC.
create policy pagamentos_select on public.pagamentos for select to authenticated
  using (public.pode_ver_obra(obra_id));
create policy documentos_select on public.documentos for select to authenticated
  using (public.pode_ver_obra(obra_id));
create policy assinaturas_select on public.assinaturas for select to authenticated
  using (exists (select 1 from public.pagamentos p where p.id = pagamento_id and public.pode_ver_obra(p.obra_id)));

-- auditoria: Financeiro vê tudo; demais veem a linha do tempo dos pagamentos das
-- obras que podem ver.
create policy auditoria_select on public.auditoria for select to authenticated
  using (public.is_financeiro() or (pagamento_id is not null and public.pode_ver_obra(obra_id)));

-- notificações: cada um vê as próprias.
create policy notificacoes_select on public.notificacoes for select to authenticated
  using (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- Privilégios: funções internas (prefixo _) não são expostas à API.
-- -----------------------------------------------------------------------------
revoke all on function public._auditar(text, text, text, text, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public._notificar(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public._notificar_financeiro(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public._notificar_etapa(uuid) from public, anon, authenticated;
revoke all on function public._nova_versao(uuid, text) from public, anon, authenticated;
revoke all on function public._conteudo_assinavel(uuid) from public, anon, authenticated;
revoke all on function public._trg_auditar_cadastro() from public, anon, authenticated;
revoke all on function public._trg_obra_fluxo_alterado() from public, anon, authenticated;
revoke all on function public._trg_validar_obra() from public, anon, authenticated;

-- Funções públicas: somente usuários autenticados.
revoke all on function public.criar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text) from public, anon;
revoke all on function public.atualizar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text) from public, anon;
revoke all on function public.registrar_documento(uuid, public.tipo_documento, text, text, text, bigint, text, uuid, text) from public, anon;
revoke all on function public.decidir_aprovacao(jsonb, public.decisao_aprovacao, text, text, text) from public, anon;
revoke all on function public.reenviar_pagamento(uuid, text) from public, anon;
revoke all on function public.registrar_baixa(uuid, date, numeric, text) from public, anon;
revoke all on function public.cancelar_pagamento(uuid, text) from public, anon;
revoke all on function public.confirmar_troca_senha() from public, anon;
revoke all on function public.marcar_notificacoes_lidas(uuid[]) from public, anon;
revoke all on function public.minhas_pendencias() from public, anon;

grant execute on function public.criar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text) to authenticated;
grant execute on function public.atualizar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text) to authenticated;
grant execute on function public.registrar_documento(uuid, public.tipo_documento, text, text, text, bigint, text, uuid, text) to authenticated;
grant execute on function public.decidir_aprovacao(jsonb, public.decisao_aprovacao, text, text, text) to authenticated;
grant execute on function public.reenviar_pagamento(uuid, text) to authenticated;
grant execute on function public.registrar_baixa(uuid, date, numeric, text) to authenticated;
grant execute on function public.cancelar_pagamento(uuid, text) to authenticated;
grant execute on function public.confirmar_troca_senha() to authenticated;
grant execute on function public.marcar_notificacoes_lidas(uuid[]) to authenticated;
grant execute on function public.minhas_pendencias() to authenticated;

-- Tabelas: anon não acessa nada; authenticated passa pelas policies.
revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on public.pagamentos, public.documentos, public.assinaturas,
  public.auditoria, public.notificacoes from authenticated;
revoke delete, truncate on public.obras, public.fornecedores, public.profiles from authenticated;

-- -----------------------------------------------------------------------------
-- Storage: bucket privado de documentos.
--   Caminho obrigatório: <obra_id>/<pagamento_id>/<arquivo>
--   Sem policies de UPDATE/DELETE: arquivos são preservados (versões).
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documentos', 'documentos', false, 26214400,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic',
              'application/xml', 'text/xml'])
on conflict (id) do nothing;

create or replace function public.pode_enviar_arquivo(p_nome text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.pagamentos p
     where p.obra_id = public._uuid_ou_nulo(split_part(p_nome, '/', 1))
       and p.id = public._uuid_ou_nulo(split_part(p_nome, '/', 2))
       and (public.pode_atuar_obra(p.obra_id) or public.is_financeiro())
  )
$$;

create policy documentos_storage_select on storage.objects for select to authenticated
  using (bucket_id = 'documentos'
         and public.pode_ver_obra(public._uuid_ou_nulo(split_part(name, '/', 1))));
create policy documentos_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos' and public.pode_enviar_arquivo(name));
