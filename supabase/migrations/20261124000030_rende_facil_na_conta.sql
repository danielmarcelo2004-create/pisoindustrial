-- BB Rende Fácil na própria conta corrente (como no Conta Azul): aplicação e resgate automáticos são conciliados
-- na conta, sem conta de investimento separada. Não viram despesa nem receita; o valor aplicado
-- (aplicações − resgates conciliados) aparece no cabeçalho da conta.

create or replace function public.conciliar_aplicacao(p_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  l public.extrato_linhas;
  n int := 0;
begin
  perform public._exigir_financeiro_conciliacao();
  for l in select * from public.extrato_linhas where id = any(coalesce(p_ids, '{}')) and situacao = 'pendente' order by data for update loop
    update public.extrato_linhas set situacao = 'conciliada', classificacao = 'aplicacao', tratado_por = auth.uid(), tratado_em = now() where id = l.id;
    perform public._auditar('conta_bancaria', l.conta_id::text, 'aplicacao',
      case when l.valor < 0 then 'Aplicação' else 'Resgate' end || ' automático de R$ ' || public._brl(abs(l.valor)) || ' em ' || to_char(l.data, 'DD/MM/YYYY') || ' conciliado na conta');
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function public.conciliar_aplicacao(uuid[]) from public, anon;
grant execute on function public.conciliar_aplicacao(uuid[]) to authenticated;

-- Valor aplicado por conta (Financeiro/master): aplicações − resgates conciliados na conta corrente.
create or replace function public.aplicado_nas_contas()
returns table (conta_id uuid, aplicado numeric)
language sql stable security definer set search_path = ''
as $$
  select l.conta_id, -sum(l.valor) from public.extrato_linhas l
   where l.situacao = 'conciliada' and l.classificacao = 'aplicacao' and public.pode_baixar()
   group by l.conta_id
$$;
revoke all on function public.aplicado_nas_contas() from public, anon;
grant execute on function public.aplicado_nas_contas() to authenticated;

-- Desfazer: a aplicação/resgate automático volta para as pendentes (e perde o tipo).
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
  update public.extrato_linhas set situacao = 'pendente', tratado_por = null, tratado_em = null, encargos = null,
         classificacao = case when l.classificacao = 'aplicacao' then null else classificacao end
   where id = l.id;
  if l.classificacao = 'aplicacao' then
    perform public._auditar('conta_bancaria', l.conta_id::text, 'desconciliou',
      case when l.valor < 0 then 'Aplicação' else 'Resgate' end || ' automático de ' || to_char(l.data, 'DD/MM/YYYY') || ' (R$ ' || public._brl(abs(l.valor)) || ') voltou para as pendentes. Motivo: ' || trim(p_motivo));
  end if;
end
$$;
