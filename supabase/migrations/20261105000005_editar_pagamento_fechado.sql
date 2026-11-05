-- Financeiro e Suprimentos alteram obra e dados de pagamentos liberados ou pagos.
-- Não pede nova aprovação; a alteração fica na auditoria e avisa o Financeiro.
drop function public.atualizar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text);

create or replace function public.atualizar_pagamento(
  p_id uuid,
  p_fornecedor_id uuid,
  p_favorecido text,
  p_descricao text,
  p_valor numeric,
  p_vencimento date,
  p_forma_pagamento public.forma_pagamento,
  p_numero_documento text,
  p_observacoes text,
  p_motivo text default null,
  p_obra_id uuid default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  p public.pagamentos;
  v_nova_obra uuid;
  v_antes jsonb;
  v_depois jsonb;
  v_diff_antes jsonb;
  v_diff_depois jsonb;
  v_conteudo_mudou boolean;
  v_fechado boolean;
begin
  select * into p from public.pagamentos where id = p_id for update;
  if not found or not public.pode_ver_obra(p.obra_id) then
    raise exception 'Pagamento não encontrado.';
  end if;
  if p.status = 'cancelado' then
    raise exception 'Pagamentos cancelados não podem ser alterados.';
  end if;
  v_fechado := p.status in ('pago', 'aguardando_pagamento');
  if p.status = 'pago' and public.meu_perfil() not in ('financeiro', 'suprimentos') then
    raise exception 'Somente o Financeiro e o Suprimentos alteram pagamentos já pagos.' using errcode = '42501';
  end if;
  if not public.pode_atuar_obra(p.obra_id) then
    raise exception 'Você não tem permissão para alterar pagamentos desta obra.' using errcode = '42501';
  end if;

  v_nova_obra := coalesce(p_obra_id, p.obra_id);
  if v_nova_obra <> p.obra_id and not public.pode_atuar_obra(v_nova_obra) then
    raise exception 'Você não pode mover o pagamento para este centro de custo.' using errcode = '42501';
  end if;
  if (v_fechado or v_nova_obra <> p.obra_id) and nullif(trim(p_motivo), '') is null then
    raise exception 'Informe o motivo da alteração.';
  end if;

  v_antes := to_jsonb(p);
  update public.pagamentos set
    obra_id = v_nova_obra,
    fornecedor_id = p_fornecedor_id,
    favorecido = coalesce(nullif(trim(p_favorecido), ''), (select f.nome from public.fornecedores f where f.id = p_fornecedor_id), favorecido),
    descricao = trim(p_descricao),
    valor = p_valor,
    vencimento = p_vencimento,
    forma_pagamento = p_forma_pagamento,
    numero_documento = nullif(trim(p_numero_documento), ''),
    observacoes = nullif(trim(p_observacoes), '')
  where id = p_id;
  select to_jsonb(x) into v_depois from public.pagamentos x where x.id = p_id;

  select d.antes, d.depois into v_diff_antes, v_diff_depois from public._diff_jsonb(v_antes, v_depois) d;
  if v_diff_depois = '{}'::jsonb then
    return;
  end if;

  perform public._auditar('pagamento', p_id::text, 'alterou',
    'Dados do pagamento alterados' || coalesce('. Motivo: ' || nullif(trim(p_motivo), ''), ''),
    v_nova_obra, p_id, v_diff_antes, v_diff_depois);

  v_conteudo_mudou := exists (select 1 from jsonb_object_keys(v_diff_depois) k where k <> 'observacoes');
  if v_fechado then
    if public.meu_perfil() <> 'financeiro' then
      perform public._notificar_financeiro('Pagamento alterado após liberação',
        'Pagamento nº ' || p.numero || ' — ' || p.favorecido || ' foi alterado por ' || coalesce((select nome from public.profiles where id = auth.uid()), 'um usuário') || '. Motivo: ' || trim(p_motivo),
        '/pagamentos/' || p.id, p.id);
    end if;
  elsif v_conteudo_mudou then
    perform public._nova_versao(p_id, p_motivo);
  end if;
end
$$;

revoke all on function public.atualizar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text, uuid) from public, anon;
grant execute on function public.atualizar_pagamento(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text, uuid) to authenticated;
