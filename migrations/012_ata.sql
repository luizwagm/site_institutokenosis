-- ============================================================================
-- ATA — a lista de presença de uma reunião, assinada no papel
--
-- Irmã da FREQUÊNCIA (migration 008), e pela mesma razão de ser: o sistema
-- monta a folha, o papel recebe as assinaturas. A coluna "Assinatura" sai em
-- BRANCO de propósito — ninguém assina dentro do sistema.
--
-- ---------------------------------------------------------------------------
-- POR QUE NÃO É UMA FREQUÊNCIA COM OUTRO NOME
--
-- A frequência é de um MÊS e tem uma coluna por dia de aula: a mesma pessoa
-- assina oito vezes na mesma folha. A ata é de UMA reunião: tem dia, hora e
-- uma assinatura por presente. Encaixar as duas na mesma tabela obrigaria a
-- coluna `mes` a guardar dia às vezes, e a lista de dias a ficar vazia sempre
-- — dado com dois significados é dado que ninguém consegue consultar depois.
--
-- ---------------------------------------------------------------------------
-- O TÍTULO É TEXTO, NÃO CHAVE (1.35.1)
--
-- Nasceu preso à lista de projetos, como na frequência. Durou uma versão: aula
-- é sempre de um projeto, mas REUNIÃO não — assembleia de associados, diretoria
-- e conselho fiscal não pertencem a projeto nenhum. Guardar aqui um id de
-- projeto obrigaria a inventar um projeto falso para cada uma dessas.
-- Por isso a coluna é TEXT e não referencia `projetos`: a tela oferece os
-- projetos cadastrados como sugestão, e quem precisa escreve o assunto.
--
-- ---------------------------------------------------------------------------
-- QUEM ESTÁ NA LISTA
--
-- `participantes` é JSON, como na frequência, e aceita DUAS formas:
--
--   12                      → id do cadastro de usuários (pacientes)
--   {"nome":"Fulano"}       → convidado, que não está em cadastro nenhum
--
-- O cadastrado entra como ID, nunca como cópia de nome: o cadastro é a fonte,
-- e a folha imprime o que está nele hoje. O convidado é a exceção necessária —
-- ele não existe em lugar nenhum para ser referenciado, então a ata é o único
-- registro dele. Guarda-se o NOME e só: CPF de convidado ficaria fora da
-- cifragem da tabela de pacientes, exatamente o que a migration 008 evitou.
--
-- ---------------------------------------------------------------------------
-- SEM ÍNDICE ÚNICO, pela mesma razão da 010: podem existir duas reuniões no
-- mesmo dia e no mesmo lugar (manhã e tarde, dois grupos). Quem identifica a
-- ata é o id; `local` e `hora` é que a distinguem na lista, para os olhos.
-- ============================================================================
CREATE TABLE IF NOT EXISTS atas (
  id            SERIAL PRIMARY KEY,
  titulo        TEXT NOT NULL DEFAULT '',    -- assunto livre; os projetos entram como sugestão
  data          TEXT NOT NULL DEFAULT '',    -- AAAA-MM-DD, o dia da reunião
  hora          TEXT NOT NULL DEFAULT '',    -- HH:MM (opcional)
  local         TEXT NOT NULL DEFAULT '',    -- onde foi
  participantes TEXT NOT NULL DEFAULT '[]',  -- ids de pacientes e/ou {"nome":"…"}
  criado        TEXT
);

-- A lista abre pela data, da mais nova para a mais velha; o índice existe para
-- essa consulta, que é a única que a tela faz.
CREATE INDEX IF NOT EXISTS atas_data ON atas (data);
