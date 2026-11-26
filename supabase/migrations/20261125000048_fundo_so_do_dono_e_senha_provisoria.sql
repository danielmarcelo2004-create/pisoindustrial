-- 1) Fundo fixo: cada pessoa vê só o próprio fundo (gastos, comprovantes e dados bancários).
--    Veem também o Financeiro e, para aprovar os gastos, o administrador (ou master) da obra.
--    Antes, quem estava vinculado à obra (engenheiro) e todo Suprimentos liam o fundo dos colegas.
create or replace function public._pode_ver_fundo(p_pessoa uuid, p_obra uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_pessoa = auth.uid()
      or public.is_financeiro()
      or (public.meu_perfil() in ('administrador', 'administrador_master') and public.pode_ver_obra(p_obra))
$$;
revoke all on function public._pode_ver_fundo(uuid, uuid) from public, anon;
grant execute on function public._pode_ver_fundo(uuid, uuid) to authenticated;

drop policy if exists fundos_select on public.fundos_fixos;
create policy fundos_select on public.fundos_fixos for select to authenticated
  using (public._pode_ver_fundo(pessoa_id, obra_id));
drop policy if exists fundo_gastos_select on public.fundo_gastos;
create policy fundo_gastos_select on public.fundo_gastos for select to authenticated
  using (exists (select 1 from public.fundos_fixos f where f.id = fundo_id and public._pode_ver_fundo(f.pessoa_id, f.obra_id)));
drop policy if exists fundo_anexos_select on public.fundo_gasto_anexos;
create policy fundo_anexos_select on public.fundo_gasto_anexos for select to authenticated
  using (exists (select 1 from public.fundo_gastos g join public.fundos_fixos f on f.id = g.fundo_id
         where g.id = gasto_id and public._pode_ver_fundo(f.pessoa_id, f.obra_id)));
drop policy if exists fundo_anexos_leitura on storage.objects;
create policy fundo_anexos_leitura on storage.objects for select to authenticated
  using (bucket_id = 'documentos' and name like 'fundos/%'
    and exists (select 1 from public.fundos_fixos f
                where f.id = public._uuid_ou_nulo(split_part(name, '/', 2)) and public._pode_ver_fundo(f.pessoa_id, f.obra_id)));

-- 2) Senha provisória: enquanto a troca obrigatória de senha estiver pendente, o usuário não acessa dados pela API.
--    Antes só a tela mandava para "Trocar senha"; quem tinha a senha provisória lia e gravava tudo falando direto com a API.
--    Todas as regras de permissão partem de meu_perfil(); sem perfil válido, nada é liberado (a própria linha em
--    profiles continua legível, e confirmar_troca_senha() continua funcionando).
create or replace function public.meu_perfil()
returns public.perfil_usuario
language sql stable security definer set search_path = ''
as $$
  select p.perfil from public.profiles p where p.id = auth.uid() and p.ativo and not p.troca_senha_pendente
$$;
