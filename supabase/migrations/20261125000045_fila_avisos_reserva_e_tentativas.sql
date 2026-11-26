-- Fila de avisos (e-mail e WhatsApp): duas execuções ao mesmo tempo mandavam o mesmo aviso duas vezes, e uma falha
-- passageira (instabilidade do provedor) descartava o aviso na hora. Agora cada execução "reserva" os avisos
-- (estado "processando") antes de enviar, e a falha volta para a fila com espera crescente, até 4 tentativas.

alter table public.notificacoes
  add column if not exists email_tentativas int not null default 0,
  add column if not exists email_proxima_em timestamptz,
  add column if not exists email_reservado_em timestamptz,
  add column if not exists whatsapp_tentativas int not null default 0,
  add column if not exists whatsapp_proxima_em timestamptz,
  add column if not exists whatsapp_reservado_em timestamptz;

alter table public.notificacoes drop constraint if exists notificacoes_email_status_check;
alter table public.notificacoes add constraint notificacoes_email_status_check
  check (email_status in ('pendente', 'processando', 'enviado', 'falhou', 'ignorado'));
alter table public.notificacoes drop constraint if exists notificacoes_whatsapp_status_check;
alter table public.notificacoes add constraint notificacoes_whatsapp_status_check
  check (whatsapp_status in ('pendente', 'processando', 'enviado', 'falhou', 'ignorado'));

-- Reserva até p_limite avisos prontos do canal ('email' ou 'whatsapp') e devolve os ids. Quem reservou fica com
-- eles; reservas esquecidas há mais de 15 minutos (execução que caiu no meio) voltam para a fila.
create or replace function public.reservar_avisos(p_canal text, p_limite int)
returns setof uuid
language plpgsql security definer set search_path = ''
as $$
begin
  if p_canal not in ('email', 'whatsapp') then
    raise exception 'Canal inválido.';
  end if;
  if p_canal = 'email' then
    update public.notificacoes set email_status = 'pendente', email_reservado_em = null
     where email_status = 'processando' and email_reservado_em < now() - interval '15 minutes';
    return query
      with pega as (
        select id from public.notificacoes
         where email_status = 'pendente' and coalesce(email_proxima_em, '-infinity') <= now()
         order by created_at limit greatest(p_limite, 1)
           for update skip locked)
      update public.notificacoes n set email_status = 'processando', email_reservado_em = now()
        from pega where n.id = pega.id returning n.id;
  else
    update public.notificacoes set whatsapp_status = 'pendente', whatsapp_reservado_em = null
     where whatsapp_status = 'processando' and whatsapp_reservado_em < now() - interval '15 minutes';
    return query
      with pega as (
        select id from public.notificacoes
         where whatsapp_status = 'pendente' and coalesce(whatsapp_proxima_em, '-infinity') <= now()
         order by created_at limit greatest(p_limite, 1)
           for update skip locked)
      update public.notificacoes n set whatsapp_status = 'processando', whatsapp_reservado_em = now()
        from pega where n.id = pega.id returning n.id;
  end if;
end
$$;
revoke all on function public.reservar_avisos(text, int) from public, anon, authenticated;
grant execute on function public.reservar_avisos(text, int) to service_role;

-- Resultado de uma tentativa. Falha: volta para "pendente" com espera de 5, 20 e 80 minutos; na 4ª falha vira "falhou".
create or replace function public.registrar_resultado_aviso(p_canal text, p_id uuid, p_ok boolean, p_erro text default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_tent int;
  v_final text;
begin
  if p_canal not in ('email', 'whatsapp') then
    raise exception 'Canal inválido.';
  end if;
  if p_ok then
    if p_canal = 'email' then
      update public.notificacoes set email_status = 'enviado', email_enviado_em = now(), email_erro = null, email_reservado_em = null where id = p_id;
    else
      update public.notificacoes set whatsapp_status = 'enviado', whatsapp_enviado_em = now(), whatsapp_erro = null, whatsapp_reservado_em = null where id = p_id;
    end if;
    return 'enviado';
  end if;
  if p_canal = 'email' then
    update public.notificacoes set email_tentativas = email_tentativas + 1 where id = p_id returning email_tentativas into v_tent;
    v_final := case when v_tent >= 4 then 'falhou' else 'pendente' end;
    update public.notificacoes
       set email_status = v_final, email_erro = left(p_erro, 500), email_reservado_em = null,
           email_proxima_em = case when v_final = 'pendente' then now() + (5 * power(4, v_tent - 1)) * interval '1 minute' end
     where id = p_id;
  else
    update public.notificacoes set whatsapp_tentativas = whatsapp_tentativas + 1 where id = p_id returning whatsapp_tentativas into v_tent;
    v_final := case when v_tent >= 4 then 'falhou' else 'pendente' end;
    update public.notificacoes
       set whatsapp_status = v_final, whatsapp_erro = left(p_erro, 500), whatsapp_reservado_em = null,
           whatsapp_proxima_em = case when v_final = 'pendente' then now() + (5 * power(4, v_tent - 1)) * interval '1 minute' end
     where id = p_id;
  end if;
  return v_final;
end
$$;
revoke all on function public.registrar_resultado_aviso(text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.registrar_resultado_aviso(text, uuid, boolean, text) to service_role;
