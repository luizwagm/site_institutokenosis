-- ===========================================================================
-- 003 — de quem é o prontuário
--
-- REGRA: o profissional vê APENAS os prontuários dele. Não pode, em hipótese
-- alguma, ver os de outro profissional.
--
-- O QUE EXISTIA E POR QUE NÃO SERVIA:
--
--  · `usuario_id` — guarda QUEM CRIOU o registro. Erra nos dois sentidos: se a
--    recepção lança o atendimento, o profissional deixa de ver o próprio
--    prontuário; e se um profissional cadastra algo para outro, passa a ver o
--    que não é dele. É registro de autoria, não de responsabilidade.
--
--  · `profissional` (TEXT) — guarda o NOME digitado. Comparar nome é frágil:
--    muda a grafia, entra um "Dr.", e o registro escapa do filtro. Um recorte
--    de acesso não pode depender de string livre.
--
-- `profissional_id` aponta para a tabela `profissionais` e é o mesmo vínculo
-- que a agenda já usa (g_usuarios.profissional_id → atendimentos.profissional_id).
-- É o que torna o recorte verificável.
-- ===========================================================================

ALTER TABLE prontuario ADD COLUMN IF NOT EXISTS profissional_id INTEGER;

-- Preenche os registros que já existem, casando pelo NOME do profissional.
-- É a única ligação disponível no histórico. O que não casar fica NULL — e
-- NULL, na regra nova, significa "sem dono", que NENHUM profissional vê.
-- É o lado seguro do erro: esconder demais se conserta atribuindo o registro;
-- mostrar de menos não expõe prontuário de ninguém.
UPDATE prontuario SET profissional_id = pf.id
  FROM profissionais pf
 WHERE prontuario.profissional_id IS NULL
   AND prontuario.profissional IS NOT NULL
   AND TRIM(prontuario.profissional) <> ''
   AND LOWER(TRIM(pf.nome)) = LOWER(TRIM(prontuario.profissional));

-- Segunda tentativa para o que sobrou: o registro pode não ter o nome digitado,
-- mas ter sido criado por um login que É de um profissional. Aí a autoria vale
-- como responsabilidade — é o mesmo vínculo, visto do outro lado.
UPDATE prontuario SET profissional_id = u.profissional_id
  FROM g_usuarios u
 WHERE prontuario.profissional_id IS NULL
   AND prontuario.usuario_id = u.id
   AND u.profissional_id IS NOT NULL;

-- O filtro por dono passa a entrar em quase toda consulta de prontuário: sem
-- índice, cada tela do profissional varreria a tabela inteira.
CREATE INDEX IF NOT EXISTS idx_pront_prof ON prontuario(profissional_id);
