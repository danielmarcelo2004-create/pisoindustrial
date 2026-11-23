-- Contas a receber.
-- O recebimento nasce na conciliação: a entrada no extrato vira "Novo lançamento" de receita, já recebida
-- (centro de custo, categoria de receita, cliente). Depois, se houver, anexa-se a nota de medição.
-- Mexem: Financeiro e administrador master. Veem: todos os perfis, nas obras que já podem ver
-- (o engenheiro acompanha o resultado da obra). A conciliação em si continua só com o Financeiro.

-- Categorias passam a ter tipo: despesa (as atuais) ou receita.
alter table public.categorias add column if not exists tipo text not null default 'despesa' check (tipo in ('despesa', 'receita'));
drop index if exists public.categorias_nome_unico;
create unique index if not exists categorias_nome_unico on public.categorias (tipo, lower(trim(nome)));

create or replace function public.criar_categoria_receita(p_nome text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_nome text := trim(coalesce(p_nome, ''));
begin
  if public.meu_perfil() not in ('financeiro', 'administrador_master') then
    raise exception 'Somente o Financeiro e o administrador master cadastram categorias.';
  end if;
  if v_nome = '' then raise exception 'Informe o nome da categoria.'; end if;
  select id into v_id from public.categorias where tipo = 'receita' and lower(trim(nome)) = lower(v_nome);
  if v_id is not null then
    update public.categorias set ativo = true where id = v_id;
    return v_id;
  end if;
  insert into public.categorias (nome, tipo) values (left(v_nome, 80), 'receita') returning id into v_id;
  perform public._auditar('categoria', v_id::text, 'criou', 'Categoria de receita cadastrada: ' || v_nome);
  return v_id;
end
$$;
revoke all on function public.criar_categoria_receita(text) from public, anon;
grant execute on function public.criar_categoria_receita(text) to authenticated;

create table public.recebimentos (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity unique,
  obra_id uuid not null references public.obras (id),
  categoria_id uuid references public.categorias (id),
  cliente text not null check (length(trim(cliente)) > 0),
  descricao text not null check (length(trim(descricao)) > 0),
  valor numeric(14, 2) not null check (valor > 0),
  vencimento date not null,
  data_competencia date,
  status text not null default 'aberto' check (status in ('aberto', 'recebido', 'cancelado')),
  recebido_em date,
  valor_recebido numeric(14, 2),
  conta_bancaria_id uuid references public.contas_bancarias (id),
  lancado_conciliacao boolean not null default false,
  nota_medicao_id uuid unique references public.notas_medicao (id),
  observacoes text,
  cancelamento_motivo text,
  created_by uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'recebido' or (recebido_em is not null and valor_recebido is not null))
);
create index recebimentos_obra_idx on public.recebimentos (obra_id, vencimento);
create index recebimentos_vencimento_idx on public.recebimentos (vencimento);

alter table public.recebimentos enable row level security;
create policy recebimentos_ler on public.recebimentos for select to authenticated using (public.pode_ver_obra(obra_id));
revoke all on public.recebimentos from anon;
revoke insert, update, delete, truncate on public.recebimentos from authenticated;
grant select on public.recebimentos to authenticated;

-- A entrada do extrato conciliada com o recebimento
alter table public.extrato_linhas add column if not exists recebimento_id uuid references public.recebimentos (id);
create unique index if not exists extrato_linhas_recebimento_unico on public.extrato_linhas (recebimento_id) where recebimento_id is not null;

create or replace function public._exigir_mexer_receber()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if public.meu_perfil() not in ('financeiro', 'administrador_master') then
    raise exception 'Somente o Financeiro e o administrador master alteram contas a receber.';
  end if;
end
$$;

