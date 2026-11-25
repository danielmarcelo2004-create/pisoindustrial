-- Inteligência de Compras aberta, só para leitura, a todos os perfis (engenheiro, administrador, Suprimentos, Financeiro
-- e Administrador master): comparar o preço de um material entre obras, regiões e fornecedores ajuda quem negocia.
--
-- • A tela lê a visão compras_itens, que agora enxerga as notas de TODAS as obras (antes, o filtro de obra das
--   políticas do próprio usuário escondia as obras alheias).
-- • O CPF/CNPJ do fornecedor sai só para Financeiro, Suprimentos e Administrador master; os demais veem o nome.
-- • As tabelas nf_notas e nf_itens (que guardam o CNPJ e os dados fiscais completos) ficam restritas a quem
--   alimenta o módulo e ao Administrador master. Engenheiro e administrador leem só pela visão.

drop policy if exists nf_notas_select on public.nf_notas;
drop policy if exists nf_itens_select on public.nf_itens;
create policy nf_notas_select on public.nf_notas for select to authenticated
  using (public.meu_perfil() in ('financeiro', 'suprimentos', 'administrador_master'));
create policy nf_itens_select on public.nf_itens for select to authenticated
  using (public.meu_perfil() in ('financeiro', 'suprimentos', 'administrador_master'));

drop view if exists public.compras_itens;
create view public.compras_itens as
select
  i.id,
  i.nota_id,
  n.documento_id,
  n.pagamento_id,
  n.obra_id,
  o.nome as obra_nome,
  o.cidade,
  o.uf,
  n.data_emissao,
  n.numero as nf_numero,
  case when public.meu_perfil() in ('financeiro', 'suprimentos', 'administrador_master') then n.emitente_cnpj end as fornecedor_cnpj,
  n.emitente_nome as fornecedor_nome,
  n.origem,
  i.numero_item,
  i.codigo,
  i.descricao,
  i.descricao_normalizada,
  i.ncm,
  i.unidade,
  i.quantidade,
  i.valor_unitario,
  i.valor_total
from public.nf_itens i
join public.nf_notas n on n.id = i.nota_id and n.ativa
join public.obras o on o.id = n.obra_id
where public.meu_perfil() is not null;
revoke all on public.compras_itens from public, anon, authenticated;
grant select on public.compras_itens to authenticated;
