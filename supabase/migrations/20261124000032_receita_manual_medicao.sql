-- Contas a receber manual e nota de medição com impostos.
-- • "+ Nova receita": recebimento em aberto (vencimento, valor), lançado à mão pelo Financeiro/master.
-- • Nota de medição › "Lançar receita e impostos": receita com o valor total da nota; despesa do imposto RETIDO
--   (total − líquido) a pagar na conta onde o dinheiro cai; despesa do imposto DEVIDO (alíquota × total − retido,
--   padrão 14%) já paga na conta "Baixa manual para imposto devido". Sem fluxo de aprovação; quem aprova é avisado.
-- • Conciliação: o crédito do banco (líquido) concilia com a receita − retido; um clique baixa as duas.

-- Conta sem extrato para baixas manuais (ex.: imposto devido)
alter table public.contas_bancarias drop constraint if exists contas_bancarias_tipo_check;
alter table public.contas_bancarias add constraint contas_bancarias_tipo_check check (tipo in ('corrente', 'investimento', 'manual'));
insert into public.contas_bancarias (nome, banco, agencia, conta, tipo, created_by)
select 'Baixa manual para imposto devido', '', '', '', 'manual', p.id
  from public.profiles p
 where p.perfil in ('financeiro', 'administrador_master')
   and not exists (select 1 from public.contas_bancarias where tipo = 'manual')
 order by p.perfil = 'financeiro' desc, p.created_at
 limit 1;

-- Despesas ligadas à receita (imposto retido/devido da medição)
alter table public.pagamentos add column if not exists recebimento_id uuid references public.recebimentos (id);
alter table public.pagamentos add column if not exists imposto_medicao text check (imposto_medicao in ('retido', 'devido'));
create index if not exists pagamentos_recebimento_idx on public.pagamentos (recebimento_id) where recebimento_id is not null;

create or replace function public._validar_receita(p_obra_id uuid, p_categoria_id uuid, p_cliente text, p_descricao text, p_valor numeric, p_vencimento date)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform public._exigir_mexer_receber();
  if p_obra_id is null or not exists (select 1 from public.obras where id = p_obra_id) then raise exception 'Escolha o centro de custo.'; end if;
  if p_categoria_id is not null and not exists (select 1 from public.categorias where id = p_categoria_id and tipo = 'receita' and ativo) then
    raise exception 'Escolha uma categoria de receita.';
  end if;
  if length(trim(coalesce(p_cliente, ''))) = 0 then raise exception 'Informe o cliente.'; end if;
  if length(trim(coalesce(p_descricao, ''))) = 0 then raise exception 'Informe a descrição.'; end if;
  if p_valor is null or p_valor <= 0 then raise exception 'Informe o valor.'; end if;
  if p_vencimento is null then raise exception 'Informe o vencimento.'; end if;
end
$$;

