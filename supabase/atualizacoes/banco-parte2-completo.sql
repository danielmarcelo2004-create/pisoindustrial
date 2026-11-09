-- PARTE 2 de 2: rode depois da parte 1. Cria todo o banco do zero (tabelas, regras de acesso, funções, avisos e as mudanças novas).
-- Banco de teste vazio. Não rode em projeto que já tenha dados.

-- ===== 20261104000001_estrutura_base.sql =====
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

-- ===== 20261104000002_ordens_pagamento.sql =====
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

-- ===== 20261104000003_compras_e_lembretes.sql =====
-- =============================================================================
-- Inteligência de Compras (seção 8) e lembretes diários (seção 7)
--
-- Os dados vêm das notas fiscais JÁ anexadas aos pagamentos (sem cadastro
-- duplicado). XML da NF-e é lido automaticamente; NF em PDF/imagem pode ter os
-- itens lançados manualmente (conferência humana).
-- =============================================================================

create table public.nf_notas (
  id uuid primary key default gen_random_uuid(),
  documento_id uuid not null unique references public.documentos (id),
  pagamento_id uuid not null references public.pagamentos (id),
  obra_id uuid not null references public.obras (id),
  chave text check (chave is null or chave ~ '^[0-9]{44}$'),
  numero text,
  serie text,
  data_emissao date not null,
  emitente_cnpj text,
  emitente_nome text not null,
  emitente_uf char(2),
  valor_produtos numeric(14, 2),
  valor_frete numeric(14, 2),
  valor_desconto numeric(14, 2),
  valor_total numeric(14, 2),
  origem text not null check (origem in ('xml', 'manual')),
  ativa boolean not null default true,
  created_by uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index nf_notas_obra_idx on public.nf_notas (obra_id);
-- Uma NF-e só entra uma vez na análise (notas substituídas ficam inativas).
create unique index nf_notas_chave_ativa_idx on public.nf_notas (chave) where ativa and chave is not null;
create index nf_notas_emissao_idx on public.nf_notas (data_emissao);

create table public.nf_itens (
  id uuid primary key default gen_random_uuid(),
  nota_id uuid not null references public.nf_notas (id) on delete cascade,
  numero_item integer not null,
  codigo text,
  descricao text not null,
  descricao_normalizada text not null,
  ncm text,
  unidade text,
  quantidade numeric(15, 4) not null,
  valor_unitario numeric(18, 6) not null,
  valor_total numeric(14, 2) not null
);
create index nf_itens_nota_idx on public.nf_itens (nota_id);
create index nf_itens_desc_idx on public.nf_itens (descricao_normalizada);

-- Visão analítica: item + nota + obra (cidade/UF). security_invoker = RLS de quem consulta.
create view public.compras_itens with (security_invoker = true) as
select
  i.id,
  i.nota_id,
  n.documento_id,
  n.pagamento_id,
  n.obra_id,
  o.nome as obra_nome,
  o.cidade,
  o.uf,
  n.data_emissao,
  n.numero as nf_numero,
  n.emitente_cnpj as fornecedor_cnpj,
  n.emitente_nome as fornecedor_nome,
  n.origem,
  i.numero_item,
  i.codigo,
  i.descricao,
  i.descricao_normalizada,
  i.ncm,
  i.unidade,
  i.quantidade,
  i.valor_unitario,
  i.valor_total
from public.nf_itens i
join public.nf_notas n on n.id = i.nota_id and n.ativa
join public.obras o on o.id = n.obra_id;

alter table public.nf_notas enable row level security;
alter table public.nf_itens enable row level security;

-- Área de análise: Financeiro e Suprimentos.
create policy nf_notas_select on public.nf_notas for select to authenticated
  using (public.meu_perfil() in ('financeiro', 'suprimentos'));
create policy nf_itens_select on public.nf_itens for select to authenticated
  using (public.meu_perfil() in ('financeiro', 'suprimentos'));

revoke all on public.nf_notas, public.nf_itens, public.compras_itens from anon;
revoke insert, update, delete, truncate on public.nf_notas, public.nf_itens from authenticated;

-- -----------------------------------------------------------------------------
-- RPC: registrar os dados de uma NF (lidos do XML ou lançados manualmente)
--   p_nota: {chave, numero, serie, data_emissao, emitente_cnpj, emitente_nome,
--            emitente_uf, valor_produtos, valor_frete, valor_desconto, valor_total}
--   p_itens: [{numero_item, codigo, descricao, descricao_normalizada, ncm,
--             unidade, quantidade, valor_unitario, valor_total}]
-- -----------------------------------------------------------------------------
create or replace function public.registrar_nf(p_documento_id uuid, p_nota jsonb, p_itens jsonb, p_origem text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.documentos;
  v_id uuid;
  v_item jsonb;
  v_chave text := nullif(regexp_replace(coalesce(p_nota ->> 'chave', ''), '\D', '', 'g'), '');
begin
  select * into d from public.documentos where id = p_documento_id;
  if not found or not public.pode_ver_obra(d.obra_id) then
    raise exception 'Documento não encontrado.';
  end if;
  if not (public.pode_atuar_obra(d.obra_id) or public.is_financeiro()) then
    raise exception 'Você não tem permissão para registrar dados desta nota.' using errcode = '42501';
  end if;
  if d.tipo <> 'nota_fiscal' then
    raise exception 'O documento não é uma nota fiscal.';
  end if;
  if p_origem not in ('xml', 'manual') then
    raise exception 'Origem inválida.';
  end if;
  if jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'A nota precisa ter ao menos um item.';
  end if;
  if exists (select 1 from public.nf_notas n where n.documento_id = p_documento_id) then
    raise exception 'Os itens desta nota já foram registrados.';
  end if;
  if v_chave is not null and exists (select 1 from public.nf_notas n where n.chave = v_chave and n.ativa) then
    raise exception 'Esta NF-e (chave %) já foi registrada em outro pagamento.', v_chave;
  end if;

  insert into public.nf_notas (documento_id, pagamento_id, obra_id, chave, numero, serie, data_emissao, emitente_cnpj,
                               emitente_nome, emitente_uf, valor_produtos, valor_frete, valor_desconto, valor_total, origem)
  values (d.id, d.pagamento_id, d.obra_id, v_chave, p_nota ->> 'numero', p_nota ->> 'serie',
          (p_nota ->> 'data_emissao')::date,
          nullif(regexp_replace(coalesce(p_nota ->> 'emitente_cnpj', ''), '\D', '', 'g'), ''),
          trim(p_nota ->> 'emitente_nome'), upper(nullif(p_nota ->> 'emitente_uf', '')),
          (p_nota ->> 'valor_produtos')::numeric, (p_nota ->> 'valor_frete')::numeric,
          (p_nota ->> 'valor_desconto')::numeric, (p_nota ->> 'valor_total')::numeric, p_origem)
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    insert into public.nf_itens (nota_id, numero_item, codigo, descricao, descricao_normalizada, ncm, unidade,
                                 quantidade, valor_unitario, valor_total)
    values (v_id, (v_item ->> 'numero_item')::int, v_item ->> 'codigo', trim(v_item ->> 'descricao'),
            v_item ->> 'descricao_normalizada', v_item ->> 'ncm', upper(trim(v_item ->> 'unidade')),
            (v_item ->> 'quantidade')::numeric, (v_item ->> 'valor_unitario')::numeric, (v_item ->> 'valor_total')::numeric);
  end loop;

  perform public._auditar('documento', d.id::text, 'registrou_nf',
    'Itens da NF ' || coalesce(p_nota ->> 'numero', '') || ' registrados ('
      || case p_origem when 'xml' then 'leitura automática do XML' else 'lançamento manual' end
      || ', ' || jsonb_array_length(p_itens) || ' itens)',
    d.obra_id, d.pagamento_id, null, jsonb_build_object('nota_id', v_id, 'chave', v_chave));
  return v_id;
end
$$;

-- Remove o lançamento (ex.: lançamento manual com erro) para relançar.
create or replace function public.remover_nf(p_nota_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  n public.nf_notas;
begin
  select * into n from public.nf_notas where id = p_nota_id;
  if not found or not (public.pode_atuar_obra(n.obra_id) or public.is_financeiro()) then
    raise exception 'Você não tem permissão para remover estes dados.' using errcode = '42501';
  end if;
  delete from public.nf_notas where id = p_nota_id;
  perform public._auditar('documento', n.documento_id::text, 'removeu_nf',
    'Itens da NF ' || coalesce(n.numero, '') || ' removidos da Inteligência de Compras para novo lançamento',
    n.obra_id, n.pagamento_id, jsonb_build_object('nota_id', n.id, 'chave', n.chave, 'origem', n.origem), null);
end
$$;

-- Documento de NF substituído: os dados antigos deixam de entrar na análise.
create or replace function public._trg_nf_documento_inativo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.ativo and not new.ativo then
    update public.nf_notas set ativa = false where documento_id = new.id;
  end if;
  return new;
end
$$;
create trigger documentos_nf_inativo after update of ativo on public.documentos
  for each row execute function public._trg_nf_documento_inativo();

-- -----------------------------------------------------------------------------
-- Lembretes diários (pendências e vencimentos)
-- -----------------------------------------------------------------------------
create or replace function public.gerar_lembretes_diarios()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_total int := 0;
  r record;
begin
  -- Financeiro: vencidos, vencendo hoje e amanhã (em aberto).
  for r in
    select count(*) filter (where p.vencimento < v_hoje) as vencidos,
           count(*) filter (where p.vencimento = v_hoje) as hoje,
           count(*) filter (where p.vencimento = v_hoje + 1) as amanha,
           coalesce(sum(p.valor) filter (where p.vencimento <= v_hoje + 1), 0) as valor
      from public.pagamentos p
     where p.status in ('aguardando_engenheiro', 'aguardando_administrador', 'aguardando_pagamento')
       and p.vencimento <= v_hoje + 1
  loop
    if r.vencidos + r.hoje + r.amanha > 0 then
      perform public._notificar(f.id, 'Lembrete de vencimentos',
        r.vencidos || ' vencido(s), ' || r.hoje || ' vencendo hoje e ' || r.amanha || ' amanhã — total R$ '
          || to_char(r.valor, 'FM999G999G990D00') || '.', '/agenda', null)
        from public.profiles f
       where f.perfil = 'financeiro' and f.ativo
         and not exists (select 1 from public.notificacoes n where n.user_id = f.id
                          and n.titulo = 'Lembrete de vencimentos'
                          and (n.created_at at time zone 'America/Sao_Paulo')::date = v_hoje);
      v_total := v_total + 1;
    end if;
  end loop;

  -- Engenheiros e administradores: documentos aguardando assinatura.
  for r in
    select u.id as user_id, count(*) as qtd, min(p.vencimento) as primeiro
      from public.pagamentos p
      join public.obras o on o.id = p.obra_id
      join public.profiles u on u.ativo and (
            (p.status = 'aguardando_engenheiro' and u.id = o.engenheiro_id)
         or (p.status = 'aguardando_administrador' and u.id = o.administrador_id))
     group by u.id
  loop
    if not exists (select 1 from public.notificacoes n where n.user_id = r.user_id
                    and n.titulo = 'Documentos aguardando sua assinatura'
                    and (n.created_at at time zone 'America/Sao_Paulo')::date = v_hoje) then
      perform public._notificar(r.user_id, 'Documentos aguardando sua assinatura',
        r.qtd || ' documento(s) pendente(s). Vencimento mais próximo: ' || to_char(r.primeiro, 'DD/MM/YYYY') || '.',
        '/aprovacoes', null);
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end
$$;

revoke all on function public.gerar_lembretes_diarios() from public, anon, authenticated;
revoke all on function public._trg_nf_documento_inativo() from public, anon, authenticated;
revoke all on function public.registrar_nf(uuid, jsonb, jsonb, text) from public, anon;
revoke all on function public.remover_nf(uuid) from public, anon;
grant execute on function public.registrar_nf(uuid, jsonb, jsonb, text) to authenticated;
grant execute on function public.remover_nf(uuid) to authenticated;

-- Agenda os lembretes todos os dias às 07:30 (Brasília) quando o pg_cron existir.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('lembretes-diarios', '30 10 * * *', 'select public.gerar_lembretes_diarios()');
exception when others then
  raise notice 'pg_cron indisponível: agende public.gerar_lembretes_diarios() manualmente (%).', sqlerrm;
end
$$;

-- -----------------------------------------------------------------------------
-- Fila de WhatsApp: leitura e marcação pelo serviço de envio (chave secreta)
-- -----------------------------------------------------------------------------
create index notificacoes_whatsapp_idx on public.notificacoes (whatsapp_status) where whatsapp_status = 'pendente';
alter table public.notificacoes add column whatsapp_erro text;
alter table public.notificacoes add column whatsapp_enviado_em timestamptz;

-- ===== 20261104000004_op_modelo_oficial.sql =====
-- =============================================================================
-- Modelo oficial da Ordem de Pagamento (Construtora Parceria):
--   * referência do mês (ex.: OUTUBRO), desconto e totais
--   * início e salário de referência por item (mão de obra)
-- =============================================================================

alter table public.ordens_pagamento
  add column referencia text check (referencia is null or length(referencia) <= 60),
  add column desconto numeric(14, 2) not null default 0 check (desconto >= 0);

alter table public.ordem_itens
  add column inicio date,
  add column salario numeric(14, 2) check (salario is null or salario >= 0);

drop function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb);

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
  p_itens jsonb,
  p_desconto numeric default 0,
  p_referencia text default null
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
  v_desconto numeric(14, 2) := round(coalesce(p_desconto, 0), 2);
  v_subtotal numeric(14, 2);
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
  select coalesce(sum(round((x ->> 'quantidade')::numeric * (x ->> 'valor_unitario')::numeric, 2)), 0)
    into v_subtotal
    from jsonb_array_elements(p_itens) x;
  if v_desconto < 0 then
    raise exception 'O desconto não pode ser negativo.';
  end if;
  if v_desconto > v_subtotal then
    raise exception 'O desconto não pode ser maior que o subtotal da OP.';
  end if;
  if v_doc is not null and length(v_doc) not in (11, 14) then
    raise exception 'CPF deve ter 11 dígitos e CNPJ 14 dígitos.';
  end if;
  if v_doc is not null then
    select f.id into v_forn from public.fornecedores f where f.cpf_cnpj = v_doc;
  end if;

  if v_id is null then
    insert into public.ordens_pagamento (obra_id, solicitante_id, fornecedor_id, favorecido, cpf_cnpj, descricao,
                                         vencimento, forma_pagamento, dados_bancarios, observacoes, referencia, desconto)
    values (p_obra_id, auth.uid(), v_forn, trim(p_favorecido), v_doc, trim(p_descricao), p_vencimento,
            p_forma_pagamento, nullif(trim(p_dados_bancarios), ''), nullif(trim(p_observacoes), ''),
            nullif(trim(p_referencia), ''), v_desconto)
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
      dados_bancarios = nullif(trim(p_dados_bancarios), ''), observacoes = nullif(trim(p_observacoes), ''),
      referencia = nullif(trim(p_referencia), ''), desconto = v_desconto
    where id = v_id;
    delete from public.ordem_itens where ordem_id = v_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    v_pos := v_pos + 1;
    insert into public.ordem_itens (ordem_id, posicao, descricao, unidade, quantidade, valor_unitario, inicio, salario)
    values (v_id, v_pos, trim(v_item ->> 'descricao'), nullif(trim(v_item ->> 'unidade'), ''),
            (v_item ->> 'quantidade')::numeric, (v_item ->> 'valor_unitario')::numeric,
            nullif(v_item ->> 'inicio', '')::date, nullif(v_item ->> 'salario', '')::numeric);
  end loop;
  return v_id;
end
$$;

revoke all on function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb, numeric, text) from public, anon;
grant execute on function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb, numeric, text) to authenticated;

