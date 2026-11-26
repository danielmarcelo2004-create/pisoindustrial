-- Cadastro e edição de despesa numa única transação (auditoria A-05 e A-06).
-- Antes, a tela chamava várias funções separadas (competência, categoria, conta, parcelas, repetições, provisão):
-- se uma falhasse no meio, a despesa já existia incompleta (ou a edição ficava pela metade) e a mensagem não
-- dizia o que de fato foi gravado. Agora tudo entra junto ou nada entra. Os arquivos (boleto, nota) continuam
-- enviados em seguida, e a tela avisa se algum anexo falhar.

create or replace function public.criar_pagamento_completo(
  p_obra_id uuid,
  p_fornecedor_id uuid,
  p_favorecido text,
  p_descricao text,
  p_valor numeric,
  p_vencimento date,
  p_forma_pagamento public.forma_pagamento,
  p_categoria_id uuid,
  p_conta_id uuid,
  p_numero_documento text default '',
  p_observacoes text default '',
  p_competencia date default null,
  p_parcelas jsonb default null,
  p_repetir_intervalo integer default null,
  p_repetir_vezes integer default null,
  p_provisao_id uuid default null
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  v_id := public.criar_pagamento(p_obra_id, p_fornecedor_id, p_favorecido, p_descricao, p_valor, p_vencimento,
                                 p_forma_pagamento, p_numero_documento, p_observacoes);
  if p_competencia is not null then
    perform public.definir_competencia(v_id, p_competencia);
  end if;
  perform public.definir_categoria(v_id, p_categoria_id);
  perform public.definir_conta_bancaria(v_id, p_conta_id);
  if p_parcelas is not null and jsonb_typeof(p_parcelas) = 'array' and jsonb_array_length(p_parcelas) >= 2 then
    perform public.definir_parcelas(v_id, p_parcelas);
  end if;
  if p_repetir_intervalo is not null and p_repetir_vezes is not null then
    perform public.criar_repeticoes(v_id, p_repetir_intervalo, p_repetir_vezes);
  end if;
  if p_provisao_id is not null then
    perform public.lancar_provisao(p_provisao_id, v_id);
  end if;
  return v_id;
end
$$;
revoke all on function public.criar_pagamento_completo(uuid, uuid, text, text, numeric, date, public.forma_pagamento, uuid, uuid, text, text, date, jsonb, integer, integer, uuid) from public, anon;
grant execute on function public.criar_pagamento_completo(uuid, uuid, text, text, numeric, date, public.forma_pagamento, uuid, uuid, text, text, date, jsonb, integer, integer, uuid) to authenticated;

create or replace function public.atualizar_pagamento_completo(
  p_id uuid,
  p_fornecedor_id uuid,
  p_favorecido text,
  p_descricao text,
  p_valor numeric,
  p_vencimento date,
  p_forma_pagamento public.forma_pagamento,
  p_numero_documento text,
  p_observacoes text,
  p_motivo text default '',
  p_obra_id uuid default null,
  p_competencia date default null,
  p_categoria_id uuid default null,
  p_conta_id uuid default null,
  p_parcelas_editadas jsonb default null,
  p_reajustar_serie boolean default false
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- As parcelas vão primeiro (elas acertam o total e o vencimento); qualquer recusa desfaz tudo.
  if p_parcelas_editadas is not null and jsonb_typeof(p_parcelas_editadas) = 'array' and jsonb_array_length(p_parcelas_editadas) > 0 then
    perform public.editar_parcelas(p_id, p_parcelas_editadas, nullif(p_motivo, ''));
  end if;
  perform public.atualizar_pagamento(p_id, p_fornecedor_id, p_favorecido, p_descricao, p_valor, p_vencimento,
                                     p_forma_pagamento, p_numero_documento, p_observacoes, p_motivo, p_obra_id);
  if p_competencia is not null then
    perform public.definir_competencia(p_id, p_competencia);
  end if;
  if p_categoria_id is not null then
    perform public.definir_categoria(p_id, p_categoria_id);
  end if;
  if p_conta_id is not null then
    perform public.definir_conta_bancaria(p_id, p_conta_id);
  end if;
  if p_reajustar_serie then
    perform public.reajustar_serie(p_id, p_valor);
  end if;
end
$$;
revoke all on function public.atualizar_pagamento_completo(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text, uuid, date, uuid, uuid, jsonb, boolean) from public, anon;
grant execute on function public.atualizar_pagamento_completo(uuid, uuid, text, text, numeric, date, public.forma_pagamento, text, text, text, uuid, date, uuid, uuid, jsonb, boolean) to authenticated;

-- Usuário novo: perfil e acessos às obras na mesma transação (auditoria A-08). O login (Auth) é criado antes pelo
-- servidor; se esta função falhar, o servidor remove o login recém-criado e nada fica pela metade.
create or replace function public.criar_perfil_completo(
  p_id uuid, p_nome text, p_email text, p_telefone text, p_perfil public.perfil_usuario, p_obras uuid[]
) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_financeiro() then
    raise exception 'Somente o Financeiro cria usuários.' using errcode = '42501';
  end if;
  insert into public.profiles (id, nome, email, telefone, perfil, troca_senha_pendente)
  values (p_id, trim(p_nome), lower(trim(p_email)), nullif(trim(p_telefone), ''), p_perfil, true);
  if p_obras is not null and array_length(p_obras, 1) > 0 then
    insert into public.obra_acessos (obra_id, user_id)
    select distinct o, p_id from unnest(p_obras) as o;
  end if;
end
$$;
revoke all on function public.criar_perfil_completo(uuid, text, text, text, public.perfil_usuario, uuid[]) from public, anon;
grant execute on function public.criar_perfil_completo(uuid, text, text, text, public.perfil_usuario, uuid[]) to authenticated;
