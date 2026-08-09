-- ===========================================================================
-- 007 — arquivar a PASTA e a PESSOA
--
-- ARQUIVAR NÃO É INATIVAR, E NÃO É ALTA. São três coisas, e misturá-las
-- destruiria informação de trabalho:
--
--   · `pacientes.ativo = 0`      — a pessoa PAROU de ser atendida. É fato do
--                                  acompanhamento, e a equipe precisa vê-lo na
--                                  lista para retomar contato. Sai das telas de
--                                  escolha, continua na relação, com etiqueta.
--   · `prontuario.status = Alta` — o acompanhamento naquele serviço TERMINOU.
--                                  Também é fato, também precisa ficar à vista.
--   · `arquivado = 1`            — decisão de ORGANIZAÇÃO da tela. Não diz nada
--                                  sobre a pessoa nem sobre o acompanhamento:
--                                  diz "tire isto da minha frente". Some da
--                                  lista, continua no banco, volta num clique.
--
-- Se `arquivar` reaproveitasse o `ativo`, arquivar alguém passaria a afirmar
-- que ela deixou de ser atendida — e a relação de inativos, que a coordenação
-- usa para retomar contato, encheria de gente que só foi arquivada por causa
-- da poluição da tela.
--
-- O NOME E O FORMATO VÊM DE DENTRO DA CASA: `prontuario_registros` já arquiva
-- assim desde a 006 (`arquivado` INTEGER 0/1 + `arquivado_em` TEXT). Inventar
-- um terceiro vocabulário para a mesma ideia obrigaria quem lê o código a
-- descobrir que são a mesma coisa.
--
-- Roda quantas vezes quiser.
-- ===========================================================================

-- ------------------------------------------------------------- a pessoa
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS arquivado    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS arquivado_em TEXT;

-- Quem já está cadastrado hoje NÃO está arquivado. Presumir o contrário
-- esvaziaria a tela de Usuários no primeiro boot depois da atualização — e o
-- primeiro pensamento de quem visse isso seria que o banco se perdeu.
UPDATE pacientes SET arquivado = 0 WHERE arquivado IS NULL;

-- -------------------------------------------------------------- a pasta
ALTER TABLE prontuario ADD COLUMN IF NOT EXISTS arquivado    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE prontuario ADD COLUMN IF NOT EXISTS arquivado_em TEXT;
UPDATE prontuario SET arquivado = 0 WHERE arquivado IS NULL;

-- ------------------------------------------------------------- índices
-- Toda listagem destas duas telas passou a carregar `arquivado = 0`. Índice
-- PARCIAL: só as linhas que ficam à vista entram nele, que são justamente as
-- que as consultas do dia a dia procuram. As arquivadas só são lidas na tela
-- de Arquivados, que ninguém abre com pressa.
CREATE INDEX IF NOT EXISTS idx_pac_arquivado  ON pacientes(id)  WHERE arquivado = 0;
CREATE INDEX IF NOT EXISTS idx_pron_arquivado ON prontuario(id) WHERE arquivado = 0;

COMMENT ON COLUMN pacientes.arquivado IS
  'Organização da tela: 1 some da lista. NÃO significa inativo — para isso existe `ativo`.';
COMMENT ON COLUMN prontuario.arquivado IS
  'Organização da tela: 1 some da lista. NÃO significa alta — para isso existe `status`.';