-- Envio: o valor do pagamento é o subtotal menos o desconto.
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
  select coalesce(sum(i.total), 0) into v_subtotal from public.ordem_itens i where i.ordem_id = p_id;
  v_total := v_subtotal - v_op.desconto;
  if v_total <= 0 then
    raise exception 'O valor total da OP deve ser maior que zero.';
  end if;
  select * into o from public.obras where id = v_op.obra_id;
  if o.status <> 'ativa' then
    raise exception 'A obra não está ativa.';
  end if;

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

-- ===== 20261105000001_perfil_administrador_master.sql =====
-- Novo perfil: Administrador master (precisa estar gravado antes de ser usado nas regras).

-- ===== 20261105000002_regras_administrador_master.sql =====
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


-- ===== 20261105000003_op_modelo_novo.sql =====
-- Modelo novo da OP: Nº da Nota Fiscal; Financeiro e Suprimentos também geram OP.
alter table public.ordens_pagamento add column if not exists numero_nf text;

drop function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb, numeric, text);

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
  p_itens jsonb,
  p_desconto numeric default 0,
  p_referencia text default null,
  p_numero_nf text default null
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
  v_desconto numeric(14, 2) := round(coalesce(p_desconto, 0), 2);
  v_subtotal numeric(14, 2);
begin
  if public.meu_perfil() not in ('engenheiro', 'financeiro', 'suprimentos') then
    raise exception 'Seu perfil não solicita Ordens de Pagamento.' using errcode = '42501';
  end if;
  if not public.pode_ver_obra(p_obra_id) then
    raise exception 'Você não está vinculado a esta obra.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.obras o where o.id = p_obra_id and o.status = 'ativa') then
    raise exception 'O centro de custo não está ativo.';
  end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Informe ao menos um item.';
  end if;
  select coalesce(sum(round((x ->> 'quantidade')::numeric * (x ->> 'valor_unitario')::numeric, 2)), 0)
    into v_subtotal
    from jsonb_array_elements(p_itens) x;
  if v_desconto < 0 then
    raise exception 'O desconto não pode ser negativo.';
  end if;
  if v_desconto > v_subtotal then
    raise exception 'O desconto não pode ser maior que o subtotal da OP.';
  end if;
  if v_doc is not null and length(v_doc) not in (11, 14) then
    raise exception 'CPF deve ter 11 dígitos e CNPJ 14 dígitos.';
  end if;
  if v_doc is not null then
    select f.id into v_forn from public.fornecedores f where f.cpf_cnpj = v_doc;
  end if;

  if v_id is null then
    insert into public.ordens_pagamento (obra_id, solicitante_id, fornecedor_id, favorecido, cpf_cnpj, descricao,
                                         vencimento, forma_pagamento, dados_bancarios, observacoes, referencia, desconto, numero_nf)
    values (p_obra_id, auth.uid(), v_forn, trim(p_favorecido), v_doc, trim(p_descricao), p_vencimento,
            p_forma_pagamento, nullif(trim(p_dados_bancarios), ''), nullif(trim(p_observacoes), ''),
            nullif(trim(p_referencia), ''), v_desconto, nullif(trim(p_numero_nf), ''))
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
      dados_bancarios = nullif(trim(p_dados_bancarios), ''), observacoes = nullif(trim(p_observacoes), ''),
      referencia = nullif(trim(p_referencia), ''), desconto = v_desconto, numero_nf = nullif(trim(p_numero_nf), '')
    where id = v_id;
    delete from public.ordem_itens where ordem_id = v_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    v_pos := v_pos + 1;
    insert into public.ordem_itens (ordem_id, posicao, descricao, unidade, quantidade, valor_unitario, inicio, salario)
    values (v_id, v_pos, trim(v_item ->> 'descricao'), nullif(trim(v_item ->> 'unidade'), ''),
            (v_item ->> 'quantidade')::numeric, (v_item ->> 'valor_unitario')::numeric,
            nullif(v_item ->> 'inicio', '')::date, nullif(v_item ->> 'salario', '')::numeric);
  end loop;
  return v_id;
