-- Marca de quem cadastrou: Financeiro e Suprimentos podem "assinar" o próprio cadastro.
-- É só um registro (não é etapa de aprovação do fluxo).
alter table public.pagamentos add column if not exists assinado_no_cadastro boolean not null default false;

create or replace function public.marcar_assinatura_cadastro(p_id uuid, p_assinar boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
begin
  select * into p from public.pagamentos where id = p_id for update;
  if not found or p.created_by <> auth.uid() or public.meu_perfil() not in ('financeiro', 'suprimentos') then
    raise exception 'Somente quem cadastrou o pagamento pode marcar a assinatura do cadastro.' using errcode = '42501';
  end if;
  if p.status in ('pago', 'cancelado') then
    raise exception 'Não é possível alterar a marca de um pagamento pago ou cancelado.';
  end if;
  update public.pagamentos set assinado_no_cadastro = p_assinar where id = p_id;
  perform public._auditar('pagamento', p_id::text, 'assinou_cadastro',
    case when p_assinar then 'Cadastro assinado por quem cadastrou (marca, sem etapa de aprovação)'
         else 'Marca de assinatura do cadastro removida' end,
    p.obra_id, p_id, jsonb_build_object('assinado_no_cadastro', p.assinado_no_cadastro),
    jsonb_build_object('assinado_no_cadastro', p_assinar));
end
$$;

revoke all on function public.marcar_assinatura_cadastro(uuid, boolean) from public, anon;
grant execute on function public.marcar_assinatura_cadastro(uuid, boolean) to authenticated;
