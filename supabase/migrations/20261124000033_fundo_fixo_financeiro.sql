-- Fundo fixo no caixa da empresa:
-- • Criar o fundo = desembolso: despesa (a pagar) com o valor do fundo, saindo da conta escolhida.
-- • "Fechar e repor": paga os gastos aprovados (reposição até o valor do fundo + reembolso do que passou)
--   e abre na hora um novo fundo com o mesmo valor (o dinheiro que sobrou continua com a pessoa).
-- • "Encerrar" (fim da obra): reembolso do que passou do fundo, se houver, e o saldo que sobrou vira
--   receita em aberto ("devolução do saldo do fundo fixo") para conciliar quando a pessoa devolver.

alter table public.fundos_fixos add column if not exists conta_bancaria_id uuid references public.contas_bancarias (id);
alter table public.fundos_fixos add column if not exists pagamento_inicial_id uuid references public.pagamentos (id);
alter table public.fundos_fixos add column if not exists recebimento_devolucao_id uuid references public.recebimentos (id);
alter table public.fundos_fixos add column if not exists fundo_anterior_id uuid references public.fundos_fixos (id);

create or replace function public._pagamento_fundo(f public.fundos_fixos, p_valor numeric, p_descricao text, p_vencimento date, p_conta uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_pessoa text := (select nome from public.profiles where id = f.pessoa_id);
  v_pag uuid;
begin
  insert into public.pagamentos (obra_id, favorecido, descricao, valor, vencimento, forma_pagamento, observacoes, fluxo, status, created_by, conta_bancaria_id, data_competencia)
  values (f.obra_id, coalesce(v_pessoa, 'Fundo fixo'), p_descricao, round(p_valor, 2), coalesce(p_vencimento, (now() at time zone 'America/Sao_Paulo')::date), 'pix',
          'Fundo fixo de ' || coalesce(v_pessoa, '') || ' (sem fluxo de aprovação: lançado pelo Financeiro).', 'C', 'aguardando_pagamento', auth.uid(), p_conta,
          coalesce(p_vencimento, (now() at time zone 'America/Sao_Paulo')::date))
  returning id into v_pag;
  return v_pag;
end
$$;
revoke all on function public._pagamento_fundo(public.fundos_fixos, numeric, text, date, uuid) from public, anon, authenticated;

drop function if exists public.criar_fundo_fixo(uuid, uuid, numeric);
create or replace function public.criar_fundo_fixo(p_obra_id uuid, p_pessoa_id uuid, p_valor numeric, p_conta_id uuid default null, p_vencimento date default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  f public.fundos_fixos;
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro cria fundos fixos.' using errcode = '42501';
  end if;
  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe um valor de fundo maior que zero.';
  end if;
  if not exists (select 1 from public.profiles pr where pr.id = p_pessoa_id and pr.ativo and pr.perfil in ('engenheiro', 'suprimentos')) then
    raise exception 'O fundo fixo é para engenheiro ou Suprimentos.';
  end if;
  if p_conta_id is not null and not exists (select 1 from public.contas_bancarias where id = p_conta_id and ativa) then
    raise exception 'Escolha a conta de onde sai o dinheiro do fundo.';
  end if;
  insert into public.fundos_fixos (obra_id, pessoa_id, valor, conta_bancaria_id)
  values (p_obra_id, p_pessoa_id, round(p_valor, 2), p_conta_id)
  returning * into f;
  v_id := f.id;
  if p_conta_id is not null then
    update public.fundos_fixos
       set pagamento_inicial_id = public._pagamento_fundo(f, f.valor, 'Fundo fixo (' || coalesce((select nome from public.profiles where id = p_pessoa_id), '') || '): desembolso inicial', p_vencimento, p_conta_id)
     where id = v_id;
  end if;
  perform public._auditar('fundo_fixo', v_id::text, 'criou', 'Fundo fixo criado' || case when p_conta_id is not null then ' com desembolso de R$ ' || public._reais(f.valor) else '' end,
    p_obra_id, null, null, jsonb_build_object('pessoa_id', p_pessoa_id, 'valor', p_valor));
  return v_id;
end
$$;
revoke all on function public.criar_fundo_fixo(uuid, uuid, numeric, uuid, date) from public, anon;
grant execute on function public.criar_fundo_fixo(uuid, uuid, numeric, uuid, date) to authenticated;

drop function if exists public.fechar_fundo_fixo(uuid, date);
create or replace function public.fechar_fundo_fixo(p_fundo_id uuid, p_vencimento date, p_modo text default 'auto', p_conta_id uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  v_pessoa text;
  v_gasto numeric(14, 2);
  v_reposicao numeric(14, 2) := 0;
  v_reembolso numeric(14, 2) := 0;
  v_saldo numeric(14, 2);
  v_pag uuid;
  v_rec uuid;
  v_novo uuid;
  v_conta uuid;
  v_venc date := coalesce(p_vencimento, (now() at time zone 'America/Sao_Paulo')::date);
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro fecha fundos fixos.' using errcode = '42501';
  end if;
  if p_modo not in ('auto', 'repor', 'encerrar') then raise exception 'Modo de fechamento inválido.'; end if;
  select * into f from public.fundos_fixos where id = p_fundo_id for update;
  if not found or f.status = 'fechado' then
    raise exception 'Fundo não encontrado ou já fechado.';
  end if;
  v_conta := coalesce(p_conta_id, f.conta_bancaria_id);
  select nome into v_pessoa from public.profiles where id = f.pessoa_id;
  v_gasto := coalesce((select sum(g.valor) from public.fundo_gastos g where g.fundo_id = f.id and g.status = 'aprovado'), 0);
  v_saldo := f.valor - v_gasto;

  if p_modo = 'repor' or (p_modo = 'auto' and f.status = 'esgotado') then
    v_reposicao := least(v_gasto, f.valor);
    v_reembolso := greatest(v_gasto - f.valor, 0);
  else
    v_reembolso := greatest(v_gasto - f.valor, 0);
  end if;

  if v_reposicao + v_reembolso > 0 then
    v_pag := public._pagamento_fundo(f, v_reposicao + v_reembolso,
      'Fundo fixo (' || coalesce(v_pessoa, '') || '): ' ||
        case when v_reposicao > 0 then 'reposição de R$ ' || public._reais(v_reposicao) else '' end ||
        case when v_reposicao > 0 and v_reembolso > 0 then ' + ' else '' end ||
        case when v_reembolso > 0 then 'reembolso de R$ ' || public._reais(v_reembolso) else '' end,
      v_venc, v_conta);
    perform public._notificar_etapa(v_pag);
  end if;

  -- Encerrar com saldo: a pessoa devolve o que sobrou (receita em aberto para conciliar)
  if p_modo = 'encerrar' and v_saldo > 0 then
    insert into public.recebimentos (obra_id, cliente, descricao, valor, vencimento, data_competencia, status, conta_bancaria_id, observacoes)
    values (f.obra_id, coalesce(v_pessoa, 'Fundo fixo'), 'Devolução do saldo do fundo fixo', v_saldo, v_venc, v_venc, 'aberto', v_conta,
            'Fundo de R$ ' || public._reais(f.valor) || ' − gastos aprovados R$ ' || public._reais(v_gasto) || '.')
    returning id into v_rec;
  end if;

  update public.fundos_fixos
     set status = 'fechado', fechado_em = now(), reposicao = v_reposicao, reembolso = v_reembolso,
         saldo_repassado = case when p_modo = 'repor' or v_saldo <= 0 then 0 else v_saldo end, pagamento_id = v_pag, recebimento_devolucao_id = v_rec
   where id = p_fundo_id;

  -- Repor: o fundo continua (novo fundo do mesmo valor, sem novo desembolso: a reposição completa o valor)
  if p_modo = 'repor' then
    insert into public.fundos_fixos (obra_id, pessoa_id, valor, conta_bancaria_id, fundo_anterior_id)
    values (f.obra_id, f.pessoa_id, f.valor, v_conta, f.id) returning id into v_novo;
  end if;

  perform public._auditar('fundo_fixo', p_fundo_id::text, 'fechou',
    'Fundo fechado (' || case p_modo when 'repor' then 'repor e continuar' when 'encerrar' then 'encerrado' else 'fechamento' end || '). Reposição R$ ' || public._reais(v_reposicao) || ', reembolso R$ ' || public._reais(v_reembolso)
      || case when p_modo <> 'repor' and v_saldo > 0 then ', saldo a devolver R$ ' || public._reais(v_saldo) else '' end,
    f.obra_id, v_pag, null, jsonb_build_object('reposicao', v_reposicao, 'reembolso', v_reembolso, 'saldo', greatest(v_saldo, 0), 'novo_fundo', v_novo, 'devolucao', v_rec));
  return v_pag;
end
$$;
revoke all on function public.fechar_fundo_fixo(uuid, date, text, uuid) from public, anon;
grant execute on function public.fechar_fundo_fixo(uuid, date, text, uuid) to authenticated;