-- "Novo lançamento" numa entrada do extrato: receita já recebida (data e valor do banco).
create or replace function public.criar_recebimento_conciliacao(
  p_linha_id uuid, p_obra_id uuid, p_categoria_id uuid, p_cliente text, p_descricao text,
  p_competencia date default null, p_observacoes text default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  v_id uuid;
begin
  perform public._exigir_financeiro_conciliacao();
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found then raise exception 'Lançamento do banco não encontrado.'; end if;
  if l.situacao <> 'pendente' then raise exception 'Este lançamento do banco já foi conciliado ou arquivado.'; end if;
  if l.valor <= 0 then raise exception 'Saídas do banco não viram recebimento: use Novo lançamento de despesa.'; end if;
  if p_obra_id is null or not exists (select 1 from public.obras where id = p_obra_id) then raise exception 'Escolha o centro de custo.'; end if;
  if p_categoria_id is null or not exists (select 1 from public.categorias where id = p_categoria_id and tipo = 'receita' and ativo) then
    raise exception 'Escolha a categoria de receita.';
  end if;
  if length(trim(coalesce(p_cliente, ''))) = 0 then raise exception 'Informe o cliente.'; end if;
  if length(trim(coalesce(p_descricao, ''))) = 0 then raise exception 'Informe a descrição.'; end if;
  insert into public.recebimentos (obra_id, categoria_id, cliente, descricao, valor, vencimento, data_competencia, status,
                                   recebido_em, valor_recebido, conta_bancaria_id, lancado_conciliacao, observacoes)
  values (p_obra_id, p_categoria_id, left(trim(p_cliente), 200), left(trim(p_descricao), 300), l.valor, l.data,
          coalesce(p_competencia, l.data), 'recebido', l.data, l.valor, l.conta_id, true, nullif(trim(coalesce(p_observacoes, '')), ''))
  returning id into v_id;
  update public.extrato_linhas set situacao = 'conciliada', recebimento_id = v_id, tratado_por = auth.uid(), tratado_em = now() where id = l.id;
  perform public._auditar('recebimento', v_id::text, 'criou',
    'Recebimento lançado pela conciliação: R$ ' || public._brl(l.valor) || ' de ' || trim(p_cliente) || ' em ' || to_char(l.data, 'DD/MM/YYYY'), p_obra_id);
  return v_id;
end
$$;
revoke all on function public.criar_recebimento_conciliacao(uuid, uuid, uuid, text, text, date, text) from public, anon;
grant execute on function public.criar_recebimento_conciliacao(uuid, uuid, uuid, text, text, date, text) to authenticated;

-- Editar descrição, cliente, centro de custo, categoria, competência e observações (valor e datas vêm do banco).
create or replace function public.editar_recebimento(
  p_id uuid, p_obra_id uuid, p_categoria_id uuid, p_cliente text, p_descricao text, p_competencia date, p_observacoes text
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.recebimentos;
begin
  perform public._exigir_mexer_receber();
  select * into r from public.recebimentos where id = p_id for update;
  if not found then raise exception 'Recebimento não encontrado.'; end if;
  if r.status = 'cancelado' then raise exception 'Recebimento cancelado não pode ser alterado.'; end if;
  if p_obra_id is null or not exists (select 1 from public.obras where id = p_obra_id) then raise exception 'Escolha o centro de custo.'; end if;
  if p_categoria_id is not null and not exists (select 1 from public.categorias where id = p_categoria_id and tipo = 'receita') then
    raise exception 'Escolha uma categoria de receita.';
  end if;
  if length(trim(coalesce(p_cliente, ''))) = 0 then raise exception 'Informe o cliente.'; end if;
  if length(trim(coalesce(p_descricao, ''))) = 0 then raise exception 'Informe a descrição.'; end if;
  if r.nota_medicao_id is not null and p_obra_id <> r.obra_id then
    raise exception 'A nota de medição anexada é de outro centro de custo: retire a nota antes de trocar.';
  end if;
  update public.recebimentos
     set obra_id = p_obra_id, categoria_id = p_categoria_id, cliente = left(trim(p_cliente), 200), descricao = left(trim(p_descricao), 300),
         data_competencia = coalesce(p_competencia, data_competencia), observacoes = nullif(trim(coalesce(p_observacoes, '')), ''), updated_at = now()
   where id = p_id;
  perform public._auditar('recebimento', p_id::text, 'editou', 'Recebimento nº ' || r.numero || ' alterado', p_obra_id, null,
    jsonb_build_object('obra_id', r.obra_id, 'categoria_id', r.categoria_id, 'cliente', r.cliente, 'descricao', r.descricao, 'data_competencia', r.data_competencia),
    jsonb_build_object('obra_id', p_obra_id, 'categoria_id', p_categoria_id, 'cliente', trim(p_cliente), 'descricao', trim(p_descricao), 'data_competencia', p_competencia));
end
$$;
revoke all on function public.editar_recebimento(uuid, uuid, uuid, text, text, date, text) from public, anon;
grant execute on function public.editar_recebimento(uuid, uuid, uuid, text, text, date, text) to authenticated;

-- Anexa (ou retira, com p_nota_id nulo) a nota de medição do mesmo centro de custo.
create or replace function public.vincular_nota_medicao(p_recebimento_id uuid, p_nota_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.recebimentos;
  n public.notas_medicao;
begin
  perform public._exigir_mexer_receber();
  select * into r from public.recebimentos where id = p_recebimento_id for update;
  if not found then raise exception 'Recebimento não encontrado.'; end if;
  if r.status = 'cancelado' then raise exception 'Recebimento cancelado não pode ser alterado.'; end if;
  if p_nota_id is not null then
    select * into n from public.notas_medicao where id = p_nota_id;
    if not found then raise exception 'Nota de medição não encontrada.'; end if;
    if n.obra_id <> r.obra_id then raise exception 'A nota de medição é de outro centro de custo.'; end if;
    if exists (select 1 from public.recebimentos where nota_medicao_id = p_nota_id and id <> r.id) then
      raise exception 'Esta nota de medição já está anexada a outro recebimento.';
    end if;
  end if;
  update public.recebimentos set nota_medicao_id = p_nota_id, updated_at = now() where id = r.id;
  perform public._auditar('recebimento', r.id::text, case when p_nota_id is null then 'retirou_nota' else 'anexou_nota' end,
    case when p_nota_id is null then 'Nota de medição retirada do recebimento nº ' || r.numero
         else 'Nota de medição ' || coalesce('nº ' || n.numero, n.nome_arquivo) || ' (R$ ' || public._brl(n.valor) || ') anexada ao recebimento nº ' || r.numero end,
    r.obra_id);
end
$$;
revoke all on function public.vincular_nota_medicao(uuid, uuid) from public, anon;
grant execute on function public.vincular_nota_medicao(uuid, uuid) to authenticated;

-- Notas de medição: quem vê o recebimento vê a nota anexada a ele (só os dados; o arquivo segue a regra dos documentos)
create policy notas_medicao_select_recebimento on public.notas_medicao for select to authenticated
  using (exists (select 1 from public.recebimentos r where r.nota_medicao_id = notas_medicao.id and public.pode_ver_obra(r.obra_id)));

-- Desfazer: também solta o recebimento (voltar_aberto = cancelar o recebimento criado pela conciliação).
create or replace function public.desfazer_conciliacao(p_linha_id uuid, p_voltar_aberto boolean, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  ci public.conciliacao_itens;
  p public.pagamentos;
  t public.transferencias;
  r public.recebimentos;
begin
  perform public._exigir_financeiro_conciliacao();
  if length(trim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'Informe o motivo.';
  end if;
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found or l.situacao <> 'conciliada' then
    raise exception 'Este lançamento do banco não está conciliado.';
  end if;
  if l.recebimento_id is not null then
    select * into r from public.recebimentos where id = l.recebimento_id for update;
    update public.extrato_linhas set situacao = 'pendente', recebimento_id = null, tratado_por = null, tratado_em = null where id = l.id;
    if p_voltar_aberto then
      update public.recebimentos set status = 'cancelado', cancelamento_motivo = 'Conciliação desfeita: ' || trim(p_motivo), updated_at = now() where id = r.id;
    end if;
    perform public._auditar('recebimento', r.id::text, 'desconciliou',
      'Conciliação do recebimento nº ' || r.numero || ' com o extrato de ' || to_char(l.data, 'DD/MM/YYYY') || ' desfeita'
        || case when p_voltar_aberto then ' e o recebimento foi cancelado' else '' end || '. Motivo: ' || trim(p_motivo), r.obra_id);
    return;
  end if;
  if l.estorno_linha is not null then
    update public.extrato_linhas set situacao = 'pendente', estorno_linha = null, tratado_por = null, tratado_em = null
     where id in (l.id, l.estorno_linha);
    perform public._auditar('conta_bancaria', l.conta_id::text, 'desconciliou',
      'Estorno de ' || to_char(l.data, 'DD/MM/YYYY') || ' (R$ ' || public._brl(abs(l.valor)) || ') separado. Motivo: ' || trim(p_motivo));
    return;
  end if;
  if l.transferencia_id is not null then
    select * into t from public.transferencias where id = l.transferencia_id for update;
    update public.extrato_linhas set situacao = 'pendente', transferencia_id = null, tratado_por = null, tratado_em = null where id = l.id;
    update public.transferencias
       set linha_origem = case when linha_origem = l.id then null else linha_origem end,
           linha_destino = case when linha_destino = l.id then null else linha_destino end
     where id = t.id;
    delete from public.transferencias where id = t.id and linha_origem is null and linha_destino is null;
    perform public._auditar('conta_bancaria', l.conta_id::text, 'desconciliou',
      'Transferência de ' || to_char(l.data, 'DD/MM/YYYY') || ' (R$ ' || public._brl(abs(l.valor)) || ') desfeita. Motivo: ' || trim(p_motivo));
    return;
  end if;
  for ci in select * from public.conciliacao_itens where linha_id = l.id loop
    delete from public.conciliacao_itens where id = ci.id; -- antes do estorno, para o gatilho não repetir o trabalho
    select * into p from public.pagamentos where id = ci.pagamento_id for update;
    if p_voltar_aberto and p.lancado_conciliacao then
      update public.pagamentos set status = 'cancelado', cancelamento_motivo = 'Conciliação desfeita: ' || trim(p_motivo) where id = p.id;
    elsif p_voltar_aberto and ci.baixou then
      if ci.parcela_id is not null then
        perform public.estornar_baixa_parcela(ci.parcela_id, 'Conciliação desfeita: ' || trim(p_motivo));
      else
        perform public.estornar_baixa(ci.pagamento_id, 'Conciliação desfeita: ' || trim(p_motivo));
      end if;
    end if;
    perform public._auditar('pagamento', p.id::text, 'desconciliou',
      'Conciliação com o extrato de ' || to_char(l.data, 'DD/MM/YYYY') || ' desfeita'
        || case
             when p_voltar_aberto and p.lancado_conciliacao then ' e o lançamento criado pela conciliação foi cancelado'
             when p_voltar_aberto and ci.baixou then ' e baixa estornada'
             else ' (continua paga)'
           end || '. Motivo: ' || trim(p_motivo),
      p.obra_id, p.id);
  end loop;
  update public.extrato_linhas set situacao = 'pendente', tratado_por = null, tratado_em = null, encargos = null where id = l.id;
end
$$;

-- Categorias de despesa e de receita com o mesmo nome convivem; despesa só usa categoria de despesa.
create or replace function public.criar_categoria(p_nome text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_nome text := trim(coalesce(p_nome, ''));
begin
  if public.meu_perfil() not in ('financeiro', 'administrador_master') then
    raise exception 'Somente o Financeiro cadastra categorias.' using errcode = '42501';
  end if;
  if v_nome = '' then
    raise exception 'Informe o nome da categoria.';
  end if;
  if length(v_nome) > 120 then
    raise exception 'O nome da categoria deve ter até 120 caracteres.';
  end if;
  select id into v_id from public.categorias where tipo = 'despesa' and lower(trim(nome)) = lower(v_nome);
  if found then
    update public.categorias set ativo = true where id = v_id;
    return v_id;
  end if;
  insert into public.categorias (nome) values (v_nome) returning id into v_id;
  return v_id;
end
$$;

create or replace function public.atualizar_categoria(p_id uuid, p_nome text, p_ativo boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_nome text := trim(coalesce(p_nome, ''));
  v_tipo text;
begin
  if public.meu_perfil() not in ('financeiro', 'administrador_master') then
    raise exception 'Somente o Financeiro altera categorias.' using errcode = '42501';
  end if;
  if v_nome = '' then
    raise exception 'Informe o nome da categoria.';
  end if;
  select tipo into v_tipo from public.categorias where id = p_id;
  if not found then
    raise exception 'Categoria não encontrada.';
  end if;
  if exists (select 1 from public.categorias where tipo = v_tipo and lower(trim(nome)) = lower(v_nome) and id <> p_id) then
    raise exception 'Já existe uma categoria com esse nome.';
  end if;
  update public.categorias set nome = v_nome, ativo = coalesce(p_ativo, ativo) where id = p_id;
end
$$;

create or replace function public._categoria_de_despesa()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.categoria_id is not null and exists (select 1 from public.categorias where id = new.categoria_id and tipo <> 'despesa') then
    raise exception 'Categoria de receita não pode ser usada em despesa.';
  end if;
  return new;
end
$$;
drop trigger if exists pagamentos_categoria_despesa on public.pagamentos;
create trigger pagamentos_categoria_despesa before insert or update of categoria_id on public.pagamentos
  for each row execute function public._categoria_de_despesa();
drop trigger if exists ordens_categoria_despesa on public.ordens_pagamento;
create trigger ordens_categoria_despesa before insert or update of categoria_id on public.ordens_pagamento
  for each row execute function public._categoria_de_despesa();
drop trigger if exists provisoes_categoria_despesa on public.provisoes;
create trigger provisoes_categoria_despesa before insert or update of categoria_id on public.provisoes
  for each row execute function public._categoria_de_despesa();

-- O administrador master também mexe em contas a receber: precisa ver as notas de medição para anexar.
create policy notas_medicao_select_master on public.notas_medicao for select to authenticated
  using (public.meu_perfil() = 'administrador_master');