end
$$;

revoke all on function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb, numeric, text, text) from public, anon;
grant execute on function public.salvar_op(uuid, uuid, text, text, text, date, public.forma_pagamento, text, text, jsonb, numeric, text, text) to authenticated;

-- Envio: também para Financeiro e Suprimentos (quem tem acesso à obra).
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

  v_fluxo := case when o.administrador_id is not null then 'B'::public.fluxo_aprovacao else 'C'::public.fluxo_aprovacao end;
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

  perform public._auditar('pagamento', v_pag::text, 'criou',
    'Ordem de pagamento ' || v_numero || ' solicitada'
      || case when v_fluxo = 'B' then ' e encaminhada ao administrador' else ' e encaminhada ao Financeiro (centro de custo sem administrador)' end,
    o.id, v_pag, null, (select to_jsonb(p) from public.pagamentos p where p.id = v_pag));
  perform public._notificar_etapa(v_pag);
  return v_pag;
end
$$;

-- ===== 20261105000004_provisoes.sql =====
-- Provisão de pagamento: lembrete de despesa futura, com valor estimado (ou sem valor).
-- Não entra em totais, aprovações nem baixas enquanto não virar pagamento.
create table public.provisoes (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras (id),
  descricao text not null check (length(trim(descricao)) > 0),
  mes_referencia text check (mes_referencia is null or mes_referencia ~ '^[0-9]{4}-[0-9]{2}$'),
  vencimento date,
  valor_estimado numeric(14, 2) check (valor_estimado is null or valor_estimado >= 0),
  observacoes text,
  status text not null default 'provisionada' check (status in ('provisionada', 'convertida', 'cancelada')),
  created_by uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provisoes_obra_idx on public.provisoes (obra_id);
create trigger provisoes_updated before update on public.provisoes
  for each row execute function public._tocar_updated_at();

alter table public.provisoes enable row level security;
create policy provisoes_select on public.provisoes for select to authenticated
  using (public.pode_ver_obra(obra_id));
create policy provisoes_insert on public.provisoes for insert to authenticated
  with check (public.is_financeiro() and public.pode_ver_obra(obra_id));
create policy provisoes_update on public.provisoes for update to authenticated
  using (public.is_financeiro()) with check (public.is_financeiro());
create policy provisoes_delete on public.provisoes for delete to authenticated
  using (public.is_financeiro());

revoke all on public.provisoes from anon;
revoke delete, truncate on public.provisoes from authenticated;

-- ===== 20261105000005_editar_pagamento_fechado.sql =====
-- Financeiro e Suprimentos alteram obra e dados de pagamentos liberados ou pagos.
-- Não pede nova aprovação; a alteração fica na auditoria e avisa o Financeiro.
drop function public.atualizar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text);

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
  p_motivo text default null,
  p_obra_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_nova_obra uuid;
  v_antes jsonb;
  v_depois jsonb;
  v_diff_antes jsonb;
  v_diff_depois jsonb;
  v_conteudo_mudou boolean;
  v_fechado boolean;
begin
  select * into p from public.pagamentos where id = p_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  if p.status = 'cancelado' then
    raise exception 'Pagamentos cancelados não podem ser alterados.';
  end if;
  v_fechado := p.status in ('pago', 'aguardando_pagamento');
  if p.status = 'pago' and public.meu_perfil() not in ('financeiro', 'suprimentos') then
    raise exception 'Somente o Financeiro e o Suprimentos alteram pagamentos já pagos.' using errcode = '42501';
  end if;
  if not public.pode_atuar_obra(p.obra_id) then
    raise exception 'Você não tem permissão para alterar pagamentos desta obra.' using errcode = '42501';
  end if;

  v_nova_obra := coalesce(p_obra_id, p.obra_id);
  if v_nova_obra <> p.obra_id and not public.pode_atuar_obra(v_nova_obra) then
    raise exception 'Você não pode mover o pagamento para este centro de custo.' using errcode = '42501';
  end if;
  if (v_fechado or v_nova_obra <> p.obra_id) and nullif(trim(p_motivo), '') is null then
    raise exception 'Informe o motivo da alteração.';
  end if;

  v_antes := to_jsonb(p);
  update public.pagamentos set
    obra_id = v_nova_obra,
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
    v_nova_obra, p_id, v_diff_antes, v_diff_depois);

  v_conteudo_mudou := exists (select 1 from jsonb_object_keys(v_diff_depois) k where k <> 'observacoes');
  if v_fechado then
    if public.meu_perfil() <> 'financeiro' then
      perform public._notificar_financeiro('Pagamento alterado após liberação',
        'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ' foi alterado por ' || coalesce((select nome from public.profiles where id = auth.uid()), 'um usuário') || '. Motivo: ' || trim(p_motivo),
        '/pagamentos/' || p.id, p.id);
    end if;
  elsif v_conteudo_mudou then
    perform public._nova_versao(p_id, p_motivo);
  end if;
end
$$;

revoke all on function public.atualizar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text, uuid) from public, anon;
grant execute on function public.atualizar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text, uuid) to authenticated;

-- ===== 20261105000006_provisao_suprimentos.sql =====
-- Suprimentos também cria provisões (nas obras que pode atuar).
drop policy if exists provisoes_insert on public.provisoes;
create policy provisoes_insert on public.provisoes for insert to authenticated
  with check (public.meu_perfil() in ('financeiro', 'suprimentos') and public.pode_atuar_obra(obra_id));

-- ===== 20261105000007_marca_assinatura_cadastro.sql =====
-- Marca de quem cadastrou: Financeiro e Suprimentos podem "assinar" o próprio cadastro.
-- É só um registro (não é etapa de aprovação do fluxo).
alter table public.pagamentos add column if not exists assinado_no_cadastro boolean not null default false;

