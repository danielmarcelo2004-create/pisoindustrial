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
