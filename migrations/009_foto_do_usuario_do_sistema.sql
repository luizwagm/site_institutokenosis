-- ============================================================================
-- FOTO DO USUÁRIO DO SISTEMA
--
-- O retrato de quem opera o sistema (admin, secretaria, profissional). Guarda
-- o CAMINHO (/restrito/arquivos/…) devolvido pelo upload do próprio /restrito
-- — o arquivo mora no diretório privado, servido só com sessão, e é por isso
-- que o mesmo caminho serve de avatar no chat da equipe: o navegador de quem
-- está logado carrega a imagem autenticado, sem rota pública e sem token.
-- ============================================================================
ALTER TABLE g_usuarios ADD COLUMN IF NOT EXISTS foto TEXT;