create or replace function public.marcar_assinatura_cadastro(p_id uuid, p_assinar boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
begin
  select * into p from public.pagamentos where id = p_id for update;
  if not found or p.created_by <> auth.uid() or public.meu_perfil() not in ('financeiro', 'suprimentos') then
    raise exception 'Somente quem cadastrou o pagamento pode marcar a assinatura do cadastro.' using errcode = '42501';
  end if;
  if p.status in ('pago', 'cancelado') then
    raise exception 'Não é possível alterar a marca de um pagamento pago ou cancelado.';
  end if;
  update public.pagamentos set assinado_no_cadastro = p_assinar where id = p_id;
  perform public._auditar('pagamento', p_id::text, 'assinou_cadastro',
    case when p_assinar then 'Cadastro assinado por quem cadastrou (marca, sem etapa de aprovação)'
         else 'Marca de assinatura do cadastro removida' end,
    p.obra_id, p_id, jsonb_build_object('assinado_no_cadastro', p.assinado_no_cadastro),
    jsonb_build_object('assinado_no_cadastro', p_assinar));
end
$$;

revoke all on function public.marcar_assinatura_cadastro(uuid, boolean) from public, anon;
grant execute on function public.marcar_assinatura_cadastro(uuid, boolean) to authenticated;

-- ===== 20261105000008_nf_ocr.sql =====
-- Leitura automática de notas em PDF/imagem (OCR), só para notas nítidas.
alter table public.nf_notas drop constraint if exists nf_notas_origem_check;
alter table public.nf_notas add constraint nf_notas_origem_check check (origem in ('xml', 'manual', 'ocr'));

create or replace function public.registrar_nf(p_documento_id uuid, p_nota jsonb, p_itens jsonb, p_origem text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.documentos;
  v_id uuid;
  v_item jsonb;
  v_chave text := nullif(regexp_replace(coalesce(p_nota ->> 'chave', ''), '\D', '', 'g'), '');
begin
  select * into d from public.documentos where id = p_documento_id;
  if not found or not public.pode_ver_obra(d.obra_id) then
    raise exception 'Documento não encontrado.';
  end if;
  if not (public.pode_atuar_obra(d.obra_id) or public.is_financeiro()) then
    raise exception 'Você não tem permissão para registrar dados desta nota.' using errcode = '42501';
  end if;
  if d.tipo <> 'nota_fiscal' then
    raise exception 'O documento não é uma nota fiscal.';
  end if;
  if p_origem not in ('xml', 'manual', 'ocr') then
    raise exception 'Origem inválida.';
  end if;
  if jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'A nota precisa ter ao menos um item.';
  end if;
  if exists (select 1 from public.nf_notas n where n.documento_id = p_documento_id) then
    raise exception 'Os itens desta nota já foram registrados.';
  end if;
  if v_chave is not null and exists (select 1 from public.nf_notas n where n.chave = v_chave and n.ativa) then
    raise exception 'Esta NF-e (chave %) já foi registrada em outro pagamento.', v_chave;
  end if;

  insert into public.nf_notas (documento_id, pagamento_id, obra_id, chave, numero, serie, data_emissao, emitente_cnpj,
                               emitente_nome, emitente_uf, valor_produtos, valor_frete, valor_desconto, valor_total, origem)
  values (d.id, d.pagamento_id, d.obra_id, v_chave, p_nota ->> 'numero', p_nota ->> 'serie',
          (p_nota ->> 'data_emissao')::date,
          nullif(regexp_replace(coalesce(p_nota ->> 'emitente_cnpj', ''), '\D', '', 'g'), ''),
          trim(p_nota ->> 'emitente_nome'), upper(nullif(p_nota ->> 'emitente_uf', '')),
          (p_nota ->> 'valor_produtos')::numeric, (p_nota ->> 'valor_frete')::numeric,
          (p_nota ->> 'valor_desconto')::numeric, (p_nota ->> 'valor_total')::numeric, p_origem)
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    insert into public.nf_itens (nota_id, numero_item, codigo, descricao, descricao_normalizada, ncm, unidade,
                                 quantidade, valor_unitario, valor_total)
    values (v_id, (v_item ->> 'numero_item')::int, v_item ->> 'codigo', trim(v_item ->> 'descricao'),
            v_item ->> 'descricao_normalizada', v_item ->> 'ncm', upper(trim(v_item ->> 'unidade')),
            (v_item ->> 'quantidade')::numeric, (v_item ->> 'valor_unitario')::numeric, (v_item ->> 'valor_total')::numeric);
  end loop;

  perform public._auditar('documento', d.id::text, 'registrou_nf',
    'Itens da NF ' || coalesce(p_nota ->> 'numero', '') || ' registrados ('
      || case p_origem when 'xml' then 'leitura automática do XML' when 'ocr' then 'leitura automática do PDF (OCR, nota nítida)' else 'lançamento manual' end
      || ', ' || jsonb_array_length(p_itens) || ' itens)',
    d.obra_id, d.pagamento_id, null, jsonb_build_object('nota_id', v_id, 'chave', v_chave));
  return v_id;
end
$$;

revoke all on function public.registrar_nf(uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.registrar_nf(uuid, jsonb, jsonb, text) to authenticated;

-- ===== 20261105000009_documento_assinado_tipo.sql =====
-- Novo tipo de documento: versão assinada de um documento (o original é preservado).

-- ===== 20261105000010_assinatura_documentos.sql =====
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



-- ===== 20261105000011_parcelas.sql =====
-- Pagamento parcelado: cada parcela tem vencimento próprio. A aprovação vale para o pagamento inteiro.
-- Regra: a soma do valor base das parcelas é igual ao valor do pagamento. Multa e juros aumentam a
-- parcela; desconto a reduz. Qualquer multa, juros ou desconto exige motivo.
create table public.pagamento_parcelas (
  id uuid primary key default gen_random_uuid(),
  pagamento_id uuid not null references public.pagamentos (id) on delete cascade,
  numero integer not null check (numero > 0),
  valor_base numeric(14, 2) not null check (valor_base > 0),
  multa numeric(14, 2) not null default 0 check (multa >= 0),
  juros numeric(14, 2) not null default 0 check (juros >= 0),
  desconto numeric(14, 2) not null default 0 check (desconto >= 0),
  vencimento date not null,
  motivo text,
  unique (pagamento_id, numero)
);
alter table public.pagamento_parcelas enable row level security;
create policy pagamento_parcelas_select on public.pagamento_parcelas for select to authenticated
  using (exists (select 1 from public.pagamentos p where p.id = pagamento_id and public.pode_ver_obra(p.obra_id)));
revoke all on public.pagamento_parcelas from anon;
revoke insert, update, delete, truncate on public.pagamento_parcelas from authenticated;

create or replace function public.definir_parcelas(p_pagamento_id uuid, p_parcelas jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_item jsonb;
  v_num int := 0;
  v_base numeric(14, 2) := 0;
  v_base_item numeric(14, 2);
  v_multa numeric(14, 2);
  v_juros numeric(14, 2);
  v_desc numeric(14, 2);
  v_motivo text;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or p.created_by <> auth.uid() or public.meu_perfil() not in ('financeiro', 'suprimentos') then
    raise exception 'Somente quem cadastrou o pagamento pode parcelá-lo.' using errcode = '42501';
  end if;
  if p.status in ('pago', 'cancelado', 'rejeitado') then
    raise exception 'Não é possível parcelar um pagamento pago, cancelado ou rejeitado.';
  end if;
  if p_parcelas is null or jsonb_typeof(p_parcelas) <> 'array' or jsonb_array_length(p_parcelas) < 2 then
    raise exception 'Um pagamento parcelado precisa de pelo menos duas parcelas.';
  end if;

  for v_item in select * from jsonb_array_elements(p_parcelas) loop
    v_num := v_num + 1;
    v_base_item := round((v_item ->> 'valor')::numeric, 2);
    v_multa := round(coalesce(nullif(v_item ->> 'multa', ''), '0')::numeric, 2);
    v_juros := round(coalesce(nullif(v_item ->> 'juros', ''), '0')::numeric, 2);
    v_desc := round(coalesce(nullif(v_item ->> 'desconto', ''), '0')::numeric, 2);
    v_motivo := nullif(trim(v_item ->> 'motivo'), '');
    if v_base_item is null or v_base_item <= 0 then
      raise exception 'Parcela %: informe o valor.', v_num;
    end if;
    if nullif(v_item ->> 'vencimento', '') is null then
      raise exception 'Parcela %: informe o vencimento.', v_num;
    end if;
    if v_multa < 0 or v_juros < 0 or v_desc < 0 then
      raise exception 'Parcela %: multa, juros e desconto não podem ser negativos.', v_num;
    end if;
    if (v_multa + v_juros + v_desc) > 0 and v_motivo is null then
      raise exception 'Parcela %: multa, juros ou desconto exigem o motivo.', v_num;
    end if;
    v_base := v_base + v_base_item;
  end loop;

  if v_base <> p.valor then
    raise exception 'A soma das parcelas (R$ %) não confere com o valor do pagamento (R$ %). Multa e juros são lançados à parte, em cada parcela.', v_base, p.valor;
  end if;

  delete from public.pagamento_parcelas where pagamento_id = p_pagamento_id;
  v_num := 0;
  for v_item in select * from jsonb_array_elements(p_parcelas) loop
    v_num := v_num + 1;
    insert into public.pagamento_parcelas (pagamento_id, numero, valor_base, multa, juros, desconto, vencimento, motivo)
    values (p_pagamento_id, v_num, round((v_item ->> 'valor')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'multa', ''), '0')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'juros', ''), '0')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'desconto', ''), '0')::numeric, 2),
            (v_item ->> 'vencimento')::date, nullif(trim(v_item ->> 'motivo'), ''));
  end loop;

  perform public._auditar('pagamento', p_pagamento_id::text, 'parcelou',
    'Pagamento dividido em ' || v_num || ' parcelas com vencimentos próprios (aprovação única do pagamento)',
    p.obra_id, p_pagamento_id, null, jsonb_build_object('parcelas', v_num));
