-- Avisos por e-mail (Resend).
-- Quem recebe por e-mail:
--   * Engenheiro, Administrador e Administrador master: avisos de documento aguardando assinatura.
--   * Financeiro e Suprimentos: pagamento que vence amanhã e ainda não foi concluído.
alter table public.notificacoes
  add column if not exists email_status text check (email_status in ('pendente', 'enviado', 'falhou', 'ignorado')),
  add column if not exists email_erro text,
  add column if not exists email_enviado_em timestamptz;
create index if not exists notificacoes_email_idx on public.notificacoes (email_status) where email_status = 'pendente';

create or replace function public._email_elegivel(p_titulo text, p_perfil public.perfil_usuario)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when p_titulo in ('Documento aguardando sua assinatura', 'Documentos aguardando sua assinatura')
      then p_perfil in ('engenheiro', 'administrador', 'administrador_master')
    when p_titulo = 'Pagamento vence amanhã'
      then p_perfil in ('financeiro', 'suprimentos')
    else false
  end
$$;

create or replace function public._notificar(
  p_user_id uuid, p_titulo text, p_mensagem text, p_link text, p_pagamento_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tel text;
  v_email text;
  v_perfil public.perfil_usuario;
begin
  if p_user_id is null then
    return;
  end if;
  select p.telefone, p.email, p.perfil into v_tel, v_email, v_perfil from public.profiles p where p.id = p_user_id and p.ativo;
  if not found then
    return;
  end if;
  insert into public.notificacoes (user_id, titulo, mensagem, link, pagamento_id, whatsapp_status, email_status)
  values (p_user_id, p_titulo, p_mensagem, p_link, p_pagamento_id,
          case when nullif(trim(v_tel), '') is not null then 'pendente' end,
          case when nullif(trim(v_email), '') is not null and public._email_elegivel(p_titulo, v_perfil) then 'pendente' end);
end
$$;

create or replace function public.gerar_lembretes_diarios()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_amanha date := v_hoje + 1;
  v_total int := 0;
  r record;
  u record;
begin
  -- Pagamentos em aberto que vencem amanhã (Financeiro e Suprimentos)
  for r in
    select p.id, p.numero, p.favorecido, p.valor, p.vencimento, o.nome as obra, null::int as parcela
      from public.pagamentos p join public.obras o on o.id = p.obra_id
     where p.status in ('aguardando_engenheiro', 'aguardando_administrador', 'aguardando_pagamento')
       and p.vencimento = v_amanha
    union all
    select p.id, p.numero, p.favorecido, pc.valor_base + pc.multa + pc.juros - pc.desconto, pc.vencimento, o.nome, pc.numero
      from public.pagamento_parcelas pc
      join public.pagamentos p on p.id = pc.pagamento_id
      join public.obras o on o.id = p.obra_id
     where pc.status = 'a_pagar'
       and pc.vencimento = v_amanha
       and p.status in ('aguardando_engenheiro', 'aguardando_administrador', 'aguardando_pagamento')
  loop
    for u in select pr.id from public.profiles pr where pr.ativo and pr.perfil in ('financeiro', 'suprimentos') loop
      if not exists (
        select 1 from public.notificacoes n
         where n.user_id = u.id and n.pagamento_id = r.id and n.titulo = 'Pagamento vence amanhã'
           and n.mensagem like '%' || coalesce(r.parcela::text, '') || '%'
           and (n.created_at at time zone 'America/Sao_Paulo')::date = v_hoje
      ) then
        perform public._notificar(u.id, 'Pagamento vence amanhã',
          'Nº ' || r.numero || coalesce(' (parcela ' || r.parcela || ')', '') || ' — ' || r.favorecido
            || ' — R$ ' || to_char(r.valor, 'FM999G999G990D00') || ' (' || r.obra || ') vence em '
            || to_char(r.vencimento, 'DD/MM/YYYY') || '.',
          '/pagamentos/' || r.id, r.id);
        v_total := v_total + 1;
      end if;
    end loop;
  end loop;

  -- Engenheiros e administradores: documentos aguardando assinatura (uma vez por dia)
  for u in
    select pr.id as user_id, count(*) as qtd, min(p.vencimento) as primeiro
      from public.pagamentos p
      join public.obras o on o.id = p.obra_id
      join public.profiles pr on pr.ativo and (
            (p.status = 'aguardando_engenheiro' and pr.id = o.engenheiro_id)
         or (p.status = 'aguardando_administrador' and pr.id = o.administrador_id))
     group by pr.id
  loop
    if not exists (select 1 from public.notificacoes n where n.user_id = u.user_id
                    and n.titulo = 'Documentos aguardando sua assinatura'
                    and (n.created_at at time zone 'America/Sao_Paulo')::date = v_hoje) then
      perform public._notificar(u.user_id, 'Documentos aguardando sua assinatura',
        u.qtd || ' documento(s) pendente(s). Vencimento mais próximo: ' || to_char(u.primeiro, 'DD/MM/YYYY') || '.',
        '/aprovacoes', null);
      v_total := v_total + 1;
    end if;
  end loop;
  return v_total;
end
$$;

revoke all on function public.gerar_lembretes_diarios() from public, anon, authenticated;
