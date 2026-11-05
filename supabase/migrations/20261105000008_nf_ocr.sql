-- Leitura automática de notas em PDF/imagem (OCR), só para notas nítidas.
alter table public.nf_notas drop constraint if exists nf_notas_origem_check;
alter table public.nf_notas add constraint nf_notas_origem_check check (origem in ('xml', 'manual', 'ocr'));

create or replace function public.registrar_nf(p_documento_id uuid, p_nota jsonb, p_itens jsonb, p_origem text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  d public.documentos;
  v_id uuid;
  v_item jsonb;
  v_chave text := nullif(regexp_replace(coalesce(p_nota ->> 'chave', ''), '\D', '', 'g'), '');
begin
  select * into d from public.documentos where id = p_documento_id;
  if not found or not public.pode_ver_obra(d.obra_id) then
    raise exception 'Documento não encontrado.';
  end if;
  if not (public.pode_atuar_obra(d.obra_id) or public.is_financeiro()) then
    raise exception 'Você não tem permissão para registrar dados desta nota.' using errcode = '42501';
  end if;
  if d.tipo <> 'nota_fiscal' then
    raise exception 'O documento não é uma nota fiscal.';
  end if;
  if p_origem not in ('xml', 'manual', 'ocr') then
    raise exception 'Origem inválida.';
  end if;
  if jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'A nota precisa ter ao menos um item.';
  end if;
  if exists (select 1 from public.nf_notas n where n.documento_id = p_documento_id) then
    raise exception 'Os itens desta nota já foram registrados.';
  end if;
  if v_chave is not null and exists (select 1 from public.nf_notas n where n.chave = v_chave and n.ativa) then
    raise exception 'Esta NF-e (chave %) já foi registrada em outro pagamento.', v_chave;
  end if;

  insert into public.nf_notas (documento_id, pagamento_id, obra_id, chave, numero, serie, data_emissao, emitente_cnpj,
                               emitente_nome, emitente_uf, valor_produtos, valor_frete, valor_desconto, valor_total, origem)
  values (d.id, d.pagamento_id, d.obra_id, v_chave, p_nota ->> 'numero', p_nota ->> 'serie',
          (p_nota ->> 'data_emissao')::date,
          nullif(regexp_replace(coalesce(p_nota ->> 'emitente_cnpj', ''), '\D', '', 'g'), ''),
          trim(p_nota ->> 'emitente_nome'), upper(nullif(p_nota ->> 'emitente_uf', '')),
          (p_nota ->> 'valor_produtos')::numeric, (p_nota ->> 'valor_frete')::numeric,
          (p_nota ->> 'valor_desconto')::numeric, (p_nota ->> 'valor_total')::numeric, p_origem)
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_itens) loop
    insert into public.nf_itens (nota_id, numero_item, codigo, descricao, descricao_normalizada, ncm, unidade,
                                 quantidade, valor_unitario, valor_total)
    values (v_id, (v_item ->> 'numero_item')::int, v_item ->> 'codigo', trim(v_item ->> 'descricao'),
            v_item ->> 'descricao_normalizada', v_item ->> 'ncm', upper(trim(v_item ->> 'unidade')),
            (v_item ->> 'quantidade')::numeric, (v_item ->> 'valor_unitario')::numeric, (v_item ->> 'valor_total')::numeric);
  end loop;

  perform public._auditar('documento', d.id::text, 'registrou_nf',
    'Itens da NF ' || coalesce(p_nota ->> 'numero', '') || ' registrados ('
      || case p_origem when 'xml' then 'leitura automática do XML' when 'ocr' then 'leitura automática do PDF (OCR, nota nítida)' else 'lançamento manual' end
      || ', ' || jsonb_array_length(p_itens) || ' itens)',
    d.obra_id, d.pagamento_id, null, jsonb_build_object('nota_id', v_id, 'chave', v_chave));
  return v_id;
end
$$;

revoke all on function public.registrar_nf(uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.registrar_nf(uuid, jsonb, jsonb, text) to authenticated;
