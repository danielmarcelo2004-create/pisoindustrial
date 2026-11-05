-- Provisão de pagamento: lembrete de despesa futura, com valor estimado (ou sem valor).
-- Não entra em totais, aprovações nem baixas enquanto não virar pagamento.
create table public.provisoes (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obras (id),
  descricao text not null check (length(trim(descricao)) > 0),
  mes_referencia text check (mes_referencia is null or mes_referencia ~ '^[0-9]{4}-[0-9]{2}$'),
  vencimento date,
  valor_estimado numeric(14, 2) check (valor_estimado is null or valor_estimado >= 0),
  observacoes text,
  status text not null default 'provisionada' check (status in ('provisionada', 'convertida', 'cancelada')),
  created_by uuid not null references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provisoes_obra_idx on public.provisoes (obra_id);
create trigger provisoes_updated before update on public.provisoes
  for each row execute function public._tocar_updated_at();

alter table public.provisoes enable row level security;
create policy provisoes_select on public.provisoes for select to authenticated
  using (public.pode_ver_obra(obra_id));
create policy provisoes_insert on public.provisoes for insert to authenticated
  with check (public.is_financeiro() and public.pode_ver_obra(obra_id));
create policy provisoes_update on public.provisoes for update to authenticated
  using (public.is_financeiro()) with check (public.is_financeiro());
create policy provisoes_delete on public.provisoes for delete to authenticated
  using (public.is_financeiro());

revoke all on public.provisoes from anon;
revoke delete, truncate on public.provisoes from authenticated;
