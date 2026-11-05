-- Novo tipo de documento: versão assinada de um documento (o original é preservado).
alter type public.tipo_documento add value if not exists 'documento_assinado';
