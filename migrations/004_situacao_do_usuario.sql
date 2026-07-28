-- ===========================================================================
-- 004 — situação do usuário atendido (ativo / inativo)
--
-- Até aqui, tirar alguém do atendimento só era possível EXCLUINDO o cadastro —
-- e junto iam o prontuário, os benefícios recebidos e todo o histórico. Numa
-- OSC isso é perda de memória institucional: o registro de quem foi atendido é
-- o que sustenta prestação de contas e relatório de projeto.
--
-- Inativar é o "arquivar" da ficha: a pessoa sai das telas de escolha (agenda,
-- prontuário, benefícios) e da lista de ativos, mas NADA é apagado. Reativar
-- devolve tudo.
--
-- `ativo` entra com DEFAULT 1 e é preenchido em quem já existe: quem está
-- cadastrado hoje está ativo — presumir o contrário sumiria com o cadastro
-- inteiro da tela no primeiro acesso depois da atualização.
-- ===========================================================================

ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS ativo          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS inativo_em     TEXT;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS inativo_motivo TEXT;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS reativado_em   TEXT;

UPDATE pacientes SET ativo = 1 WHERE ativo IS NULL;

-- A relação de ativos/inativos é uma das telas mais usadas para retomar
-- contato; sem índice ela varreria a tabela toda a cada abertura.
CREATE INDEX IF NOT EXISTS idx_pac_ativo ON pacientes(ativo);
