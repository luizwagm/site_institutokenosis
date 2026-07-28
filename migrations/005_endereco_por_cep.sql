-- ===========================================================================
-- 005 — endereço em partes, preenchido pelo CEP
--
-- `endereco` era um campo de texto livre: cada pessoa da equipe escrevia de um
-- jeito ("R. José, 12 - Maurício de Nassau", "Rua José de Alencar nº 12,
-- Mauricio"). Assim não dá para agrupar por bairro num relatório de projeto,
-- nem conferir se a família mora na área de abrangência — que é exatamente o
-- tipo de pergunta que a prestação de contas faz.
--
-- As partes novas convivem com `endereco`: ele continua guardando o LOGRADOURO
-- e todo o cadastro antigo segue legível, sem conversão arriscada de texto
-- livre. O que a equipe digitou continua onde estava.
-- ===========================================================================

ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS cep         TEXT;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS numero      TEXT;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS bairro      TEXT;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS cidade      TEXT;
ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS complemento TEXT;

ALTER TABLE associados ADD COLUMN IF NOT EXISTS cep         TEXT;
ALTER TABLE associados ADD COLUMN IF NOT EXISTS numero      TEXT;
ALTER TABLE associados ADD COLUMN IF NOT EXISTS bairro      TEXT;
ALTER TABLE associados ADD COLUMN IF NOT EXISTS cidade      TEXT;
ALTER TABLE associados ADD COLUMN IF NOT EXISTS complemento TEXT;
