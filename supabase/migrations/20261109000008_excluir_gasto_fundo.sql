-- Exclusão de gasto de fundo fixo (lançamento errado), feita pelo Financeiro enquanto o fundo estiver aberto.
-- Remove também os vínculos de comprovantes; os arquivos continuam no armazenamento. Fica registrado na auditoria.
create or replace function public.excluir_gasto_fundo(p_gasto_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  g public.fundo_gastos;
  f public.fundos_fixos;
begin
  if public.meu_perfil() <> 'financeiro' then
    raise exception 'Somente o Financeiro exclui gastos de fundo fixo.' using errcode = '42501';
  end if;
  select * into g from public.fundo_gastos where id = p_gasto_id for update;
  if not found then
    raise exception 'Gasto não encontrado.';
  end if;
  select * into f from public.fundos_fixos where id = g.fundo_id;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;

  delete from public.fundo_gasto_anexos where gasto_id = p_gasto_id;
  delete from public.fundo_gastos where id = p_gasto_id;
  perform public._auditar('fundo_fixo', f.id::text, 'excluiu_gasto', 'Gasto excluído: ' || g.descricao,
    f.obra_id, null, to_jsonb(g), null);
end
$$;

revoke all on function public.excluir_gasto_fundo(uuid) from public, anon;
grant execute on function public.excluir_gasto_fundo(uuid) to authenticated;
