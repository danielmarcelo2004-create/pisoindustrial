-- Contas a pagar: diferenciar o item pago por conciliação com o extrato (✓) da baixa manual.
-- A tabela de conciliação só é legível pelo Financeiro e pelo master; esta função devolve apenas o fato
-- "este pagamento (ou parcela) foi conciliado" para quem pode ver o pagamento, sem expor o extrato.
create or replace function public.conciliados_dos_pagamentos(p_ids uuid[])
returns table (pagamento_id uuid, parcela_id uuid)
language sql stable security definer set search_path = ''
as $$
  select c.pagamento_id, c.parcela_id
    from public.conciliacao_itens c
   where c.pagamento_id = any (p_ids)
     and exists (select 1 from public.pagamentos p where p.id = c.pagamento_id and public.pode_ver_obra(p.obra_id))
$$;
revoke all on function public.conciliados_dos_pagamentos(uuid[]) from public, anon;
grant execute on function public.conciliados_dos_pagamentos(uuid[]) to authenticated;
