-- Valor líquido da medição: base do cálculo de imposto retido e devido.
alter table public.notas_contabeis add column if not exists valor_liquido numeric(14, 2);

-- Registrar a nota também guarda o valor líquido (quando a nota traz esse valor).
create or replace function public.registrar_nota_contabil(
  p_documento_id uuid,
  p_categoria public.categoria_nota_contabil,
  p_dados jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.documentos;
  v_id uuid;
begin
  select * into d from public.documentos where id = p_documento_id and ativo;
  if not found or not public.pode_ver_obra(d.obra_id) then
    raise exception 'Documento não encontrado.';
  end if;
  if d.tipo <> 'nota_fiscal' then
    raise exception 'Só notas fiscais entram na lista para a contabilidade.';
  end if;

  insert into public.notas_contabeis (
    documento_id, pagamento_id, obra_id, categoria, prestador_documento, prestador_nome, numero,
    data_emissao, valor, valor_liquido, retencoes, descricao_servico
  ) values (
    d.id, d.pagamento_id, d.obra_id, p_categoria,
    nullif(p_dados->>'prestador_documento', ''), nullif(p_dados->>'prestador_nome', ''), nullif(p_dados->>'numero', ''),
    nullif(p_dados->>'data_emissao', '')::date, nullif(p_dados->>'valor', '')::numeric,
    nullif(p_dados->>'valor_liquido', '')::numeric,
    coalesce(p_dados->'retencoes', '{}'::jsonb), nullif(p_dados->>'descricao_servico', '')
  )
  on conflict (documento_id) do update
    set categoria = excluded.categoria, prestador_documento = excluded.prestador_documento,
        prestador_nome = excluded.prestador_nome, numero = excluded.numero, data_emissao = excluded.data_emissao,
        valor = excluded.valor, valor_liquido = excluded.valor_liquido, retencoes = excluded.retencoes,
        descricao_servico = excluded.descricao_servico, enviada_em = null, enviada_por = null
  returning id into v_id;

  perform public._auditar('nota_contabil', v_id::text, 'identificou',
    'Nota identificada para a contabilidade: ' || p_categoria::text, d.obra_id, d.pagamento_id, null,
    jsonb_build_object('documento_id', d.id, 'categoria', p_categoria));
  return v_id;
end
$$;
