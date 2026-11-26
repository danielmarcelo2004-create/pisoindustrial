-- Fundo fixo: sem limite para novos gastos e fechamento solicitado pela própria pessoa.
-- • A pessoa do fundo (engenheiro ou Suprimentos) continua lançando gastos mesmo depois de passar do valor do fundo;
--   a diferença vira reembolso quando o Financeiro fecha.
-- • Ela mesma pode solicitar o fechamento do fundo; só o Financeiro fecha. O pedido avisa o Financeiro (sino) e fica
--   visível na aba Fundos fixos (aviso na lista e contador no menu).
-- • Depois de solicitar o fechamento, a pessoa não lança mais gastos até o Financeiro recusar o pedido (pedido por engano
--   ou fundo ainda com saldo) ou fechar o fundo (o "repor e continuar" abre um fundo novo, já liberado para gastos).

alter table public.fundos_fixos add column if not exists fechamento_solicitado_em timestamptz;
update public.fundos_fixos set fechamento_solicitado_em = reposicao_pedida_em
 where reposicao_pedida_em is not null and fechamento_solicitado_em is null;

-- Gasto: segue exigindo fundo aberto e dados bancários, mas não bloqueia mais por saldo.
create or replace function public.lancar_gasto_fundo(p_fundo_id uuid, p_descricao text, p_data date, p_valor numeric)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  v_id uuid;
begin
  select * into f from public.fundos_fixos where id = p_fundo_id for update;
  if not found or f.pessoa_id <> auth.uid() then
    raise exception 'Somente a pessoa do fundo lança gastos nele.' using errcode = '42501';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if f.fechamento_solicitado_em is not null then
    raise exception 'Você solicitou o fechamento deste fundo: aguarde o Financeiro fechar o fundo ou recusar o pedido para lançar novos gastos.';
  end if;
  if f.receb_informado_em is null then
    raise exception 'Informe seus dados bancários (instituição e conta ou chave PIX) antes de lançar o primeiro gasto.';
  end if;
  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe o valor do gasto.';
  end if;
  if nullif(trim(p_descricao), '') is null or p_data is null then
    raise exception 'Informe a descrição e a data do gasto.';
  end if;
  insert into public.fundo_gastos (fundo_id, descricao, data_gasto, valor, status)
  values (p_fundo_id, trim(p_descricao), p_data, round(p_valor, 2), 'pendente')
  returning id into v_id;
  return v_id;
end
$$;

-- A pessoa do fundo solicita o fechamento (um pedido por fundo; o Financeiro é avisado na hora).
drop function if exists public.pedir_reposicao_fundo(uuid);
create or replace function public.solicitar_fechamento_fundo(p_fundo_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  v_pessoa text;
  v_obra text;
  v_gasto numeric(14, 2);
begin
  select * into f from public.fundos_fixos where id = p_fundo_id for update;
  if not found or f.pessoa_id <> auth.uid() then
    raise exception 'Somente a pessoa do fundo solicita o fechamento dele.' using errcode = '42501';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if f.fechamento_solicitado_em is not null then
    raise exception 'O fechamento já foi solicitado ao Financeiro.';
  end if;
  update public.fundos_fixos set fechamento_solicitado_em = now() where id = p_fundo_id;
  select nome into v_pessoa from public.profiles where id = f.pessoa_id;
  select nome into v_obra from public.obras where id = f.obra_id;
  v_gasto := coalesce((select sum(g.valor) from public.fundo_gastos g where g.fundo_id = f.id and g.status = 'aprovado'), 0);
  perform public._notificar_financeiro(
    'Fechamento de fundo fixo solicitado',
    coalesce(v_pessoa, '') || ' solicita o fechamento do fundo em ' || coalesce(v_obra, '') || ': gastos aprovados de R$ '
      || public._reais(v_gasto) || ' num fundo de R$ ' || public._reais(f.valor) || '. Abra o fundo para fechar e repor ou encerrar.',
    '/fundos-fixos/' || f.id, null);
  perform public._auditar('fundo_fixo', p_fundo_id::text, 'solicitou_fechamento', 'Fechamento do fundo solicitado ao Financeiro', f.obra_id, null, null, null);
end
$$;
revoke all on function public.solicitar_fechamento_fundo(uuid) from public, anon;
grant execute on function public.solicitar_fechamento_fundo(uuid) to authenticated;

-- O Financeiro recusa o pedido (feito por engano ou com o fundo ainda com saldo): a pessoa volta a lançar gastos.
create or replace function public.recusar_fechamento_fundo(p_fundo_id uuid, p_motivo text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  v_motivo text := nullif(trim(p_motivo), '');
  v_obra text;
begin
  if public.meu_perfil() <> 'financeiro' then
    raise exception 'Somente o Financeiro recusa o pedido de fechamento.' using errcode = '42501';
  end if;
  select * into f from public.fundos_fixos where id = p_fundo_id for update;
  if not found then
    raise exception 'Fundo não encontrado.';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if f.fechamento_solicitado_em is null then
    raise exception 'Não há pedido de fechamento para recusar neste fundo.';
  end if;
  update public.fundos_fixos set fechamento_solicitado_em = null where id = p_fundo_id;
  select nome into v_obra from public.obras where id = f.obra_id;
  perform public._notificar(
    f.pessoa_id,
    'Pedido de fechamento do fundo recusado',
    'O Financeiro recusou o pedido de fechamento do seu fundo em ' || coalesce(v_obra, '') || '.'
      || coalesce(' Motivo: ' || v_motivo || '.', '') || ' Você já pode lançar gastos de novo.',
    '/fundos-fixos/' || f.id, null);
  perform public._auditar('fundo_fixo', p_fundo_id::text, 'recusou_fechamento',
    'Pedido de fechamento recusado' || coalesce(': ' || v_motivo, ''), f.obra_id, null, null, null);
end
$$;
revoke all on function public.recusar_fechamento_fundo(uuid, text) from public, anon;
grant execute on function public.recusar_fechamento_fundo(uuid, text) to authenticated;

alter table public.fundos_fixos drop column if exists reposicao_pedida_em;
