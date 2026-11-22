-- Conciliação bancária: contas bancárias, extratos importados (OFX), conciliação das linhas do banco com as contas a pagar.
-- Só o Financeiro importa e concilia; o Administrador master visualiza. Conciliar uma conta liberada já registra a baixa
-- (data e valor do banco). Linhas que não são contas a pagar (tarifas, aplicações, entradas…) são classificadas e arquivadas.

create table public.contas_bancarias (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) > 0),
  banco text not null,            -- código com 3 dígitos (001 = Banco do Brasil, 104 = Caixa)
  agencia text not null default '', -- sem zeros à esquerda; vazio quando o banco não informa no extrato (BB)
  conta text not null,            -- só dígitos e X, sem zeros à esquerda
  ativa boolean not null default true,
  saldo numeric(14, 2),           -- saldo informado no último extrato importado
  saldo_em date,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (banco, agencia, conta)
);

create table public.extrato_importacoes (
  id uuid primary key default gen_random_uuid(),
  conta_id uuid not null references public.contas_bancarias (id),
  arquivo text not null,
  periodo_inicio date,
  periodo_fim date,
  saldo numeric(14, 2),
  saldo_em date,
  linhas_novas int not null default 0,
  linhas_repetidas int not null default 0,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);

create table public.extrato_linhas (
  id uuid primary key default gen_random_uuid(),
  conta_id uuid not null references public.contas_bancarias (id),
  importacao_id uuid not null references public.extrato_importacoes (id),
  data date not null,
  valor numeric(14, 2) not null check (valor <> 0), -- negativo = saída; positivo = entrada
  tipo text not null default '',
  descricao text not null default '',
  fitid text not null default '',
  documento text not null default '',
  situacao text not null default 'pendente' check (situacao in ('pendente', 'conciliada', 'arquivada')),
  classificacao text check (classificacao in ('tarifa', 'aplicacao', 'entrada', 'transferencia', 'cartao', 'imposto', 'emprestimo', 'outro')),
  observacao text,
  encargos numeric(14, 2), -- uma saída para várias contas (ex.: fatura do cartão): o que o banco pagou a mais que a soma
  tratado_por uuid references public.profiles (id),
  tratado_em timestamptz,
  created_at timestamptz not null default now()
);
create index extrato_linhas_conta_idx on public.extrato_linhas (conta_id, situacao, data);
create index extrato_linhas_chave_idx on public.extrato_linhas (conta_id, data, valor, fitid);

create table public.conciliacao_itens (
  id uuid primary key default gen_random_uuid(),
  linha_id uuid not null references public.extrato_linhas (id) on delete cascade,
  pagamento_id uuid not null references public.pagamentos (id),
  parcela_id uuid references public.pagamento_parcelas (id),
  valor numeric(14, 2) not null,
  baixou boolean not null default false, -- a baixa foi feita pela conciliação (desfazer pode voltar para em aberto)
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now()
);
create index conciliacao_itens_linha_idx on public.conciliacao_itens (linha_id);
-- Uma conta (ou parcela) só pode estar conciliada com uma linha do banco
create unique index conciliacao_itens_pagamento_unico on public.conciliacao_itens (pagamento_id) where parcela_id is null;
create unique index conciliacao_itens_parcela_unica on public.conciliacao_itens (parcela_id) where parcela_id is not null;

alter table public.contas_bancarias enable row level security;
alter table public.extrato_importacoes enable row level security;
alter table public.extrato_linhas enable row level security;
alter table public.conciliacao_itens enable row level security;
-- Leitura: extratos e conciliação só Financeiro e master. As contas bancárias (nome, banco, agência, conta) todos veem,
-- para escolher de qual conta sai cada despesa; o saldo fica só para Financeiro/master (função saldos_contas_bancarias).
-- Escrita só pelas funções abaixo.
create policy contas_bancarias_ler on public.contas_bancarias for select to authenticated using (true);
create policy extrato_importacoes_ler on public.extrato_importacoes for select to authenticated using (public.pode_baixar());
create policy extrato_linhas_ler on public.extrato_linhas for select to authenticated using (public.pode_baixar());
create policy conciliacao_itens_ler on public.conciliacao_itens for select to authenticated using (public.pode_baixar());
grant select on public.extrato_importacoes, public.extrato_linhas, public.conciliacao_itens to authenticated;
revoke all on public.contas_bancarias from anon, authenticated;
grant select (id, nome, banco, agencia, conta, ativa, created_at) on public.contas_bancarias to authenticated;

