-- Novo tipo de nota para a contabilidade: medição emitida pela empresa (boletim de medição).
-- Em arquivo próprio: o Postgres não deixa usar um valor de enum criado na mesma transação.
alter type public.categoria_nota_contabil add value if not exists 'medicao_emitida';
