-- Conciliação: conta de investimento (ex.: BB Rende Fácil) e estorno em pares.
--
-- Conta de investimento: não tem extrato próprio (o BB mostra a aplicação/resgate no extrato da conta corrente);
-- a aplicação é uma transferência Conta corrente → investimento e o resgate o inverso. O saldo aplicado sai das
-- transferências. Não precisa de agência/conta.
--
-- Estorno: a entrada que devolve uma saída anterior da mesma conta. Em vez de arquivar, as duas linhas são
-- conciliadas juntas (uma anula a outra). Se a saída já estava conciliada com uma conta paga, o pagamento
-- não aconteceu de verdade: a conciliação é desfeita, a conta a pagar volta para em aberto (ou o lançamento
-- criado pela conciliação é cancelado) e quem responde pelo centro de custo é avisado.

alter table public.contas_bancarias add column if not exists tipo text not null default 'corrente'
  check (tipo in ('corrente', 'investimento'));
alter table public.contas_bancarias drop constraint if exists contas_bancarias_banco_agencia_conta_key;
create unique index if not exists contas_bancarias_numero_unico on public.contas_bancarias (banco, agencia, conta) where tipo = 'corrente';
create unique index if not exists contas_bancarias_investimento_nome on public.contas_bancarias (lower(nome)) where tipo = 'investimento';
grant select (tipo) on public.contas_bancarias to authenticated;

alter table public.extrato_linhas add column if not exists estorno_linha uuid references public.extrato_linhas (id) on delete set null;

-- Saldo: conta corrente = último extrato; investimento = entradas − saídas pelas transferências.
create or replace function public.saldos_contas_bancarias()
returns table (id uuid, saldo numeric, saldo_em date)
language sql stable security definer set search_path = ''
as $$
  select c.id,
         case when c.tipo = 'investimento' then
           coalesce((select sum(case when t.conta_destino = c.id then t.valor else -t.valor end)
                       from public.transferencias t where c.id in (t.conta_origem, t.conta_destino)), 0)
         else c.saldo end,
         case when c.tipo = 'investimento' then
           (select max(t.data) from public.transferencias t where c.id in (t.conta_origem, t.conta_destino))
         else c.saldo_em end
    from public.contas_bancarias c
   where public.pode_baixar()
$$;

