-- Fundo fixo: dados bancários de quem recebe o fundo.
-- A pessoa informa a instituição e a conta (agência + conta) ou a chave PIX antes de lançar o primeiro gasto.
-- Ao fechar o fundo, o pagamento gerado (reposição/reembolso) nasce com a forma de pagamento certa (PIX ou
-- transferência) e com esses dados; a OP em PDF (modelo da empresa) é anexada a ele pelo sistema.

alter table public.fundos_fixos
  add column if not exists receb_forma text check (receb_forma in ('conta', 'pix')),
  add column if not exists receb_banco text,
  add column if not exists receb_favorecido text,
  add column if not exists receb_agencia text,
  add column if not exists receb_conta text,
  add column if not exists receb_chave_pix text,
  add column if not exists receb_informado_em timestamptz;

-- Texto dos dados: primeira linha = instituição; as demais = agência/conta ou chave PIX (mesmo formato da OP).
create or replace function public._dados_bancarios_fundo(f public.fundos_fixos)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when f.receb_forma is null then null
    when f.receb_forma = 'pix' then f.receb_banco || E'\nChave PIX: ' || f.receb_chave_pix
    else f.receb_banco || E'\nAgência: ' || f.receb_agencia || E'\nConta: ' || f.receb_conta
  end
$$;
revoke all on function public._dados_bancarios_fundo(public.fundos_fixos) from public, anon, authenticated;

-- A pessoa do fundo informa (ou corrige) os próprios dados bancários (favorecido = titular da conta ou da chave PIX) enquanto o fundo está aberto.
create or replace function public.informar_dados_bancarios_fundo(
  p_fundo_id uuid, p_forma text, p_banco text, p_favorecido text, p_agencia text default null, p_conta text default null, p_chave_pix text default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  f public.fundos_fixos;
  v_banco text := nullif(trim(p_banco), '');
  v_fav text := nullif(trim(p_favorecido), '');
  v_ag text := nullif(trim(p_agencia), '');
  v_cc text := nullif(trim(p_conta), '');
  v_pix text := nullif(trim(p_chave_pix), '');
begin
  select * into f from public.fundos_fixos where id = p_fundo_id for update;
  if not found or f.pessoa_id <> auth.uid() then
    raise exception 'Somente a pessoa do fundo informa os dados bancários dele.' using errcode = '42501';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if p_forma not in ('conta', 'pix') then
    raise exception 'Escolha como você recebe: conta bancária ou PIX.';
  end if;
  if v_banco is null then
    raise exception 'Informe a instituição bancária.';
  end if;
  if v_fav is null then
    raise exception 'Informe o nome do favorecido (titular da conta ou da chave PIX).';
  end if;
  if p_forma = 'conta' and (v_ag is null or v_cc is null) then
    raise exception 'Informe a agência e a conta.';
  end if;
  if p_forma = 'pix' and v_pix is null then
    raise exception 'Informe a chave PIX.';
  end if;
  update public.fundos_fixos
     set receb_forma = p_forma, receb_banco = v_banco, receb_favorecido = v_fav,
         receb_agencia = case when p_forma = 'conta' then v_ag end,
         receb_conta = case when p_forma = 'conta' then v_cc end,
         receb_chave_pix = case when p_forma = 'pix' then v_pix end,
         receb_informado_em = now()
   where id = p_fundo_id;
  perform public._auditar('fundo_fixo', p_fundo_id::text, 'dados_bancarios',
    'Dados bancários do fundo informados: ' || v_banco || ' (' || case when p_forma = 'pix' then 'PIX' else 'conta bancária' end || ')',
    f.obra_id, null, null, null);
end
$$;
revoke all on function public.informar_dados_bancarios_fundo(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.informar_dados_bancarios_fundo(uuid, text, text, text, text, text, text) to authenticated;

-- Gasto: só depois de informar os dados bancários (e as regras anteriores: aberto, com saldo, assinado depois)
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
  if f.receb_informado_em is null then
    raise exception 'Informe seus dados bancários (instituição e conta ou chave PIX) antes de lançar o primeiro gasto.';
  end if;
  if f.status = 'esgotado' or public._saldo_disponivel_fundo(f.id) <= 0 then
    raise exception 'Fundo esgotado: os gastos lançados já cobrem todo o valor do fundo. Peça ao Financeiro para fechar e repor o fundo.';
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

-- Pagamento do fundo: forma conforme os dados bancários (PIX ou transferência) e os dados nas observações.
create or replace function public._pagamento_fundo(f public.fundos_fixos, p_valor numeric, p_descricao text, p_vencimento date, p_conta uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_pessoa text := (select nome from public.profiles where id = f.pessoa_id);
  v_pag uuid;
begin
  insert into public.pagamentos (obra_id, favorecido, descricao, valor, vencimento, forma_pagamento, observacoes, fluxo, status, created_by, conta_bancaria_id, data_competencia)
  values (f.obra_id, coalesce(f.receb_favorecido, v_pessoa, 'Fundo fixo'), p_descricao, round(p_valor, 2), coalesce(p_vencimento, (now() at time zone 'America/Sao_Paulo')::date),
          case when f.receb_forma = 'conta' then 'transferencia'::public.forma_pagamento else 'pix'::public.forma_pagamento end,
          'Fundo fixo de ' || coalesce(v_pessoa, '') || ' (sem fluxo de aprovação: lançado pelo Financeiro).'
            || coalesce(E'\nDados para pagamento:\n' || public._dados_bancarios_fundo(f), ''),
          'C', 'aguardando_pagamento', auth.uid(), p_conta,
          coalesce(p_vencimento, (now() at time zone 'America/Sao_Paulo')::date))
  returning id into v_pag;
  return v_pag;
end
$$;

-- Fundo esgotado: a pessoa pede a reposição ao Financeiro (um pedido por fundo, com aviso na hora).
alter table public.fundos_fixos add column if not exists reposicao_pedida_em timestamptz;

create or replace function public.pedir_reposicao_fundo(p_fundo_id uuid)
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
    raise exception 'Somente a pessoa do fundo pede a reposição dele.' using errcode = '42501';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if not (f.status = 'esgotado' or public._saldo_disponivel_fundo(f.id) <= 0) then
    raise exception 'O fundo ainda tem saldo para gastos.';
  end if;
  if f.reposicao_pedida_em is not null then
    raise exception 'A reposição já foi solicitada ao Financeiro.';
  end if;
  update public.fundos_fixos set reposicao_pedida_em = now() where id = p_fundo_id;
  select nome into v_pessoa from public.profiles where id = f.pessoa_id;
  select nome into v_obra from public.obras where id = f.obra_id;
  v_gasto := coalesce((select sum(g.valor) from public.fundo_gastos g where g.fundo_id = f.id and g.status = 'aprovado'), 0);
  perform public._notificar_financeiro(
    'Reposição de fundo fixo solicitada',
    coalesce(v_pessoa, '') || ' pede a reposição do fundo em ' || coalesce(v_obra, '') || ': gastos aprovados de R$ '
      || public._reais(v_gasto) || ' num fundo de R$ ' || public._reais(f.valor) || '. Feche o fundo e escolha "Repor e continuar".',
    '/fundos-fixos/' || f.id, null);
  perform public._auditar('fundo_fixo', p_fundo_id::text, 'pediu_reposicao', 'Reposição do fundo solicitada ao Financeiro', f.obra_id, null, null, null);
end
$$;
revoke all on function public.pedir_reposicao_fundo(uuid) from public, anon;
grant execute on function public.pedir_reposicao_fundo(uuid) to authenticated;
