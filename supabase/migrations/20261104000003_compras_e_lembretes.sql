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
