-- Correção: código do banco com 4 dígitos ("0104", como vem no extrato da Caixa) era gravado como "010",
-- porque lpad corta o texto maior que o tamanho pedido. Agora: os 3 últimos dígitos ("104").
-- (O site já normaliza antes de chamar; a correção vale para qualquer chamada direta.)

create or replace function public.importar_extrato(
  p_banco text, p_agencia text, p_conta text, p_arquivo text,
  p_inicio date, p_fim date, p_saldo numeric, p_saldo_em date, p_linhas jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_banco text := right('000' || regexp_replace(coalesce(p_banco, ''), '\D', '', 'g'), 3);
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

create or replace function public.criar_conta_bancaria(p_nome text, p_banco text, p_agencia text, p_conta text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_banco text := right('000' || regexp_replace(coalesce(p_banco, ''), '\D', '', 'g'), 3);
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
