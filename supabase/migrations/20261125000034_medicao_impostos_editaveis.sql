-- Nota de medição: imposto retido e devido calculados, mas editáveis antes de lançar.
drop function if exists public.lancar_medicao(uuid, date, uuid, text, uuid, uuid, numeric);

create or replace function public.lancar_medicao(
  p_nota_id uuid, p_vencimento date, p_conta_id uuid, p_cliente text,
  p_categoria_receita uuid, p_categoria_imposto uuid, p_aliquota numeric default 14,
  p_retido numeric default null, p_devido numeric default null
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
  -- Calculado (total − líquido; alíquota × total − retido), mas o Financeiro pode corrigir os valores na tela
  v_retido := coalesce(round(p_retido, 2), round(n.valor - n.valor_liquido, 2));
  v_devido := coalesce(round(p_devido, 2), round(round(n.valor * p_aliquota / 100, 2) - v_retido, 2));
  if v_retido < 0 or v_retido >= n.valor then raise exception 'Imposto retido inválido.'; end if;
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
revoke all on function public.lancar_medicao(uuid, date, uuid, text, uuid, uuid, numeric, numeric, numeric) from public, anon;
grant execute on function public.lancar_medicao(uuid, date, uuid, text, uuid, uuid, numeric, numeric, numeric) to authenticated;
