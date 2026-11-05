-- Suprimentos também cria provisões (nas obras que pode atuar).
drop policy if exists provisoes_insert on public.provisoes;
create policy provisoes_insert on public.provisoes for insert to authenticated
  with check (public.meu_perfil() in ('financeiro', 'suprimentos') and public.pode_atuar_obra(obra_id));
