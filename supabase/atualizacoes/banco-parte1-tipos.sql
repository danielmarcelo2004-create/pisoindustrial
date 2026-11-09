-- PARTE 1 de 2: rode ESTE arquivo primeiro, sozinho, no SQL Editor do projeto de teste.
-- Adiciona valores novos aos tipos (o Postgres exige que isso rode separado).
alter type public.perfil_usuario add value if not exists 'administrador_master';
alter type public.tipo_documento add value if not exists 'documento_assinado';
alter type public.categoria_nota_contabil add value if not exists 'medicao_emitida';