end
$$;

revoke all on function public.definir_parcelas(uuid, jsonb) from public, anon;
grant execute on function public.definir_parcelas(uuid, jsonb) to authenticated;

-- ===== 20261105000012_baixa_parcelas.sql =====
-- Baixa por parcela: cada parcela é paga separadamente. O pagamento só fica pago
-- quando todas as parcelas estiverem pagas. Pagamento parcelado não recebe baixa total.
alter table public.pagamento_parcelas
  add column if not exists status text not null default 'a_pagar' check (status in ('a_pagar', 'pago')),
  add column if not exists pago_em date,
  add column if not exists valor_pago numeric(14, 2),
  add column if not exists pago_por uuid references public.profiles (id);

create or replace function public.registrar_baixa_parcela(
  p_parcela_id uuid, p_pago_em date, p_valor_pago numeric default null, p_observacao text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pc public.pagamento_parcelas;
  p public.pagamentos;
  v_total int;
  v_pagas int;
  v_valor numeric(14, 2);
begin
  if not public.pode_baixar() then
    raise exception 'Somente o Financeiro ou o Administrador master registram a baixa de pagamentos.' using errcode = '42501';
  end if;
  select * into pc from public.pagamento_parcelas where id = p_parcela_id for update;
  if not found then
    raise exception 'Parcela não encontrada.';
  end if;
  select * into p from public.pagamentos where id = pc.pagamento_id for update;
  if p.status <> 'aguardando_pagamento' then
    raise exception 'O pagamento nº % não está liberado para pagamento.', p.numero;
  end if;
  if pc.status = 'pago' then
    raise exception 'Esta parcela já foi paga.';
  end if;
  if p_pago_em is null then
    raise exception 'Informe a data do pagamento.';
  end if;
  v_valor := round(pc.valor_base + pc.multa + pc.juros - pc.desconto, 2);

  update public.pagamento_parcelas
     set status = 'pago', pago_em = p_pago_em, valor_pago = coalesce(p_valor_pago, v_valor), pago_por = auth.uid()
   where id = pc.id;

  perform public._auditar('pagamento', p.id::text, 'baixa_parcela',
    'Parcela ' || pc.numero || ' paga em ' || to_char(p_pago_em, 'DD/MM/YYYY') || ' (R$ ' || to_char(coalesce(p_valor_pago, v_valor), 'FM999G999G990D00') || ')'
      || coalesce('. ' || nullif(trim(p_observacao), ''), ''),
    p.obra_id, p.id,
    jsonb_build_object('parcela', pc.numero, 'status', 'a_pagar'),
    jsonb_build_object('parcela', pc.numero, 'status', 'pago', 'valor_pago', coalesce(p_valor_pago, v_valor)));

  select count(*), count(*) filter (where status = 'pago') into v_total, v_pagas
    from public.pagamento_parcelas where pagamento_id = p.id;

  if v_pagas = v_total then
    update public.pagamentos
       set status = 'pago',
           pago_em = (select max(pago_em) from public.pagamento_parcelas where pagamento_id = p.id),
           valor_pago = (select sum(valor_pago) from public.pagamento_parcelas where pagamento_id = p.id),
           pago_por = auth.uid()
     where id = p.id;
    perform public._auditar('pagamento', p.id::text, 'baixa',
      'Todas as parcelas pagas: pagamento concluído', p.obra_id, p.id,
      jsonb_build_object('status', p.status), jsonb_build_object('status', 'pago'));
    perform public._notificar(p.created_by, 'Pagamento efetuado',
      'Todas as parcelas do pagamento nº ' || p.numero || ' foram pagas.', '/pagamentos/' || p.id, p.id);
  else
    perform public._notificar(p.created_by, 'Parcela paga',
      'Parcela ' || pc.numero || ' do pagamento nº ' || p.numero || ' foi paga. Faltam ' || (v_total - v_pagas) || ' parcela(s).',
      '/pagamentos/' || p.id, p.id);
  end if;
end
$$;

revoke all on function public.registrar_baixa_parcela(uuid, date, numeric, text) from public, anon;
grant execute on function public.registrar_baixa_parcela(uuid, date, numeric, text) to authenticated;

-- Pagamento parcelado não recebe baixa total.
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
  if exists (select 1 from public.pagamento_parcelas where pagamento_id = p_id) then
    raise exception 'Este pagamento é parcelado: dê baixa em cada parcela.';
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

create or replace function public.definir_parcelas(p_pagamento_id uuid, p_parcelas jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_item jsonb;
  v_num int := 0;
  v_base numeric(14, 2) := 0;
  v_base_item numeric(14, 2);
  v_multa numeric(14, 2);
  v_juros numeric(14, 2);
  v_desc numeric(14, 2);
  v_motivo text;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or p.created_by <> auth.uid() or public.meu_perfil() not in ('financeiro', 'suprimentos') then
    raise exception 'Somente quem cadastrou o pagamento pode parcelá-lo.' using errcode = '42501';
  end if;
  if exists (select 1 from public.pagamento_parcelas where pagamento_id = p_pagamento_id and status = 'pago') then
    raise exception 'Não é possível redividir: há parcelas já pagas.';
  end if;
  if p.status in ('pago', 'cancelado', 'rejeitado') then
    raise exception 'Não é possível parcelar um pagamento pago, cancelado ou rejeitado.';
  end if;
  if p_parcelas is null or jsonb_typeof(p_parcelas) <> 'array' or jsonb_array_length(p_parcelas) < 2 then
    raise exception 'Um pagamento parcelado precisa de pelo menos duas parcelas.';
  end if;

  for v_item in select * from jsonb_array_elements(p_parcelas) loop
    v_num := v_num + 1;
    v_base_item := round((v_item ->> 'valor')::numeric, 2);
    v_multa := round(coalesce(nullif(v_item ->> 'multa', ''), '0')::numeric, 2);
    v_juros := round(coalesce(nullif(v_item ->> 'juros', ''), '0')::numeric, 2);
    v_desc := round(coalesce(nullif(v_item ->> 'desconto', ''), '0')::numeric, 2);
    v_motivo := nullif(trim(v_item ->> 'motivo'), '');
    if v_base_item is null or v_base_item <= 0 then
      raise exception 'Parcela %: informe o valor.', v_num;
    end if;
    if nullif(v_item ->> 'vencimento', '') is null then
      raise exception 'Parcela %: informe o vencimento.', v_num;
    end if;
    if v_multa < 0 or v_juros < 0 or v_desc < 0 then
      raise exception 'Parcela %: multa, juros e desconto não podem ser negativos.', v_num;
    end if;
    if (v_multa + v_juros + v_desc) > 0 and v_motivo is null then
      raise exception 'Parcela %: multa, juros ou desconto exigem o motivo.', v_num;
    end if;
    v_base := v_base + v_base_item;
  end loop;

  if v_base <> p.valor then
    raise exception 'A soma das parcelas (R$ %) não confere com o valor do pagamento (R$ %). Multa e juros são lançados à parte, em cada parcela.', v_base, p.valor;
  end if;

  delete from public.pagamento_parcelas where pagamento_id = p_pagamento_id;
  v_num := 0;
  for v_item in select * from jsonb_array_elements(p_parcelas) loop
    v_num := v_num + 1;
    insert into public.pagamento_parcelas (pagamento_id, numero, valor_base, multa, juros, desconto, vencimento, motivo)
    values (p_pagamento_id, v_num, round((v_item ->> 'valor')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'multa', ''), '0')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'juros', ''), '0')::numeric, 2),
            round(coalesce(nullif(v_item ->> 'desconto', ''), '0')::numeric, 2),
            (v_item ->> 'vencimento')::date, nullif(trim(v_item ->> 'motivo'), ''));
  end loop;

  perform public._auditar('pagamento', p_pagamento_id::text, 'parcelou',
    'Pagamento dividido em ' || v_num || ' parcelas com vencimentos próprios (aprovação única do pagamento)',
    p.obra_id, p_pagamento_id, null, jsonb_build_object('parcelas', v_num));
