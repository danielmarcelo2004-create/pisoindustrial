-- Notas de medição anexadas diretamente na aba "Notas de medição" (sem pagamento).
-- O arquivo fica no bucket documentos, na pasta <obra>/medicoes/.

create table public.notas_medicao (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras (id),
  storage_path text not null unique,
  nome_arquivo text not null,
  mime_type text,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  numero text,
  prestador_documento text,
  prestador_nome text,
  data_emissao date,
  valor numeric(14, 2) not null check (valor > 0),
  valor_liquido numeric(14, 2) not null check (valor_liquido >= 0),
  descricao text,
  criada_por uuid not null references public.profiles (id) default auth.uid(),
  criada_em timestamptz not null default now(),
  check (valor_liquido <= valor)
);
create index notas_medicao_obra_idx on public.notas_medicao (obra_id, criada_em desc);

alter table public.notas_medicao enable row level security;

create policy notas_medicao_select on public.notas_medicao for select to authenticated
  using ((public.is_financeiro() or public.meu_perfil() = 'suprimentos') and public.pode_ver_obra(obra_id));

revoke all on public.notas_medicao from anon;
revoke insert, update, delete, truncate on public.notas_medicao from authenticated;
grant select on public.notas_medicao to authenticated;

-- Registra a nota de medição após o upload do arquivo.
create or replace function public.registrar_nota_medicao(
  p_obra_id uuid,
  p_storage_path text,
  p_nome text,
  p_mime text,
  p_sha256 text,
  p_dados jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_valor numeric(14, 2) := nullif(p_dados->>'valor', '')::numeric;
  v_liquido numeric(14, 2) := nullif(p_dados->>'valor_liquido', '')::numeric;
begin
  if not (public.is_financeiro() or public.meu_perfil() = 'suprimentos') then
    raise exception 'Somente o Financeiro e o Suprimentos anexam notas de medição.' using errcode = '42501';
  end if;
  if not public.pode_ver_obra(p_obra_id) then
    raise exception 'Obra não encontrada.';
  end if;
  if p_storage_path not like p_obra_id::text || '/medicoes/%' then
    raise exception 'Caminho de arquivo inválido.';
  end if;
  if not exists (select 1 from storage.objects s where s.bucket_id = 'documentos' and s.name = p_storage_path) then
    raise exception 'Arquivo não encontrado no armazenamento.';
  end if;
  insert into public.notas_medicao (
    obra_id, storage_path, nome_arquivo, mime_type, sha256, numero, prestador_documento, prestador_nome,
    data_emissao, valor, valor_liquido, descricao
  ) values (
    p_obra_id, p_storage_path, p_nome, p_mime, lower(p_sha256),
    nullif(p_dados->>'numero', ''), nullif(p_dados->>'prestador_documento', ''), nullif(p_dados->>'prestador_nome', ''),
    nullif(p_dados->>'data_emissao', '')::date, v_valor, v_liquido, nullif(p_dados->>'descricao', '')
  )
  returning id into v_id;

  perform public._auditar('nota_medicao', v_id::text, 'anexou', 'Nota de medição anexada: ' || p_nome, p_obra_id, null, null,
    jsonb_build_object('valor', v_valor, 'valor_liquido', v_liquido));
  return v_id;
end
$$;

revoke all on function public.registrar_nota_medicao(uuid, text, text, text, text, jsonb) from public, anon;
grant execute on function public.registrar_nota_medicao(uuid, text, text, text, text, jsonb) to authenticated;

-- Envio de arquivos: além dos pagamentos, a pasta <obra>/medicoes/ para Financeiro e Suprimentos.
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
  or (
    split_part(p_nome, '/', 2) = 'medicoes'
    and (public.is_financeiro() or public.meu_perfil() = 'suprimentos')
    and public.pode_ver_obra(public._uuid_ou_nulo(split_part(p_nome, '/', 1)))
  )
$$;