create or replace function public.saldos_contas_bancarias()
returns table (id uuid, saldo numeric, saldo_em date)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.saldo, c.saldo_em from public.contas_bancarias c where public.pode_baixar()
$$;
revoke all on function public.saldos_contas_bancarias() from public, anon;
grant execute on function public.saldos_contas_bancarias() to authenticated;

-- De qual conta bancária sai cada despesa (informada ao criar; o Financeiro pode trocar se foi paga por outra)
alter table public.pagamentos add column if not exists conta_bancaria_id uuid references public.contas_bancarias (id);
alter table public.ordens_pagamento add column if not exists conta_bancaria_id uuid references public.contas_bancarias (id);
create index if not exists pagamentos_conta_bancaria_idx on public.pagamentos (conta_bancaria_id);

-- O pagamento criado a partir de uma OP herda competência, categoria e conta bancária da OP.
create or replace function public._competencia_da_op()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.ordem_id is not null then
    select o.data_competencia, coalesce(new.categoria_id, o.categoria_id), coalesce(new.conta_bancaria_id, o.conta_bancaria_id)
      into new.data_competencia, new.categoria_id, new.conta_bancaria_id
      from public.ordens_pagamento o where o.id = new.ordem_id;
  end if;
  if new.data_competencia is null then
    new.data_competencia := (now() at time zone 'America/Sao_Paulo')::date;
  end if;
  return new;
end
$$;

create or replace function public._exigir_financeiro_conciliacao()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro importa extratos e faz a conciliação bancária.' using errcode = '42501';
  end if;
end
$$;
revoke all on function public._exigir_financeiro_conciliacao() from public, anon, authenticated;