-- "+ Nova receita" (em aberto)
create or replace function public.criar_recebimento(
  p_obra_id uuid, p_categoria_id uuid, p_cliente text, p_descricao text, p_valor numeric, p_vencimento date,
  p_competencia date default null, p_conta_id uuid default null, p_observacoes text default null, p_nota_id uuid default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public._validar_receita(p_obra_id, p_categoria_id, p_cliente, p_descricao, p_valor, p_vencimento);
  insert into public.recebimentos (obra_id, categoria_id, cliente, descricao, valor, vencimento, data_competencia, status, conta_bancaria_id, observacoes)
  values (p_obra_id, p_categoria_id, left(trim(p_cliente), 200), left(trim(p_descricao), 300), round(p_valor, 2), p_vencimento,
          coalesce(p_competencia, p_vencimento), 'aberto', p_conta_id, nullif(trim(coalesce(p_observacoes, '')), ''))
  returning id into v_id;
  if p_nota_id is not null then perform public.vincular_nota_medicao(v_id, p_nota_id); end if;
  perform public._auditar('recebimento', v_id::text, 'criou', 'Receita lançada: R$ ' || public._brl(p_valor) || ' de ' || trim(p_cliente) || ', vence em ' || to_char(p_vencimento, 'DD/MM/YYYY'), p_obra_id);
  return v_id;
end
$$;
revoke all on function public.criar_recebimento(uuid, uuid, text, text, numeric, date, date, uuid, text, uuid) from public, anon;
grant execute on function public.criar_recebimento(uuid, uuid, text, text, numeric, date, date, uuid, text, uuid) to authenticated;

-- Cancelar receita em aberto (e os impostos da medição ainda não pagos)
create or replace function public.cancelar_recebimento(p_id uuid, p_motivo text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r public.recebimentos;
begin
  perform public._exigir_mexer_receber();
  if length(trim(coalesce(p_motivo, ''))) < 3 then raise exception 'Informe o motivo.'; end if;
  select * into r from public.recebimentos where id = p_id for update;
  if not found then raise exception 'Recebimento não encontrado.'; end if;
  if r.status <> 'aberto' then raise exception 'Só uma receita em aberto pode ser cancelada (desfaça a conciliação antes).'; end if;
  update public.recebimentos set status = 'cancelado', cancelamento_motivo = trim(p_motivo), updated_at = now() where id = r.id;
  update public.pagamentos set status = 'cancelado', cancelamento_motivo = 'Receita nº ' || r.numero || ' cancelada: ' || trim(p_motivo)
   where recebimento_id = r.id and status <> 'pago';
  perform public._auditar('recebimento', r.id::text, 'cancelou', 'Receita nº ' || r.numero || ' cancelada. Motivo: ' || trim(p_motivo), r.obra_id);
end
$$;
revoke all on function public.cancelar_recebimento(uuid, text) from public, anon;
grant execute on function public.cancelar_recebimento(uuid, text) to authenticated;

-- Nota de medição › receita + imposto retido + imposto devido
create or replace function public.lancar_medicao(
  p_nota_id uuid, p_vencimento date, p_conta_id uuid, p_cliente text,
  p_categoria_receita uuid, p_categoria_imposto uuid, p_aliquota numeric default 14
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  n public.notas_medicao;
  o public.obras;
  v_rec uuid;
  v_retido numeric(14, 2);
  v_devido numeric(14, 2);
  v_manual uuid := (select id from public.contas_bancarias where tipo = 'manual' order by created_at limit 1);
  v_nome text;
  v_aviso uuid;
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  perform public._exigir_mexer_receber();
  select * into n from public.notas_medicao where id = p_nota_id;
  if not found then raise exception 'Nota de medição não encontrada.'; end if;
  if exists (select 1 from public.recebimentos where nota_medicao_id = n.id and status <> 'cancelado') then
    raise exception 'Esta nota de medição já foi lançada como receita.';
  end if;
  select * into o from public.obras where id = n.obra_id;
  if p_conta_id is null or not exists (select 1 from public.contas_bancarias where id = p_conta_id and ativa and tipo = 'corrente') then
    raise exception 'Escolha a conta onde o dinheiro vai cair.';
  end if;
  if p_aliquota is null or p_aliquota < 0 or p_aliquota > 100 then raise exception 'Alíquota inválida.'; end if;
  if p_categoria_imposto is not null and not exists (select 1 from public.categorias where id = p_categoria_imposto and tipo = 'despesa' and ativo) then
    raise exception 'Escolha uma categoria de despesa para os impostos.';
  end if;
  v_retido := round(n.valor - n.valor_liquido, 2);
  v_devido := round(round(n.valor * p_aliquota / 100, 2) - v_retido, 2); -- mesma conta da tela (src/lib/impostos-medicao.ts)
  v_nome := 'Medição' || coalesce(' nº ' || n.numero, '') || ' — ' || o.nome;

  v_rec := public.criar_recebimento(n.obra_id, p_categoria_receita, coalesce(nullif(trim(p_cliente), ''), o.cliente, o.nome), v_nome, n.valor, p_vencimento,
                                    coalesce(n.data_emissao, p_vencimento), p_conta_id, null, n.id);

  if v_retido > 0 then
    insert into public.pagamentos (obra_id, favorecido, descricao, valor, vencimento, forma_pagamento, fluxo, status, created_by,
                                   categoria_id, conta_bancaria_id, data_competencia, recebimento_id, imposto_medicao, observacoes)
    values (n.obra_id, 'Imposto retido na fonte', 'Imposto retido — ' || v_nome, v_retido, p_vencimento, 'outro', o.fluxo, 'aguardando_pagamento', auth.uid(),
            p_categoria_imposto, p_conta_id, coalesce(n.data_emissao, p_vencimento), v_rec, 'retido',
            'Valor total R$ ' || public._brl(n.valor) || ' − líquido R$ ' || public._brl(n.valor_liquido) || '. Baixado na conciliação junto com a receita.');
  end if;
  if v_devido > 0 then
    if v_manual is null then
      insert into public.contas_bancarias (nome, banco, agencia, conta, tipo, created_by)
      values ('Baixa manual para imposto devido', '', '', '', 'manual', auth.uid()) returning id into v_manual;
    end if;
    insert into public.pagamentos (obra_id, favorecido, descricao, valor, vencimento, forma_pagamento, fluxo, status, pago_em, valor_pago, pago_por, created_by,
                                   categoria_id, conta_bancaria_id, data_competencia, recebimento_id, imposto_medicao, observacoes)
    values (n.obra_id, 'Imposto devido', 'Imposto devido — ' || v_nome, v_devido, p_vencimento, 'outro', o.fluxo, 'pago', v_hoje, v_devido, auth.uid(), auth.uid(),
            p_categoria_imposto, v_manual, coalesce(n.data_emissao, p_vencimento), v_rec, 'devido',
            public._brl(p_aliquota) || '% de R$ ' || public._brl(n.valor) || ' − retido R$ ' || public._brl(v_retido) || '.');
  end if;

  perform public._auditar('recebimento', v_rec::text, 'medicao',
    v_nome || ': receita R$ ' || public._brl(n.valor) || ', imposto retido R$ ' || public._brl(greatest(v_retido, 0)) || ' e imposto devido R$ ' || public._brl(greatest(v_devido, 0))
      || ' (' || public._brl(p_aliquota) || '%)', n.obra_id);
  for v_aviso in select distinct x from unnest(array[o.engenheiro_id, o.administrador_id]) x where x is not null and x <> auth.uid() loop
    perform public._notificar(v_aviso, 'Medição lançada com impostos',
      v_nome || ': receita de R$ ' || public._brl(n.valor) || ', imposto retido R$ ' || public._brl(greatest(v_retido, 0)) || ' e devido R$ ' || public._brl(greatest(v_devido, 0)) || ' (sem aprovação).',
      '/recebimentos/' || v_rec, null);
  end loop;
  return v_rec;
end
$$;
revoke all on function public.lancar_medicao(uuid, date, uuid, text, uuid, uuid, numeric) from public, anon;
grant execute on function public.lancar_medicao(uuid, date, uuid, text, uuid, uuid, numeric) to authenticated;

-- Concilia a entrada do extrato com a receita em aberto (valor igual, ou receita − imposto retido = líquido)
create or replace function public.conciliar_recebimento(p_linha_id uuid, p_recebimento_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  r public.recebimentos;
  p public.pagamentos;
  v_retido numeric(14, 2);
begin
  perform public._exigir_financeiro_conciliacao();
  select * into l from public.extrato_linhas where id = p_linha_id for update;
  if not found then raise exception 'Lançamento do banco não encontrado.'; end if;
  if l.situacao <> 'pendente' then raise exception 'Este lançamento do banco já foi conciliado ou arquivado.'; end if;
  if l.valor <= 0 then raise exception 'Só entradas do banco conciliam com receitas.'; end if;
  select * into r from public.recebimentos where id = p_recebimento_id for update;
  if not found then raise exception 'Recebimento não encontrado.'; end if;
  if r.status <> 'aberto' then raise exception 'Este recebimento não está em aberto.'; end if;
  select coalesce(sum(valor), 0) into v_retido from public.pagamentos
   where recebimento_id = r.id and imposto_medicao = 'retido' and status = 'aguardando_pagamento';
  if l.valor <> r.valor and l.valor <> r.valor - v_retido then
    raise exception 'O valor do banco (R$ %) não bate com a receita (R$ %)%.', public._brl(l.valor), public._brl(r.valor),
      case when v_retido > 0 then ' nem com a receita menos o imposto retido (R$ ' || public._brl(r.valor - v_retido) || ')' else '' end;
  end if;
  update public.recebimentos set status = 'recebido', recebido_em = l.data, valor_recebido = r.valor, conta_bancaria_id = l.conta_id, updated_at = now() where id = r.id;
  if l.valor <> r.valor then
    for p in select * from public.pagamentos where recebimento_id = r.id and imposto_medicao = 'retido' and status = 'aguardando_pagamento' for update loop
      update public.pagamentos set status = 'pago', pago_em = l.data, valor_pago = p.valor, pago_por = auth.uid(), conta_bancaria_id = l.conta_id where id = p.id;
      insert into public.conciliacao_itens (linha_id, pagamento_id, valor, baixou, created_by) values (l.id, p.id, p.valor, true, auth.uid());
      perform public._auditar('pagamento', p.id::text, 'conciliou', 'Imposto retido baixado na conciliação da receita nº ' || r.numero || ' (' || to_char(l.data, 'DD/MM/YYYY') || ')', p.obra_id, p.id);
    end loop;
  end if;
  update public.extrato_linhas set situacao = 'conciliada', recebimento_id = r.id, tratado_por = auth.uid(), tratado_em = now() where id = l.id;
  perform public._auditar('recebimento', r.id::text, 'conciliou',
    'Receita nº ' || r.numero || ' recebida em ' || to_char(l.data, 'DD/MM/YYYY') || ': banco R$ ' || public._brl(l.valor)
      || case when l.valor <> r.valor then ' (total R$ ' || public._brl(r.valor) || ' − retido R$ ' || public._brl(v_retido) || ')' else '' end, r.obra_id);
end
$$;
revoke all on function public.conciliar_recebimento(uuid, uuid) from public, anon;
grant execute on function public.conciliar_recebimento(uuid, uuid) to authenticated;

-- Desfazer: a receita manual volta para em aberto e o imposto retido baixado junto volta a ficar a pagar.
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
    -- Imposto retido baixado junto (receita − retido): volta a ficar a pagar quando o recebimento volta a aberto
    for ci in select * from public.conciliacao_itens where linha_id = l.id loop
      delete from public.conciliacao_itens where id = ci.id;
      if p_voltar_aberto and ci.baixou then
        perform public.estornar_baixa(ci.pagamento_id, 'Conciliação desfeita: ' || trim(p_motivo));
      end if;
    end loop;
    update public.extrato_linhas set situacao = 'pendente', recebimento_id = null, tratado_por = null, tratado_em = null where id = l.id;
    if p_voltar_aberto and r.lancado_conciliacao then
      update public.recebimentos set status = 'cancelado', cancelamento_motivo = 'Conciliação desfeita: ' || trim(p_motivo), updated_at = now() where id = r.id;
    elsif p_voltar_aberto then
      update public.recebimentos set status = 'aberto', recebido_em = null, valor_recebido = null, updated_at = now() where id = r.id;
    end if;
    perform public._auditar('recebimento', r.id::text, 'desconciliou',
      'Conciliação do recebimento nº ' || r.numero || ' com o extrato de ' || to_char(l.data, 'DD/MM/YYYY') || ' desfeita'
        || case when p_voltar_aberto and r.lancado_conciliacao then ' e o recebimento foi cancelado' when p_voltar_aberto then ' e o recebimento voltou para em aberto' else '' end || '. Motivo: ' || trim(p_motivo), r.obra_id);
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
  update public.extrato_linhas set situacao = 'pendente', tratado_por = null, tratado_em = null, encargos = null,
         classificacao = case when l.classificacao = 'aplicacao' then null else classificacao end
   where id = l.id;
  if l.classificacao = 'aplicacao' then
    perform public._auditar('conta_bancaria', l.conta_id::text, 'desconciliou',
      case when l.valor < 0 then 'Aplicação' else 'Resgate' end || ' automático de ' || to_char(l.data, 'DD/MM/YYYY') || ' (R$ ' || public._brl(abs(l.valor)) || ') voltou para as pendentes. Motivo: ' || trim(p_motivo));
  end if;
end
$$;
