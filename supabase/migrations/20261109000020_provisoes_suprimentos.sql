-- Suprimentos cria provisões em qualquer centro de custo que enxerga (como na OP e nos anexos de boleto/nota)
-- e muda a situação (convertida/cancelada) das provisões que ele mesmo criou. Excluir continua só com o Financeiro.
drop policy if exists provisoes_insert on public.provisoes;
create policy provisoes_insert on public.provisoes for insert to authenticated
  with check (public.meu_perfil() in ('financeiro', 'suprimentos') and public.pode_ver_obra(obra_id));

drop policy if exists provisoes_update on public.provisoes;
create policy provisoes_update on public.provisoes for update to authenticated
  using (public.is_financeiro() or (public.meu_perfil() = 'suprimentos' and created_by = auth.uid()))
  with check (public.is_financeiro() or (public.meu_perfil() = 'suprimentos' and created_by = auth.uid()));
