-- Remover um comprovante (ou a versão assinada) anexado a um gasto do fundo fixo.
-- Só a pessoa do fundo remove, só enquanto o gasto estiver pendente e o fundo aberto.
-- O arquivo continua no armazenamento; apenas o vínculo com o gasto é desfeito (fica registrado na auditoria).
create or replace function public.remover_anexo_gasto(p_anexo_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  a public.fundo_gasto_anexos;
  g public.fundo_gastos;
  f public.fundos_fixos;
begin
  select * into a from public.fundo_gasto_anexos where id = p_anexo_id for update;
  if not found then
    raise exception 'Anexo não encontrado.';
  end if;
  select * into g from public.fundo_gastos where id = a.gasto_id;
  select * into f from public.fundos_fixos where id = g.fundo_id;
  if f.pessoa_id <> auth.uid() then
    raise exception 'Somente a pessoa do fundo remove comprovantes.' using errcode = '42501';
  end if;
  if f.status = 'fechado' then
    raise exception 'Este fundo já foi fechado.';
  end if;
  if g.status <> 'pendente' then
    raise exception 'Só é possível remover anexos de gastos que ainda não foram decididos.';
  end if;

  delete from public.fundo_gasto_anexos where id = p_anexo_id;
  perform public._auditar('fundo_fixo', f.id::text, 'removeu_anexo', 'Anexo removido do gasto: ' || a.nome_arquivo,
    f.obra_id, null, to_jsonb(a), null);
end
$$;

revoke all on function public.remover_anexo_gasto(uuid) from public, anon;
grant execute on function public.remover_anexo_gasto(uuid) to authenticated;
