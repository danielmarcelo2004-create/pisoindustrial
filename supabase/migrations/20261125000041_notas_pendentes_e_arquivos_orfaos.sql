-- 1) Notas fiscais ainda sem leitura (auditoria A-17): consulta exata no banco, sem a janela fixa de 500 documentos
--    que escondia as mais antigas. Só Financeiro e Suprimentos.
create or replace function public.notas_fiscais_pendentes(p_somente_pdf boolean default false, p_limite integer default 500)
returns table (documento_id uuid, nome_arquivo text, mime_type text, storage_path text, pagamento_numero bigint, favorecido text, obra_nome text)
language sql stable security definer set search_path = ''
as $$
  select d.id, d.nome_arquivo, d.mime_type, d.storage_path, p.numero, p.favorecido, o.nome
    from public.documentos d
    join public.pagamentos p on p.id = d.pagamento_id
    join public.obras o on o.id = p.obra_id
   where public.meu_perfil() in ('financeiro', 'suprimentos')
     and d.tipo = 'nota_fiscal' and d.ativo
     and d.mime_type is distinct from 'application/xml'
     and (not p_somente_pdf or d.mime_type = 'application/pdf')
     and not exists (select 1 from public.nf_notas n where n.documento_id = d.id)
     and not exists (select 1 from public.notas_contabeis c where c.documento_id = d.id)
   order by d.created_at desc
   limit greatest(coalesce(p_limite, 500), 1)
$$;
revoke all on function public.notas_fiscais_pendentes(boolean, integer) from public, anon;
grant execute on function public.notas_fiscais_pendentes(boolean, integer) to authenticated;

create or replace function public.notas_fiscais_pendentes_total()
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer
    from public.documentos d
   where public.meu_perfil() in ('financeiro', 'suprimentos')
     and d.tipo = 'nota_fiscal' and d.ativo
     and d.mime_type is distinct from 'application/xml'
     and not exists (select 1 from public.nf_notas n where n.documento_id = d.id)
     and not exists (select 1 from public.notas_contabeis c where c.documento_id = d.id)
$$;
revoke all on function public.notas_fiscais_pendentes_total() from public, anon;
grant execute on function public.notas_fiscais_pendentes_total() to authenticated;

-- 2) Arquivos órfãos no Storage (auditoria A-07): enviados mas sem registro em nenhuma tabela, com um prazo de
--    segurança. Só LISTA (para o Financeiro conferir antes de apagar): nada é apagado automaticamente.
create or replace function public.arquivos_orfaos(p_dias integer default 2)
returns table (caminho text, tamanho bigint, enviado_em timestamptz)
language sql stable security definer set search_path = ''
as $$
  select o.name, coalesce((o.metadata ->> 'size')::bigint, 0), o.created_at
    from storage.objects o
   where public.is_financeiro()
     and o.bucket_id = 'documentos'
     and o.created_at < now() - make_interval(days => greatest(coalesce(p_dias, 2), 1))
     and not exists (select 1 from public.documentos d where d.storage_path = o.name)
     and not exists (select 1 from public.fundo_gasto_anexos a where a.storage_path = o.name)
     and not exists (select 1 from public.ordem_anexos a where a.storage_path = o.name)
     and not exists (select 1 from public.notas_medicao n where n.storage_path = o.name)
   order by o.created_at
$$;
revoke all on function public.arquivos_orfaos(integer) from public, anon;
grant execute on function public.arquivos_orfaos(integer) to authenticated;
