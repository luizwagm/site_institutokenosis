-- ============================================================================
-- FREQUÊNCIA: pode haver MAIS DE UMA folha para a mesma turma no mesmo mês
-- (decisão do cliente, 19/08/2026). Turma + mês deixam de identificar a
-- folha — quem identifica é o id, e a tela abre cada folha pela lista.
-- ============================================================================
DROP INDEX IF EXISTS frequencias_turma_mes;
