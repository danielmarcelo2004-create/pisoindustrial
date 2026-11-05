-- Novo perfil: Administrador master (precisa estar gravado antes de ser usado nas regras).
alter type public.perfil_usuario add value if not exists 'administrador_master';