-- Importa as linhas de um extrato. A conta é encontrada pelo banco/agência/conta do arquivo (ou criada).
-- Não duplica ao importar de novo um período que se sobrepõe: linhas iguais (data, valor, código e descrição)
-- só entram na quantidade que ainda falta (a Caixa repete códigos e até linhas idênticas legítimas).
create or replace function public.importar_extrato(
  p_banco text, p_agencia text, p_conta text, p_arquivo text,
  p_inicio date, p_fim date, p_saldo numeric, p_saldo_em date, p_linhas jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_banco text := right(lpad(regexp_replace(coalesce(p_banco, ''), '\D', '', 'g'), 3, '0'), 3);
  v_agencia text := regexp_replace(regexp_replace(upper(coalesce(p_agencia, '')), '[^0-9X]', '', 'g'), '^0+', '');
  v_conta text := regexp_replace(regexp_replace(upper(coalesce(p_conta, '')), '[^0-9X]', '', 'g'), '^0+', '');
  v_conta_id uuid;
  v_imp uuid;
  v_novas int := 0;
  v_total int := 0;
  g record;
  v_existentes int;
begin
  perform public._exigir_financeiro_conciliacao();
  if v_banco = '000' or v_conta = '' then
    raise exception 'O arquivo não informa o banco e a conta.';
  end if;
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'Arquivo sem lançamentos.';
  end if;
  if jsonb_array_length(p_linhas) > 5000 then
    raise exception 'Extrato grande demais (máximo de 5.000 lançamentos por arquivo).';
  end if;

  select id into v_conta_id from public.contas_bancarias where banco = v_banco and agencia = v_agencia and conta = v_conta;
  -- Conta cadastrada à mão: o BB não informa a agência no extrato; ou a conta foi cadastrada sem agência
  if v_conta_id is null and v_agencia = '' then
    select min(id::text)::uuid into v_conta_id from public.contas_bancarias where banco = v_banco and conta = v_conta
     having count(*) = 1;
  end if;
  if v_conta_id is null and v_agencia <> '' then
    select min(id::text)::uuid into v_conta_id from public.contas_bancarias where banco = v_banco and conta = v_conta and agencia = ''
     having count(*) = 1;
    if v_conta_id is not null then
      update public.contas_bancarias set agencia = v_agencia where id = v_conta_id;
    end if;
  end if;
  if v_conta_id is null then
    insert into public.contas_bancarias (nome, banco, agencia, conta, created_by)
    values (
      case v_banco when '001' then 'Banco do Brasil' when '104' then 'Caixa' else 'Banco ' || v_banco end
        || case when v_agencia <> '' then ' · Ag. ' || v_agencia else '' end || ' · C/C ' || v_conta,
      v_banco, v_agencia, v_conta, auth.uid())
    returning id into v_conta_id;
  end if;

  insert into public.extrato_importacoes (conta_id, arquivo, periodo_inicio, periodo_fim, saldo, saldo_em, created_by)
  values (v_conta_id, left(coalesce(nullif(trim(p_arquivo), ''), 'extrato.ofx'), 200), p_inicio, p_fim, p_saldo, p_saldo_em, auth.uid())
  returning id into v_imp;

  for g in
    select (l ->> 'data')::date as data, round((l ->> 'valor')::numeric, 2) as valor,
           coalesce(l ->> 'tipo', '') as tipo, left(coalesce(l ->> 'descricao', ''), 300) as descricao,
           left(coalesce(l ->> 'fitid', ''), 100) as fitid, left(coalesce(l ->> 'documento', ''), 100) as documento,
           count(*) as qtd
      from jsonb_array_elements(p_linhas) l
     where (l ->> 'data') is not null and coalesce((l ->> 'valor')::numeric, 0) <> 0
     group by 1, 2, 3, 4, 5, 6
  loop
    v_total := v_total + g.qtd;
    select count(*) into v_existentes from public.extrato_linhas
     where conta_id = v_conta_id and data = g.data and valor = g.valor and fitid = g.fitid and descricao = g.descricao;
    if g.qtd > v_existentes then
      insert into public.extrato_linhas (conta_id, importacao_id, data, valor, tipo, descricao, fitid, documento)
      select v_conta_id, v_imp, g.data, g.valor, g.tipo, g.descricao, g.fitid, g.documento from generate_series(1, g.qtd - v_existentes);
      v_novas := v_novas + (g.qtd - v_existentes);
    end if;
  end loop;

  update public.extrato_importacoes set linhas_novas = v_novas, linhas_repetidas = v_total - v_novas where id = v_imp;
  -- Saldo da conta: o do extrato mais recente
  if p_saldo is not null and p_saldo_em is not null then
    update public.contas_bancarias set saldo = p_saldo, saldo_em = p_saldo_em
     where id = v_conta_id and (saldo_em is null or saldo_em <= p_saldo_em);
  end if;
  perform public._auditar('conta_bancaria', v_conta_id::text, 'importou',
    'Extrato importado (' || coalesce(p_arquivo, 'OFX') || '): ' || v_novas || ' lançamento(s) novo(s), ' || (v_total - v_novas) || ' já existente(s)');
  return jsonb_build_object('conta_id', v_conta_id, 'importacao_id', v_imp, 'novas', v_novas, 'repetidas', v_total - v_novas);
end
$$;
revoke all on function public.importar_extrato(text, text, text, text, date, date, numeric, date, jsonb) from public, anon;
grant execute on function public.importar_extrato(text, text, text, text, date, date, numeric, date, jsonb) to authenticated;

-- Concilia uma saída do banco com uma ou mais contas a pagar (ou parcelas).
-- Itens: [{"tipo": "pagamento"|"parcela", "id": "<uuid>"}]
-- · Conta liberada ainda em aberto: a conciliação registra a baixa com a data e o valor do banco.
-- · Conta já paga (baixa feita antes, com comprovante): só liga, se o valor pago for o mesmo.
-- · Vários itens (ex.: fatura do cartão com várias compras): a soma tem de ser o valor do banco; se o banco pagou
--   mais, p_diferenca 'encargos' (juros, IOF, anuidade, tarifa) registra a diferença na conciliação.
-- · Um item em aberto com valor diferente: banco maior = p_diferenca 'juros' (juros/multa: paga o valor do banco);
--   banco menor = p_diferenca 'desconto' (quita) ou 'saldo' (pagamento parcial, o resto fica em aberto).
create or replace function public.conciliar_linha(p_linha_id uuid, p_itens jsonb, p_diferenca text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  v_conta text;
  v_banco numeric(14, 2);
  v_total numeric(14, 2) := 0;
  v_qtd int;
  it jsonb;
  p public.pagamentos;
  pc public.pagamento_parcelas;
  v_valor numeric(14, 2);
  v_aberto boolean;
  v_itens jsonb := '[]'::jsonb;
  x jsonb;
  v_parcela uuid;
begin
  perform public._exigir_financeiro_conciliacao();
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found then
    raise exception 'Lançamento do banco não encontrado.';
  end if;
  if l.situacao <> 'pendente' then
    raise exception 'Este lançamento do banco já foi conciliado ou arquivado.';
  end if;
  if l.valor > 0 then
    raise exception 'Entradas no banco não são contas a pagar: arquive como "Entrada recebida".';
  end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Escolha a conta a pagar para conciliar.';
  end if;
  v_qtd := jsonb_array_length(p_itens);
  v_banco := -l.valor;
  select nome into v_conta from public.contas_bancarias where id = l.conta_id;

  -- 1) Confere cada item e soma
  for it in select * from jsonb_array_elements(p_itens) loop
    if it ->> 'tipo' = 'parcela' then
      select * into pc from public.pagamento_parcelas where id = (it ->> 'id')::uuid for update;
      if not found then raise exception 'Parcela não encontrada.'; end if;
      select * into p from public.pagamentos where id = pc.pagamento_id for update;
      if exists (select 1 from public.conciliacao_itens where parcela_id = pc.id) then
        raise exception 'A parcela % do nº % já está conciliada com outro lançamento do banco.', pc.numero, p.numero;
      end if;
      if pc.status = 'pago' then
        v_valor := pc.valor_pago; v_aberto := false;
      elsif p.status = 'aguardando_pagamento' then
        v_valor := round(pc.valor_base + pc.multa + pc.juros - pc.desconto, 2); v_aberto := true;
      else
        raise exception 'O nº % ainda não está liberado para pagamento (está em aprovação ou cancelado).', p.numero;
      end if;
      v_itens := v_itens || jsonb_build_object('pagamento', p.id, 'parcela', pc.id, 'valor', v_valor, 'aberto', v_aberto, 'numero', p.numero);
    else
      select * into p from public.pagamentos where id = (it ->> 'id')::uuid for update;
      if not found then raise exception 'Conta a pagar não encontrada.'; end if;
      if exists (select 1 from public.pagamento_parcelas where pagamento_id = p.id) then
        raise exception 'O nº % é parcelado: escolha a parcela.', p.numero;
      end if;
      if exists (select 1 from public.conciliacao_itens where pagamento_id = p.id and parcela_id is null) then
        raise exception 'O nº % já está conciliado com outro lançamento do banco.', p.numero;
      end if;
      if p.status = 'pago' then
        v_valor := p.valor_pago; v_aberto := false;
      elsif p.status = 'aguardando_pagamento' then
        v_valor := p.valor; v_aberto := true;
      else
        raise exception 'O nº % ainda não está liberado para pagamento (está em aprovação, rejeitado ou cancelado).', p.numero;
      end if;
      v_itens := v_itens || jsonb_build_object('pagamento', p.id, 'parcela', null, 'valor', v_valor, 'aberto', v_aberto, 'numero', p.numero);
    end if;
    v_total := v_total + v_valor;
  end loop;

  if v_qtd > 1 and v_total > v_banco then
    raise exception 'A soma das contas (R$ %) é maior que o valor do banco (R$ %).', public._brl(v_total), public._brl(v_banco);
  end if;
  if v_qtd > 1 and v_total < v_banco and coalesce(p_diferenca, '') <> 'encargos' then
    raise exception 'O banco pagou R$ % a mais que a soma das contas: confirme que são encargos (juros, IOF, anuidade, tarifa).', public._brl(v_banco - v_total);
  end if;
  if v_qtd = 1 and v_total <> v_banco then
    x := v_itens -> 0;
    if not (x ->> 'aberto')::boolean then
      raise exception 'O nº % foi baixado com R$ %, diferente do banco (R$ %). Corrija a baixa ou escolha outra conta.',
        x ->> 'numero', public._brl(v_total), public._brl(v_banco);
    end if;
    if v_banco > v_total and coalesce(p_diferenca, '') <> 'juros' then
      raise exception 'O banco pagou R$ % a mais: confirme que a diferença é juros/multa.', public._brl(v_banco - v_total);
    end if;
    if v_banco < v_total and coalesce(p_diferenca, '') not in ('desconto', 'saldo') then
      raise exception 'O banco pagou R$ % a menos: informe se foi desconto ou pagamento parcial.', public._brl(v_total - v_banco);
    end if;
    if v_banco < v_total and p_diferenca = 'saldo' and (x ->> 'parcela') is not null then
      raise exception 'Pagamento parcial de parcela não é permitido: ajuste o valor da parcela antes.';
    end if;
  end if;

  -- 2) Baixa das que estão em aberto e vínculo
  for x in select * from jsonb_array_elements(v_itens) loop
    v_parcela := nullif(x ->> 'parcela', '')::uuid;
    if (x ->> 'aberto')::boolean then
      v_valor := case when v_qtd = 1 then v_banco else (x ->> 'valor')::numeric end;
      if v_parcela is not null then
        perform public.registrar_baixa_parcela(v_parcela, l.data, v_valor, 'Conciliado com o extrato ' || v_conta);
      else
        perform public.registrar_baixa((x ->> 'pagamento')::uuid, l.data, v_valor, 'Conciliado com o extrato ' || v_conta,
          case when v_valor < (x ->> 'valor')::numeric then p_diferenca else 'saldo' end);
        -- Pagamento parcial vira parcela 1 (paga) + parcela 2 (em aberto): a conciliação fica na parcela paga
        if v_valor < (x ->> 'valor')::numeric and p_diferenca = 'saldo' then
          select id into v_parcela from public.pagamento_parcelas where pagamento_id = (x ->> 'pagamento')::uuid and numero = 1;
        end if;
      end if;
    end if;
    insert into public.conciliacao_itens (linha_id, pagamento_id, parcela_id, valor, baixou, created_by)
    values (l.id, (x ->> 'pagamento')::uuid, v_parcela,
            case when v_qtd = 1 then v_banco else (x ->> 'valor')::numeric end, (x ->> 'aberto')::boolean, auth.uid());
    select * into p from public.pagamentos where id = (x ->> 'pagamento')::uuid;
    -- Saiu desta conta (o extrato prova): a despesa passa a apontar para ela
    if p.conta_bancaria_id is distinct from l.conta_id then
      update public.pagamentos set conta_bancaria_id = l.conta_id where id = p.id;
      perform public._auditar('pagamento', p.id::text, 'alterou',
        'Conta bancária ajustada pela conciliação para ' || v_conta, p.obra_id, p.id,
        jsonb_build_object('conta_bancaria', (select nome from public.contas_bancarias where id = p.conta_bancaria_id)),
        jsonb_build_object('conta_bancaria', v_conta));
    end if;
    perform public._auditar('pagamento', p.id::text, 'conciliou',
      'Conciliado com o extrato ' || v_conta || ' de ' || to_char(l.data, 'DD/MM/YYYY') || ' (R$ ' || public._brl(v_banco) || ')'
        || case when (x ->> 'aberto')::boolean then ' — baixa registrada pela conciliação' else '' end,
      p.obra_id, p.id);
  end loop;

  update public.extrato_linhas
     set situacao = 'conciliada', tratado_por = auth.uid(), tratado_em = now(),
         encargos = case when v_qtd > 1 and v_banco > v_total then v_banco - v_total end
   where id = l.id;
