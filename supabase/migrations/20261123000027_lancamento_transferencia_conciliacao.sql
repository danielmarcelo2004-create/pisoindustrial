-- Conciliação: "Novo lançamento" e "Nova transferência" para movimentações do banco sem conta a pagar correspondente.
-- · Novo lançamento: cria a despesa já paga e conciliada (o dinheiro já saiu da conta), SEM fluxo de aprovação;
--   fica marcada como "Lançada pela conciliação" e o engenheiro/administrador do centro de custo recebe um aviso.
-- · Nova transferência: saída de uma conta da empresa para outra (ou a entrada vinda de outra). A movimentação
--   correspondente na outra conta aparece sugerida para conciliar com um clique. Transferência não é despesa.
-- Só o Financeiro faz.

alter table public.pagamentos add column if not exists lancado_conciliacao boolean not null default false;

create table public.transferencias (
  id uuid primary key default gen_random_uuid(),
  conta_origem uuid not null references public.contas_bancarias (id),
  conta_destino uuid not null references public.contas_bancarias (id),
  valor numeric(14, 2) not null check (valor > 0),
  data date not null,
  descricao text not null default '',
  linha_origem uuid references public.extrato_linhas (id) on delete set null,
  linha_destino uuid references public.extrato_linhas (id) on delete set null,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  check (conta_origem <> conta_destino)
);
alter table public.transferencias enable row level security;
create policy transferencias_ler on public.transferencias for select to authenticated using (public.pode_baixar());
grant select on public.transferencias to authenticated;

alter table public.extrato_linhas add column if not exists transferencia_id uuid references public.transferencias (id) on delete set null;

