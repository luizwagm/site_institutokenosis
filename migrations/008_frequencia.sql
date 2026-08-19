-- ============================================================================
-- FREQUÊNCIA — a folha de assinaturas das aulas (hidroginástica)
--
-- Uma folha por TURMA + MÊS, montada na tela e impressa para colher as
-- assinaturas no papel. A folha guarda REFERÊNCIAS às pessoas (ids de
-- pacientes), nunca cópia de nome ou CPF: o cadastro é a fonte, e a folha
-- imprime sempre o que está nele hoje. Copiar o CPF para cá também criaria um
-- segundo lugar com dado sensível, fora da cifragem da tabela de pacientes.
--
-- `datas` são os dias do mês escolhidos pela equipe (duas aulas por semana,
-- 8 a 10 colunas conforme o mês) — texto JSON, como as outras listas do
-- sistema (especialidade da agenda, fotos de eventos).
-- ============================================================================
CREATE TABLE IF NOT EXISTS frequencias (
  id            SERIAL PRIMARY KEY,
  turma         TEXT NOT NULL DEFAULT '',    -- "07h às 08h"
  mes           TEXT NOT NULL DEFAULT '',    -- AAAA-MM
  datas         TEXT NOT NULL DEFAULT '[]',  -- dias do mês: ["04","06",...]
  participantes TEXT NOT NULL DEFAULT '[]',  -- ids de pacientes, na ordem da folha
  criado        TEXT
);

-- Uma folha só por turma e mês: é o banco quem garante, a tela só explica.
CREATE UNIQUE INDEX IF NOT EXISTS frequencias_turma_mes ON frequencias (turma, mes);