create or replace function public.criar_conta_investimento(p_nome text, p_banco text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_banco text := right('000' || regexp_replace(coalesce(p_banco, ''), '\D', '', 'g'), 3);
  v_id uuid;
begin
  perform public._exigir_financeiro_conciliacao();
  if length(trim(coalesce(p_nome, ''))) = 0 then raise exception 'Informe o nome da conta (ex.: BB Rende Fácil).'; end if;
  if exists (select 1 from public.contas_bancarias where tipo = 'investimento' and lower(nome) = lower(trim(p_nome))) then
    raise exception 'Já existe uma conta de investimento com este nome.';
  end if;
  insert into public.contas_bancarias (nome, banco, agencia, conta, tipo, created_by)
  values (left(trim(p_nome), 80), case when v_banco = '000' then '' else v_banco end, '', '', 'investimento', auth.uid())
  returning id into v_id;
  perform public._auditar('conta_bancaria', v_id::text, 'criou', 'Conta de investimento cadastrada: ' || trim(p_nome));
  return v_id;
end
$$;
revoke all on function public.criar_conta_investimento(text, text) from public, anon;
grant execute on function public.criar_conta_investimento(text, text) to authenticated;

-- Concilia a entrada (estorno) com a saída que ela devolve.
create or replace function public.conciliar_estorno(p_credito uuid, p_debito uuid, p_motivo text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  c public.extrato_linhas;
  d public.extrato_linhas;
  p public.pagamentos;
  o public.obras;
  v_aviso uuid;
  v_reabriu text := '';
begin
  perform public._exigir_financeiro_conciliacao();
  select * into c from public.extrato_linhas where id = p_credito for update;
  select * into d from public.extrato_linhas where id = p_debito for update;
  if c.id is null or d.id is null then raise exception 'Lançamento do banco não encontrado.'; end if;
  if c.valor <= 0 then raise exception 'O estorno precisa ser uma entrada.'; end if;
  if d.valor >= 0 then raise exception 'O estorno devolve uma saída.'; end if;
  if c.conta_id <> d.conta_id then raise exception 'O estorno precisa ser da mesma conta da saída.'; end if;
  if c.valor <> -d.valor then raise exception 'O valor do estorno (R$ %) é diferente da saída (R$ %).', public._brl(c.valor), public._brl(-d.valor); end if;
  if d.data > c.data then raise exception 'A saída estornada precisa ser anterior ao estorno.'; end if;
  if c.situacao <> 'pendente' then raise exception 'Este lançamento do banco já foi conciliado ou arquivado.'; end if;
  if d.situacao = 'arquivada' then raise exception 'A saída está arquivada: restaure-a antes.'; end if;
  if d.estorno_linha is not null then raise exception 'Esta saída já foi estornada.'; end if;
  if d.transferencia_id is not null then raise exception 'A saída é uma transferência: desfaça a transferência antes.'; end if;

  if d.situacao = 'conciliada' then
    -- O pagamento voltou: a conta não foi paga. Reabre (ou cancela o que a conciliação lançou) e avisa.
    for p in select pg.* from public.conciliacao_itens ci join public.pagamentos pg on pg.id = ci.pagamento_id where ci.linha_id = d.id loop
      select * into o from public.obras where id = p.obra_id;
      v_reabriu := v_reabriu || case when v_reabriu = '' then '' else ', ' end || 'nº ' || p.numero;
      for v_aviso in select distinct x from unnest(array[o.engenheiro_id, o.administrador_id]) x where x is not null and x <> auth.uid() loop
        perform public._notificar(v_aviso, 'Pagamento estornado pelo banco',
          'O pagamento de R$ ' || public._brl(-d.valor) || ' a ' || p.favorecido || ' (nº ' || p.numero || ') de '
            || to_char(d.data, 'DD/MM/YYYY') || ' voltou em ' || to_char(c.data, 'DD/MM/YYYY') || '. '
            || case when p.lancado_conciliacao then 'O lançamento criado pela conciliação foi cancelado.' else 'A conta voltou para em aberto.' end,
          '/pagamentos/' || p.id, p.id);
      end loop;
    end loop;
    -- Mesmo a conta baixada à mão antes de conciliar volta para em aberto: o dinheiro voltou.
    update public.conciliacao_itens set baixou = true where linha_id = d.id;
    perform public.desfazer_conciliacao(d.id, true, 'Estorno do banco em ' || to_char(c.data, 'DD/MM/YYYY')
      || coalesce(' — ' || nullif(trim(p_motivo), ''), ''));
  end if;

  update public.extrato_linhas set situacao = 'conciliada', estorno_linha = d.id, tratado_por = auth.uid(), tratado_em = now() where id = c.id;
  update public.extrato_linhas set situacao = 'conciliada', estorno_linha = c.id, tratado_por = auth.uid(), tratado_em = now() where id = d.id;
  perform public._auditar('conta_bancaria', c.conta_id::text, 'estorno',
    'Estorno de R$ ' || public._brl(c.valor) || ' em ' || to_char(c.data, 'DD/MM/YYYY') || ' conciliado com a saída de ' || to_char(d.data, 'DD/MM/YYYY')
      || case when v_reabriu <> '' then ' (conta ' || v_reabriu || ' reaberta)' else '' end);
end
$$;
revoke all on function public.conciliar_estorno(uuid, uuid, text) from public, anon;
grant execute on function public.conciliar_estorno(uuid, uuid, text) to authenticated;

-- Desfazer: também separa o par de estorno (as duas linhas voltam para pendente; a conta reaberta continua em aberto).
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