end
$$;
revoke all on function public.conciliar_linha(uuid, jsonb, text) from public, anon;
grant execute on function public.conciliar_linha(uuid, jsonb, text) to authenticated;

-- Desfaz uma conciliação. p_voltar_aberto = true estorna as baixas feitas pela conciliação (voltam a ficar a pagar);
-- false só desliga (as contas continuam pagas). A linha do banco volta para as pendentes.
create or replace function public.desfazer_conciliacao(p_linha_id uuid, p_voltar_aberto boolean, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  ci public.conciliacao_itens;
  p public.pagamentos;
begin
  perform public._exigir_financeiro_conciliacao();
  if length(trim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'Informe o motivo.';
  end if;
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found or l.situacao <> 'conciliada' then
    raise exception 'Este lançamento do banco não está conciliado.';
  end if;
  for ci in select * from public.conciliacao_itens where linha_id = l.id loop
    delete from public.conciliacao_itens where id = ci.id; -- antes do estorno, para o gatilho não repetir o trabalho
    if p_voltar_aberto and ci.baixou then
      if ci.parcela_id is not null then
        perform public.estornar_baixa_parcela(ci.parcela_id, 'Conciliação desfeita: ' || trim(p_motivo));
      else
        perform public.estornar_baixa(ci.pagamento_id, 'Conciliação desfeita: ' || trim(p_motivo));
      end if;
    end if;
    select * into p from public.pagamentos where id = ci.pagamento_id;
    perform public._auditar('pagamento', p.id::text, 'desconciliou',
      'Conciliação com o extrato de ' || to_char(l.data, 'DD/MM/YYYY') || ' desfeita'
        || case when p_voltar_aberto and ci.baixou then ' e baixa estornada' else ' (continua paga)' end || '. Motivo: ' || trim(p_motivo),
      p.obra_id, p.id);
  end loop;
  update public.extrato_linhas set situacao = 'pendente', tratado_por = null, tratado_em = null, encargos = null where id = l.id;
end
$$;
revoke all on function public.desfazer_conciliacao(uuid, boolean, text) from public, anon;
grant execute on function public.desfazer_conciliacao(uuid, boolean, text) to authenticated;

-- Se a baixa de uma conta conciliada for estornada por outro caminho (Ações → Voltar para em aberto),
-- a conciliação deixa de valer e a linha do banco volta para as pendentes.
create or replace function public._conciliacao_ao_estornar()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_linhas uuid[];
begin
  if old.status = 'pago' and new.status <> 'pago' then
    if tg_table_name = 'pagamento_parcelas' then
      with d as (delete from public.conciliacao_itens where parcela_id = new.id returning linha_id) select array_agg(linha_id) into v_linhas from d;
    else
      with d as (delete from public.conciliacao_itens where pagamento_id = new.id and parcela_id is null returning linha_id) select array_agg(linha_id) into v_linhas from d;
    end if;
    if v_linhas is not null then
      update public.extrato_linhas e set situacao = 'pendente', tratado_por = null, tratado_em = null, encargos = null
       where e.id = any (v_linhas) and not exists (select 1 from public.conciliacao_itens c where c.linha_id = e.id);
    end if;
  end if;
  return new;
end
$$;
create trigger conciliacao_ao_estornar_pagamento after update of status on public.pagamentos
  for each row execute function public._conciliacao_ao_estornar();
create trigger conciliacao_ao_estornar_parcela after update of status on public.pagamento_parcelas
  for each row execute function public._conciliacao_ao_estornar();

-- Arquiva linhas do banco que não são contas a pagar, com a classificação (tarifa, aplicação, entrada…).
create or replace function public.arquivar_linhas(p_ids uuid[], p_classificacao text, p_observacao text default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v int;
begin
  perform public._exigir_financeiro_conciliacao();
  if p_classificacao is null or p_classificacao not in ('tarifa', 'aplicacao', 'entrada', 'transferencia', 'cartao', 'imposto', 'emprestimo', 'outro') then
    raise exception 'Escolha a classificação.';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception 'Escolha os lançamentos.';
  end if;
  update public.extrato_linhas
     set situacao = 'arquivada', classificacao = p_classificacao, observacao = nullif(trim(coalesce(p_observacao, '')), ''),
         tratado_por = auth.uid(), tratado_em = now()
   where id = any (p_ids) and situacao = 'pendente';
  get diagnostics v = row_count;
  return v;
end
$$;
revoke all on function public.arquivar_linhas(uuid[], text, text) from public, anon;
grant execute on function public.arquivar_linhas(uuid[], text, text) to authenticated;

create or replace function public.restaurar_linha(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform public._exigir_financeiro_conciliacao();
  update public.extrato_linhas set situacao = 'pendente', classificacao = null, observacao = null, tratado_por = null, tratado_em = null
   where id = p_id and situacao = 'arquivada';
  if not found then
    raise exception 'Este lançamento não está arquivado.';
  end if;
end
$$;
revoke all on function public.restaurar_linha(uuid) from public, anon;
grant execute on function public.restaurar_linha(uuid) to authenticated;

create or replace function public.renomear_conta_bancaria(p_id uuid, p_nome text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform public._exigir_financeiro_conciliacao();
  if length(trim(coalesce(p_nome, ''))) = 0 then
    raise exception 'Informe o nome da conta.';
  end if;
  update public.contas_bancarias set nome = left(trim(p_nome), 80) where id = p_id;
  if not found then
    raise exception 'Conta não encontrada.';
  end if;
end
$$;
revoke all on function public.renomear_conta_bancaria(uuid, text) from public, anon;
grant execute on function public.renomear_conta_bancaria(uuid, text) to authenticated;

-- Cadastra uma conta bancária à mão (o extrato importado depois é reconhecido por banco/agência/conta).
create or replace function public.criar_conta_bancaria(p_nome text, p_banco text, p_agencia text, p_conta text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_banco text := right(lpad(regexp_replace(coalesce(p_banco, ''), '\D', '', 'g'), 3, '0'), 3);
  v_agencia text := regexp_replace(regexp_replace(upper(coalesce(p_agencia, '')), '[^0-9X]', '', 'g'), '^0+', '');
  v_conta text := regexp_replace(regexp_replace(upper(coalesce(p_conta, '')), '[^0-9X]', '', 'g'), '^0+', '');
  v_id uuid;
begin
  perform public._exigir_financeiro_conciliacao();
  if length(trim(coalesce(p_nome, ''))) = 0 then raise exception 'Informe o nome da conta (ex.: Caixa Matriz).'; end if;
  if v_banco = '000' then raise exception 'Informe o banco.'; end if;
  if v_conta = '' then raise exception 'Informe o número da conta.'; end if;
  if exists (select 1 from public.contas_bancarias where banco = v_banco and agencia = v_agencia and conta = v_conta) then
    raise exception 'Esta conta bancária já está cadastrada.';
  end if;
  insert into public.contas_bancarias (nome, banco, agencia, conta, created_by)
  values (left(trim(p_nome), 80), v_banco, v_agencia, v_conta, auth.uid()) returning id into v_id;
  perform public._auditar('conta_bancaria', v_id::text, 'criou', 'Conta bancária cadastrada: ' || trim(p_nome));
  return v_id;
end
$$;
revoke all on function public.criar_conta_bancaria(text, text, text, text) from public, anon;
grant execute on function public.criar_conta_bancaria(text, text, text, text) to authenticated;

-- Define/troca a conta bancária da despesa. Financeiro: a qualquer momento (ex.: foi paga por outra conta);
-- quem cadastrou ou atua na obra: enquanto não estiver paga.
create or replace function public.definir_conta_bancaria(p_pagamento_id uuid, p_conta_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_antes text;
  v_depois text;
begin
  select * into p from public.pagamentos where id = p_pagamento_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  if p.conta_bancaria_id is not distinct from p_conta_id then
    return; -- nada muda (ex.: salvar a edição sem trocar a conta)
  end if;
  if p.status = 'cancelado' then
    raise exception 'Pagamento cancelado.';
  end if;
  if not public.is_financeiro() then
    if not (public.pode_atuar_obra(p.obra_id) or p.created_by = auth.uid()) then
      raise exception 'Sem permissão para alterar este pagamento.' using errcode = '42501';
    end if;
    if p.status = 'pago' then
      raise exception 'Pagamento já pago: só o Financeiro troca a conta bancária.';
    end if;
  end if;
  if p_conta_id is null or not exists (select 1 from public.contas_bancarias where id = p_conta_id and ativa) then
    raise exception 'Escolha a conta bancária.';
  end if;
  select nome into v_antes from public.contas_bancarias where id = p.conta_bancaria_id;
  select nome into v_depois from public.contas_bancarias where id = p_conta_id;
  update public.pagamentos set conta_bancaria_id = p_conta_id where id = p.id;
  if p.conta_bancaria_id is not null then
    perform public._auditar('pagamento', p.id::text, 'alterou', 'Conta bancária alterada de ' || v_antes || ' para ' || v_depois,
      p.obra_id, p.id, jsonb_build_object('conta_bancaria', v_antes), jsonb_build_object('conta_bancaria', v_depois));
  end if;
end
$$;
revoke all on function public.definir_conta_bancaria(uuid, uuid) from public, anon;
grant execute on function public.definir_conta_bancaria(uuid, uuid) to authenticated;

-- Conta bancária da OP em rascunho (só quem solicitou); vai para o pagamento quando a OP é enviada.
create or replace function public.definir_conta_bancaria_op(p_ordem_id uuid, p_conta_id uuid)
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
  if o.status <> 'em_elaboracao' then
    raise exception 'Esta solicitação já foi enviada.';
  end if;
  if p_conta_id is not null and not exists (select 1 from public.contas_bancarias where id = p_conta_id and ativa) then
    raise exception 'Conta bancária inválida.';
  end if;
  update public.ordens_pagamento set conta_bancaria_id = p_conta_id where id = o.id;
end
$$;
revoke all on function public.definir_conta_bancaria_op(uuid, uuid) from public, anon;
grant execute on function public.definir_conta_bancaria_op(uuid, uuid) to authenticated;