-- Novo lançamento a partir de uma saída do banco. Valor original + juros + multa − desconto = valor que saiu do banco.
create or replace function public.criar_lancamento_conciliacao(
  p_linha_id uuid, p_obra_id uuid, p_categoria_id uuid, p_descricao text,
  p_fornecedor_id uuid default null, p_favorecido text default null, p_competencia date default null,
  p_forma public.forma_pagamento default null, p_valor numeric default null,
  p_juros numeric default 0, p_multa numeric default 0, p_desconto numeric default 0, p_observacoes text default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  o public.obras;
  v_banco numeric(14, 2);
  v_valor numeric(14, 2);
  v_fav text;
  v_conta text;
  v_id uuid;
  v_num bigint;
  v_aprovador uuid;
begin
  perform public._exigir_financeiro_conciliacao();
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found then raise exception 'Lançamento do banco não encontrado.'; end if;
  if l.situacao <> 'pendente' then raise exception 'Este lançamento do banco já foi conciliado ou arquivado.'; end if;
  if l.valor > 0 then raise exception 'Entradas no banco não viram despesa: use Nova transferência ou arquive como Entrada recebida.'; end if;
  select * into o from public.obras where id = p_obra_id;
  if not found then raise exception 'Escolha o centro de custo.'; end if;
  if p_categoria_id is null or not exists (select 1 from public.categorias where id = p_categoria_id and ativo) then
    raise exception 'Escolha a categoria.';
  end if;
  if length(trim(coalesce(p_descricao, ''))) = 0 then raise exception 'Informe a descrição.'; end if;
  if coalesce(p_juros, 0) < 0 or coalesce(p_multa, 0) < 0 or coalesce(p_desconto, 0) < 0 then
    raise exception 'Juros, multa e desconto não podem ser negativos.';
  end if;
  v_banco := -l.valor;
  v_valor := round(coalesce(p_valor, v_banco - coalesce(p_juros, 0) - coalesce(p_multa, 0) + coalesce(p_desconto, 0)), 2);
  if v_valor <= 0 then raise exception 'O valor da despesa deve ser maior que zero.'; end if;
  if v_valor + coalesce(p_juros, 0) + coalesce(p_multa, 0) - coalesce(p_desconto, 0) <> v_banco then
    raise exception 'Valor (R$ %) + juros + multa − desconto precisa dar o valor que saiu do banco (R$ %).', public._brl(v_valor), public._brl(v_banco);
  end if;
  v_fav := coalesce(nullif(trim(p_favorecido), ''), (select nome from public.fornecedores where id = p_fornecedor_id), left(trim(p_descricao), 200));
  select nome into v_conta from public.contas_bancarias where id = l.conta_id;

  insert into public.pagamentos (
    obra_id, fornecedor_id, favorecido, descricao, valor, vencimento, forma_pagamento, observacoes, fluxo, status,
    pago_em, valor_pago, pago_por, created_by, data_competencia, categoria_id, conta_bancaria_id, lancado_conciliacao
  ) values (
    o.id, p_fornecedor_id, v_fav, left(trim(p_descricao), 500), v_valor, l.data, coalesce(p_forma, 'outro'),
    nullif(trim(concat_ws(E'\n',
      nullif(trim(coalesce(p_observacoes, '')), ''),
      case when coalesce(p_juros, 0) > 0 then 'Juros: R$ ' || public._brl(p_juros) end,
      case when coalesce(p_multa, 0) > 0 then 'Multa: R$ ' || public._brl(p_multa) end,
      case when coalesce(p_desconto, 0) > 0 then 'Desconto: R$ ' || public._brl(p_desconto) end)), ''),
    o.fluxo, 'pago', l.data, v_banco, auth.uid(), auth.uid(), coalesce(p_competencia, l.data), p_categoria_id, l.conta_id, true
  ) returning id, numero into v_id, v_num;

  insert into public.conciliacao_itens (linha_id, pagamento_id, parcela_id, valor, baixou, created_by)
  values (l.id, v_id, null, v_banco, false, auth.uid());
  update public.extrato_linhas set situacao = 'conciliada', tratado_por = auth.uid(), tratado_em = now() where id = l.id;

  perform public._auditar('pagamento', v_id::text, 'criou',
    'Lançado pela conciliação (extrato ' || v_conta || ' de ' || to_char(l.data, 'DD/MM/YYYY') || ', R$ ' || public._brl(v_banco) || '), sem fluxo de aprovação: o valor já tinha saído da conta',
    o.id, v_id);
  perform public._auditar('pagamento', v_id::text, 'conciliou',
    'Conciliado com o extrato ' || v_conta || ' de ' || to_char(l.data, 'DD/MM/YYYY') || ' (R$ ' || public._brl(v_banco) || ')', o.id, v_id);

  -- Aviso (só para saber) a quem aprova no centro de custo
  for v_aprovador in select distinct x from unnest(array[o.engenheiro_id, o.administrador_id]) x where x is not null and x <> auth.uid() loop
    perform public._notificar(v_aprovador, 'Despesa lançada pela conciliação',
      'Pagamento nº ' || v_num || ' — ' || v_fav || ': R$ ' || public._brl(v_banco) || ' saiu da conta ' || v_conta || ' em '
        || to_char(l.data, 'DD/MM/YYYY') || ' e foi lançado pelo Financeiro direto na conciliação (' || o.nome || ').',
      '/pagamentos/' || v_id, v_id);
  end loop;
  return v_id;
end
$$;
revoke all on function public.criar_lancamento_conciliacao(uuid, uuid, uuid, text, uuid, text, date, public.forma_pagamento, numeric, numeric, numeric, numeric, text) from public, anon;
grant execute on function public.criar_lancamento_conciliacao(uuid, uuid, uuid, text, uuid, text, date, public.forma_pagamento, numeric, numeric, numeric, numeric, text) to authenticated;

-- Nova transferência a partir de uma movimentação: saída → para p_outra_conta; entrada → vinda de p_outra_conta.
create or replace function public.criar_transferencia(p_linha_id uuid, p_outra_conta uuid, p_descricao text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  v_id uuid;
  v_origem uuid;
  v_destino uuid;
  v_nome text;
begin
  perform public._exigir_financeiro_conciliacao();
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found then raise exception 'Lançamento do banco não encontrado.'; end if;
  if l.situacao <> 'pendente' then raise exception 'Este lançamento do banco já foi conciliado ou arquivado.'; end if;
  if p_outra_conta is null or not exists (select 1 from public.contas_bancarias where id = p_outra_conta and ativa) then
    raise exception 'Escolha a outra conta da transferência.';
  end if;
  if p_outra_conta = l.conta_id then raise exception 'A transferência precisa ser para outra conta.'; end if;
  if l.valor < 0 then v_origem := l.conta_id; v_destino := p_outra_conta; else v_origem := p_outra_conta; v_destino := l.conta_id; end if;
  insert into public.transferencias (conta_origem, conta_destino, valor, data, descricao, linha_origem, linha_destino, created_by)
  values (v_origem, v_destino, abs(l.valor), l.data, left(coalesce(nullif(trim(p_descricao), ''), l.descricao), 300),
          case when l.valor < 0 then l.id end, case when l.valor > 0 then l.id end, auth.uid())
  returning id into v_id;
  update public.extrato_linhas set situacao = 'conciliada', transferencia_id = v_id, tratado_por = auth.uid(), tratado_em = now() where id = l.id;
  select nome into v_nome from public.contas_bancarias where id = p_outra_conta;
  perform public._auditar('conta_bancaria', l.conta_id::text, 'transferencia',
    'Transferência de R$ ' || public._brl(abs(l.valor)) || case when l.valor < 0 then ' para ' else ' vinda de ' end || v_nome || ' em ' || to_char(l.data, 'DD/MM/YYYY'));
  return v_id;
end
$$;
revoke all on function public.criar_transferencia(uuid, uuid, text) from public, anon;
grant execute on function public.criar_transferencia(uuid, uuid, text) to authenticated;

-- Liga a movimentação da outra conta à transferência já registrada (o "Encontramos: transferência de…").
create or replace function public.conciliar_transferencia(p_linha_id uuid, p_transferencia_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  t public.transferencias;
begin
  perform public._exigir_financeiro_conciliacao();
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found then raise exception 'Lançamento do banco não encontrado.'; end if;
  if l.situacao <> 'pendente' then raise exception 'Este lançamento do banco já foi conciliado ou arquivado.'; end if;
  select * into t from public.transferencias where id = p_transferencia_id for update;
  if not found then raise exception 'Transferência não encontrada.'; end if;
  if abs(l.valor) <> t.valor then raise exception 'O valor (R$ %) é diferente da transferência (R$ %).', public._brl(abs(l.valor)), public._brl(t.valor); end if;
  if l.valor > 0 then
    if l.conta_id <> t.conta_destino then raise exception 'Esta conta não é o destino da transferência.'; end if;
    if t.linha_destino is not null then raise exception 'A entrada desta transferência já foi conciliada.'; end if;
    update public.transferencias set linha_destino = l.id where id = t.id;
  else
    if l.conta_id <> t.conta_origem then raise exception 'Esta conta não é a origem da transferência.'; end if;
    if t.linha_origem is not null then raise exception 'A saída desta transferência já foi conciliada.'; end if;
    update public.transferencias set linha_origem = l.id where id = t.id;
  end if;
  update public.extrato_linhas set situacao = 'conciliada', transferencia_id = t.id, tratado_por = auth.uid(), tratado_em = now() where id = l.id;
end
$$;
revoke all on function public.conciliar_transferencia(uuid, uuid) from public, anon;
grant execute on function public.conciliar_transferencia(uuid, uuid) to authenticated;

-- Desfazer também cobre transferência e lançamento criado pela conciliação.
-- · Transferência: solta esta movimentação; se nenhuma das duas ficar ligada, a transferência é apagada.
-- · Lançamento criado pela conciliação + "voltar para em aberto": o lançamento é cancelado (não existia antes).
create or replace function public.desfazer_conciliacao(p_linha_id uuid, p_voltar_aberto boolean, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  ci public.conciliacao_itens;
  p public.pagamentos;
  t public.transferencias;
begin
  perform public._exigir_financeiro_conciliacao();
  if length(trim(coalesce(p_motivo, ''))) < 3 then
    raise exception 'Informe o motivo.';
  end if;
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found or l.situacao <> 'conciliada' then
    raise exception 'Este lançamento do banco não está conciliado.';
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
revoke all on function public.desfazer_conciliacao(uuid, boolean, text) from public, anon;
grant execute on function public.desfazer_conciliacao(uuid, boolean, text) to authenticated;