end
$$;

-- ===== 20261105000013_avisos_email.sql =====
-- Avisos por e-mail (Resend).
-- Quem recebe por e-mail:
--   * Engenheiro, Administrador e Administrador master: avisos de documento aguardando assinatura.
--   * Financeiro e Suprimentos: pagamento que vence amanhã e ainda não foi concluído.
alter table public.notificacoes
  add column if not exists email_status text check (email_status in ('pendente', 'enviado', 'falhou', 'ignorado')),
  add column if not exists email_erro text,
  add column if not exists email_enviado_em timestamptz;
create index if not exists notificacoes_email_idx on public.notificacoes (email_status) where email_status = 'pendente';

create or replace function public._email_elegivel(p_titulo text, p_perfil public.perfil_usuario)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when p_titulo in ('Documento aguardando sua assinatura', 'Documentos aguardando sua assinatura')
      then p_perfil in ('engenheiro', 'administrador', 'administrador_master')
    when p_titulo = 'Pagamento vence amanhã'
      then p_perfil in ('financeiro', 'suprimentos')
    else false
  end
$$;

create or replace function public._notificar(
  p_user_id uuid, p_titulo text, p_mensagem text, p_link text, p_pagamento_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tel text;
  v_email text;
  v_perfil public.perfil_usuario;
begin
  if p_user_id is null then
    return;
  end if;
  select p.telefone, p.email, p.perfil into v_tel, v_email, v_perfil from public.profiles p where p.id = p_user_id and p.ativo;
  if not found then
    return;
  end if;
  insert into public.notificacoes (user_id, titulo, mensagem, link, pagamento_id, whatsapp_status, email_status)
  values (p_user_id, p_titulo, p_mensagem, p_link, p_pagamento_id,
          case when nullif(trim(v_tel), '') is not null then 'pendente' end,
          case when nullif(trim(v_email), '') is not null and public._email_elegivel(p_titulo, v_perfil) then 'pendente' end);
end
$$;

create or replace function public.gerar_lembretes_diarios()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_amanha date := v_hoje + 1;
  v_total int := 0;
  r record;
  u record;
begin
  -- Pagamentos em aberto que vencem amanhã (Financeiro e Suprimentos)
  for r in
    select p.id, p.numero, p.favorecido, p.valor, p.vencimento, o.nome as obra, null::int as parcela
      from public.pagamentos p join public.obras o on o.id = p.obra_id
     where p.status in ('aguardando_engenheiro', 'aguardando_administrador', 'aguardando_pagamento')
       and p.vencimento = v_amanha
    union all
    select p.id, p.numero, p.favorecido, pc.valor_base + pc.multa + pc.juros - pc.desconto, pc.vencimento, o.nome, pc.numero
      from public.pagamento_parcelas pc
      join public.pagamentos p on p.id = pc.pagamento_id
      join public.obras o on o.id = p.obra_id
     where pc.status = 'a_pagar'
       and pc.vencimento = v_amanha
       and p.status in ('aguardando_engenheiro', 'aguardando_administrador', 'aguardando_pagamento')
  loop
    for u in select pr.id from public.profiles pr where pr.ativo and pr.perfil in ('financeiro', 'suprimentos') loop
      if not exists (
        select 1 from public.notificacoes n
         where n.user_id = u.id and n.pagamento_id = r.id and n.titulo = 'Pagamento vence amanhã'
           and n.mensagem like '%' || coalesce(r.parcela::text, '') || '%'
           and (n.created_at at time zone 'America/Sao_Paulo')::date = v_hoje
      ) then
        perform public._notificar(u.id, 'Pagamento vence amanhã',
          'Nº ' || r.numero || coalesce(' (parcela ' || r.parcela || ')', '') || ' — ' || r.favorecido
            || ' — R$ ' || to_char(r.valor, 'FM999G999G990D00') || ' (' || r.obra || ') vence em '
            || to_char(r.vencimento, 'DD/MM/YYYY') || '.',
          '/pagamentos/' || r.id, r.id);
        v_total := v_total + 1;
      end if;
    end loop;
  end loop;

  -- Engenheiros e administradores: documentos aguardando assinatura (uma vez por dia)
  for u in
    select pr.id as user_id, count(*) as qtd, min(p.vencimento) as primeiro
      from public.pagamentos p
      join public.obras o on o.id = p.obra_id
      join public.profiles pr on pr.ativo and (
            (p.status = 'aguardando_engenheiro' and pr.id = o.engenheiro_id)
         or (p.status = 'aguardando_administrador' and pr.id = o.administrador_id))
     group by pr.id
  loop
    if not exists (select 1 from public.notificacoes n where n.user_id = u.user_id
                    and n.titulo = 'Documentos aguardando sua assinatura'
                    and (n.created_at at time zone 'America/Sao_Paulo')::date = v_hoje) then
      perform public._notificar(u.user_id, 'Documentos aguardando sua assinatura',
        u.qtd || ' documento(s) pendente(s). Vencimento mais próximo: ' || to_char(u.primeiro, 'DD/MM/YYYY') || '.',
        '/aprovacoes', null);
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end
$$;

revoke all on function public.gerar_lembretes_diarios() from public, anon, authenticated;

-- ===== 20261107000001_fundo_fixo.sql =====
-- Fundo fixo: um fundo por pessoa e por obra. Gastos individuais com anexos assinados.
-- Status do fundo é calculado pelo saldo: acabando (10% ou menos), esgotado (zero ou menos).
create type public.status_fundo as enum ('em_andamento', 'acabando', 'esgotado', 'fechado');
create type public.status_gasto_fundo as enum ('pendente', 'aprovado', 'recusado');

create table public.fundos_fixos (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras (id),
  pessoa_id uuid not null references public.profiles (id),
  valor numeric(14, 2) not null check (valor > 0),
  status public.status_fundo not null default 'em_andamento',
  criado_por uuid not null references public.profiles (id) default auth.uid(),
  fechado_em timestamptz,
  reposicao numeric(14, 2),
  reembolso numeric(14, 2),
  saldo_repassado numeric(14, 2),
  pagamento_id uuid references public.pagamentos (id),
  created_at timestamptz not null default now()
);
-- Só pode existir um fundo aberto por pessoa e obra.
create unique index fundos_aberto_unico on public.fundos_fixos (obra_id, pessoa_id)
  where status <> 'fechado';

create table public.fundo_gastos (
  id uuid primary key default gen_random_uuid(),
  fundo_id uuid not null references public.fundos_fixos (id),
  descricao text not null check (length(trim(descricao)) > 0),
  data_gasto date not null,
  valor numeric(14, 2) not null check (valor > 0),
  status public.status_gasto_fundo not null default 'pendente',
  motivo_recusa text,
  decidido_por uuid references public.profiles (id),
  decidido_em timestamptz,
  lancado_por uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);
create index fundo_gastos_fundo_idx on public.fundo_gastos (fundo_id);

create table public.fundo_gasto_anexos (
  id uuid primary key default gen_random_uuid(),
  gasto_id uuid not null references public.fundo_gastos (id),
  storage_path text not null unique,
  nome_arquivo text not null,
  mime_type text,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  assinado boolean not null default false,
  enviado_por uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.fundos_fixos enable row level security;
alter table public.fundo_gastos enable row level security;
alter table public.fundo_gasto_anexos enable row level security;

-- Visão: o dono do fundo, o Financeiro e quem pode ver a obra (administrador responsável).
create policy fundos_select on public.fundos_fixos for select to authenticated
  using (pessoa_id = auth.uid() or public.is_financeiro() or public.pode_ver_obra(obra_id));
create policy fundo_gastos_select on public.fundo_gastos for select to authenticated
  using (exists (select 1 from public.fundos_fixos f where f.id = fundo_id
         and (f.pessoa_id = auth.uid() or public.is_financeiro() or public.pode_ver_obra(f.obra_id))));
create policy fundo_anexos_select on public.fundo_gasto_anexos for select to authenticated
  using (exists (select 1 from public.fundo_gastos g join public.fundos_fixos f on f.id = g.fundo_id
         where g.id = gasto_id and (f.pessoa_id = auth.uid() or public.is_financeiro() or public.pode_ver_obra(f.obra_id))));

revoke all on public.fundos_fixos, public.fundo_gastos, public.fundo_gasto_anexos from anon;
revoke insert, update, delete, truncate on public.fundos_fixos, public.fundo_gastos, public.fundo_gasto_anexos from authenticated;
grant select on public.fundos_fixos, public.fundo_gastos, public.fundo_gasto_anexos to authenticated;

-- Saldo do fundo: valor menos os gastos aprovados.
create or replace function public._saldo_fundo(p_fundo uuid)
returns numeric
language sql stable security definer set search_path = ''
as $$
  select f.valor - coalesce((select sum(g.valor) from public.fundo_gastos g where g.fundo_id = f.id and g.status = 'aprovado'), 0)
    from public.fundos_fixos f where f.id = p_fundo
$$;

-- Valor em reais no padrão pt-BR (1.500,00), independente da configuração de locale do banco.
create or replace function public._reais(p_valor numeric)
returns text
language sql immutable set search_path = ''
as $$
  select translate(to_char(p_valor, 'FM999G999G999G990D00'), '.,', ',.')
$$;

-- Atualiza o status pelo saldo e avisa o Financeiro quando acaba ou esgota.
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
          || '. Feche o fundo e crie um novo.',
        '/fundos-fixos', null);
    end if;
  end if;
end
$$;

-- Criar fundo (Financeiro). Um aberto por pessoa e obra.
create or replace function public.criar_fundo_fixo(p_obra_id uuid, p_pessoa_id uuid, p_valor numeric)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro cria fundos fixos.' using errcode = '42501';
  end if;
  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe um valor de fundo maior que zero.';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_pessoa_id and pr.ativo and pr.perfil in ('engenheiro', 'suprimentos')) then
    raise exception 'O fundo fixo é para engenheiro ou Suprimentos.';
  end if;
  insert into public.fundos_fixos (obra_id, pessoa_id, valor)
  values (p_obra_id, p_pessoa_id, round(p_valor, 2))
  returning id into v_id;
  perform public._auditar('fundo_fixo', v_id::text, 'criou', 'Fundo fixo criado', p_obra_id, null, null,
    jsonb_build_object('pessoa_id', p_pessoa_id, 'valor', p_valor));
  return v_id;
end
$$;

-- Lançar gasto: dono do fundo. Com administrador na obra, fica pendente; senão conta na hora.
create or replace function public.lancar_gasto_fundo(p_fundo_id uuid, p_descricao text, p_data date, p_valor numeric)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  o public.obras;
  v_id uuid;
  v_status public.status_gasto_fundo;
begin
  select * into f from public.fundos_fixos where id = p_fundo_id;
  if not found or f.pessoa_id <> auth.uid() then
    raise exception 'Somente a pessoa do fundo lança gastos nele.' using errcode = '42501';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe o valor do gasto.';
  end if;
  if nullif(trim(p_descricao), '') is null or p_data is null then
    raise exception 'Informe a descrição e a data do gasto.';
  end if;
  select * into o from public.obras where id = f.obra_id;
  v_status := case when o.administrador_id is not null then 'pendente'::public.status_gasto_fundo else 'aprovado'::public.status_gasto_fundo end;
  insert into public.fundo_gastos (fundo_id, descricao, data_gasto, valor, status, decidido_em)
  values (p_fundo_id, trim(p_descricao), p_data, round(p_valor, 2), v_status,
          case when v_status = 'aprovado' then now() end)
  returning id into v_id;
  if v_status = 'aprovado' then
    perform public._atualizar_status_fundo(p_fundo_id);
  end if;
  return v_id;
end
$$;

-- Aprovar ou recusar gasto: administrador responsável pela obra (ou administrador master).
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

-- Registrar anexo (original ou assinado) de um gasto: dono do fundo.
create or replace function public.registrar_anexo_gasto(
  p_gasto_id uuid, p_storage_path text, p_nome text, p_mime text, p_sha256 text, p_assinado boolean
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  g public.fundo_gastos;
  f public.fundos_fixos;
  v_id uuid;
begin
  select * into g from public.fundo_gastos where id = p_gasto_id;
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
  return v_id;
end
$$;

-- Fechamento do fundo (Financeiro). Gera um pagamento só com o que for reposição e reembolso.
create or replace function public.fechar_fundo_fixo(p_fundo_id uuid, p_vencimento date)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  o public.obras;
  v_pessoa text;
  v_gasto numeric(14, 2);
  v_reposicao numeric(14, 2) := 0;
  v_reembolso numeric(14, 2) := 0;
  v_saldo numeric(14, 2);
  v_pag uuid;
  v_desc text;
  v_forma public.forma_pagamento := 'pix';
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro fecha fundos fixos.' using errcode = '42501';
  end if;
  select * into f from public.fundos_fixos where id = p_fundo_id for update;
  if not found or f.status = 'fechado' then
    raise exception 'Fundo não encontrado ou já fechado.';
  end if;
  select * into o from public.obras where id = f.obra_id;
  select nome into v_pessoa from public.profiles where id = f.pessoa_id;
  v_gasto := coalesce((select sum(g.valor) from public.fundo_gastos g where g.fundo_id = f.id and g.status = 'aprovado'), 0);
  v_saldo := f.valor - v_gasto;

  if f.status = 'esgotado' then
    v_reposicao := least(v_gasto, f.valor);
    v_reembolso := greatest(v_gasto - f.valor, 0);
  end if;
  -- Acabando: sem reposição; o saldo que sobrou é registrado para repassar à empresa.

  if v_reposicao + v_reembolso > 0 then
    v_desc := 'Fundo fixo (' || coalesce(v_pessoa, '') || '): reposição de R$ '
      || public._reais(v_reposicao) || ' + reembolso de R$ ' || public._reais(v_reembolso);
    insert into public.pagamentos (obra_id, fornecedor_id, favorecido, descricao, valor, vencimento, forma_pagamento,
                                   numero_documento, observacoes, fluxo, status, created_by)
    values (f.obra_id, null, coalesce(v_pessoa, 'Fundo fixo'), v_desc, v_reposicao + v_reembolso,
            coalesce(p_vencimento, current_date), v_forma, null,
            'Gastos aprovados do fundo fixo; anexos com as assinaturas de quem gastou.',
            'C', 'aguardando_pagamento', auth.uid())
    returning id into v_pag;
    perform public._notificar_etapa(v_pag);
  end if;

  update public.fundos_fixos
     set status = 'fechado', fechado_em = now(), reposicao = v_reposicao, reembolso = v_reembolso,
         saldo_repassado = case when v_saldo > 0 then v_saldo else 0 end, pagamento_id = v_pag
   where id = p_fundo_id;
  perform public._auditar('fundo_fixo', p_fundo_id::text, 'fechou',
    'Fundo fechado. Reposição R$ ' || public._reais(v_reposicao) || ', reembolso R$ ' || public._reais(v_reembolso)
      || case when v_saldo > 0 then ', saldo a repassar R$ ' || public._reais(v_saldo) else '' end,
    f.obra_id, v_pag, null, jsonb_build_object('reposicao', v_reposicao, 'reembolso', v_reembolso, 'saldo', greatest(v_saldo, 0)));
  return v_pag;
end
$$;

revoke all on function public._saldo_fundo(uuid) from public, anon, authenticated;
revoke all on function public._atualizar_status_fundo(uuid) from public, anon, authenticated;
revoke all on function public.criar_fundo_fixo(uuid, uuid, numeric) from public, anon;
revoke all on function public.lancar_gasto_fundo(uuid, text, date, numeric) from public, anon;
revoke all on function public.decidir_gasto_fundo(uuid, boolean, text) from public, anon;
revoke all on function public.registrar_anexo_gasto(uuid, text, text, text, text, boolean) from public, anon;
revoke all on function public.fechar_fundo_fixo(uuid, date) from public, anon;
grant execute on function public.criar_fundo_fixo(uuid, uuid, numeric) to authenticated;
grant execute on function public.lancar_gasto_fundo(uuid, text, date, numeric) to authenticated;
grant execute on function public.decidir_gasto_fundo(uuid, boolean, text) to authenticated;
grant execute on function public.registrar_anexo_gasto(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function public.fechar_fundo_fixo(uuid, date) to authenticated;

-- Anexos de fundo ficam no bucket de documentos, em pasta própria do fundo.
create policy fundo_anexos_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'documentos' and name like 'fundos/%'
    and exists (select 1 from public.fundos_fixos f
                where f.id = public._uuid_ou_nulo(split_part(name, '/', 2)) and f.pessoa_id = auth.uid() and f.status <> 'fechado'));
create policy fundo_anexos_leitura on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and name like 'fundos/%'
    and exists (select 1 from public.fundos_fixos f
                where f.id = public._uuid_ou_nulo(split_part(name, '/', 2))
                  and (f.pessoa_id = auth.uid() or public.is_financeiro() or public.pode_ver_obra(f.obra_id))));

-- Avisos de fundo fixo por e-mail (Financeiro).
create or replace function public._email_elegivel(p_titulo text, p_perfil public.perfil_usuario)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when p_titulo in ('Documento aguardando sua assinatura', 'Documentos aguardando sua assinatura')
      then p_perfil in ('engenheiro', 'administrador', 'administrador_master')
    when p_titulo = 'Pagamento vence amanhã'
      then p_perfil in ('financeiro', 'suprimentos')
    when p_titulo in ('Fundo fixo acabando', 'Fundo fixo esgotado')
      then p_perfil = 'financeiro'
    else false
  end
$$;

-- ===== 20261108000001_notas_contabeis.sql =====
-- Notas fiscais identificadas ao serem anexadas a um pagamento, para envio à contabilidade.
-- Categorias:
--   tomado_pj_retencao       NFS-e de serviço tomado de pessoa jurídica com retenção (INSS, IRRF, CSRF ou ISS)
--   tomado_pf                NFS-e ou nota avulsa de serviço tomado de pessoa física
--   mei_servicos_especificos nota de MEI que presta apenas hidráulica, eletricidade, pintura, alvenaria,
--                            carpintaria ou manutenção/reparo de veículos
create type public.categoria_nota_contabil as enum ('tomado_pj_retencao', 'tomado_pf', 'mei_servicos_especificos');

create table public.notas_contabeis (
  id uuid primary key default gen_random_uuid(),
  documento_id uuid not null unique references public.documentos (id),
  pagamento_id uuid not null references public.pagamentos (id),
  obra_id uuid not null references public.obras (id),
  categoria public.categoria_nota_contabil not null,
  prestador_documento text,
  prestador_nome text,
  numero text,
  data_emissao date,
  valor numeric(14, 2),
  retencoes jsonb not null default '{}'::jsonb,
  descricao_servico text,
  criada_em timestamptz not null default now(),
  enviada_em timestamptz,
  enviada_por uuid references public.profiles (id)
);
create index notas_contabeis_obra_idx on public.notas_contabeis (obra_id, criada_em desc);

alter table public.notas_contabeis enable row level security;

-- Visível ao Financeiro e ao Suprimentos das obras em que atuam (administrador master vê tudo pela regra da obra).
create policy notas_contabeis_select on public.notas_contabeis for select to authenticated
  using ((public.is_financeiro() or public.meu_perfil() = 'suprimentos') and public.pode_ver_obra(obra_id));

revoke all on public.notas_contabeis from anon;
revoke insert, update, delete, truncate on public.notas_contabeis from authenticated;
grant select on public.notas_contabeis to authenticated;

-- Registra a nota identificada a partir de um documento do tipo nota fiscal. Chamada logo após o upload.
create or replace function public.registrar_nota_contabil(
  p_documento_id uuid,
  p_categoria public.categoria_nota_contabil,
  p_dados jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.documentos;
  v_id uuid;
begin
  select * into d from public.documentos where id = p_documento_id and ativo;
  if not found or not public.pode_ver_obra(d.obra_id) then
    raise exception 'Documento não encontrado.';
  end if;
  if d.tipo <> 'nota_fiscal' then
    raise exception 'Só notas fiscais entram na lista para a contabilidade.';
  end if;

  insert into public.notas_contabeis (
    documento_id, pagamento_id, obra_id, categoria, prestador_documento, prestador_nome, numero,
    data_emissao, valor, retencoes, descricao_servico
  ) values (
    d.id, d.pagamento_id, d.obra_id, p_categoria,
    nullif(p_dados->>'prestador_documento', ''), nullif(p_dados->>'prestador_nome', ''), nullif(p_dados->>'numero', ''),
    nullif(p_dados->>'data_emissao', '')::date, nullif(p_dados->>'valor', '')::numeric,
    coalesce(p_dados->'retencoes', '{}'::jsonb), nullif(p_dados->>'descricao_servico', '')
  )
  on conflict (documento_id) do update
    set categoria = excluded.categoria, prestador_documento = excluded.prestador_documento,
        prestador_nome = excluded.prestador_nome, numero = excluded.numero, data_emissao = excluded.data_emissao,
        valor = excluded.valor, retencoes = excluded.retencoes, descricao_servico = excluded.descricao_servico,
        enviada_em = null, enviada_por = null
  returning id into v_id;

  perform public._auditar('nota_contabil', v_id::text, 'identificou',
    'Nota identificada para a contabilidade: ' || p_categoria::text, d.obra_id, d.pagamento_id, null,
    jsonb_build_object('documento_id', d.id, 'categoria', p_categoria));
  return v_id;
end
$$;

-- Marca a nota como enviada à contabilidade (Financeiro).
create or replace function public.marcar_nota_contabil_enviada(p_id uuid, p_enviada boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  n public.notas_contabeis;
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro marca notas como enviadas à contabilidade.' using errcode = '42501';
  end if;
  select * into n from public.notas_contabeis where id = p_id for update;
  if not found then
    raise exception 'Nota não encontrada.';
  end if;
  update public.notas_contabeis
     set enviada_em = case when p_enviada then now() else null end,
         enviada_por = case when p_enviada then auth.uid() else null end
   where id = p_id;
  perform public._auditar('nota_contabil', p_id::text, case when p_enviada then 'enviou' else 'reabriu' end,
    case when p_enviada then 'Nota marcada como enviada à contabilidade' else 'Nota reaberta para envio à contabilidade' end,
    n.obra_id, n.pagamento_id, null, null);
end
$$;

revoke all on function public.registrar_nota_contabil(uuid, public.categoria_nota_contabil, jsonb) from public, anon;
revoke all on function public.marcar_nota_contabil_enviada(uuid, boolean) from public, anon;
grant execute on function public.registrar_nota_contabil(uuid, public.categoria_nota_contabil, jsonb) to authenticated;
grant execute on function public.marcar_nota_contabil_enviada(uuid, boolean) to authenticated;

-- ===== 20261109000001_medicao_emitida_tipo.sql =====
-- Novo tipo de nota para a contabilidade: medição emitida pela empresa (boletim de medição).
-- Em arquivo próprio: o Postgres não deixa usar um valor de enum criado na mesma transação.

-- ===== 20261109000002_medicao_impostos.sql =====
-- Valor líquido da medição: base do cálculo de imposto retido e devido.
alter table public.notas_contabeis add column if not exists valor_liquido numeric(14, 2);

-- Registrar a nota também guarda o valor líquido (quando a nota traz esse valor).
create or replace function public.registrar_nota_contabil(
  p_documento_id uuid,
  p_categoria public.categoria_nota_contabil,
  p_dados jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.documentos;
  v_id uuid;
begin
  select * into d from public.documentos where id = p_documento_id and ativo;
  if not found or not public.pode_ver_obra(d.obra_id) then
    raise exception 'Documento não encontrado.';
  end if;
  if d.tipo <> 'nota_fiscal' then
    raise exception 'Só notas fiscais entram na lista para a contabilidade.';
  end if;

  insert into public.notas_contabeis (
    documento_id, pagamento_id, obra_id, categoria, prestador_documento, prestador_nome, numero,
    data_emissao, valor, valor_liquido, retencoes, descricao_servico
  ) values (
    d.id, d.pagamento_id, d.obra_id, p_categoria,
    nullif(p_dados->>'prestador_documento', ''), nullif(p_dados->>'prestador_nome', ''), nullif(p_dados->>'numero', ''),
    nullif(p_dados->>'data_emissao', '')::date, nullif(p_dados->>'valor', '')::numeric,
    nullif(p_dados->>'valor_liquido', '')::numeric,
    coalesce(p_dados->'retencoes', '{}'::jsonb), nullif(p_dados->>'descricao_servico', '')
  )
  on conflict (documento_id) do update
    set categoria = excluded.categoria, prestador_documento = excluded.prestador_documento,
        prestador_nome = excluded.prestador_nome, numero = excluded.numero, data_emissao = excluded.data_emissao,
        valor = excluded.valor, valor_liquido = excluded.valor_liquido, retencoes = excluded.retencoes,
        descricao_servico = excluded.descricao_servico, enviada_em = null, enviada_por = null
  returning id into v_id;

  perform public._auditar('nota_contabil', v_id::text, 'identificou',
    'Nota identificada para a contabilidade: ' || p_categoria::text, d.obra_id, d.pagamento_id, null,
    jsonb_build_object('documento_id', d.id, 'categoria', p_categoria));
  return v_id;
end
$$;
