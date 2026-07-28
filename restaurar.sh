#!/usr/bin/env bash
# ==========================================================================
#  restaurar.sh — devolve um backup ao lugar
#
#  Uso:  sudo ./restaurar.sh                 lista os backups disponíveis
#        sudo ./restaurar.sh gestao          restaura o gestao.db mais recente
#        sudo ./restaurar.sh gestao ARQUIVO  restaura um backup específico
#
#  O que ele faz antes de sobrescrever qualquer coisa:
#   1. confere a integridade do backup escolhido (não restaura cópia quebrada);
#   2. guarda o banco ATUAL como .antes-da-restauracao — se a restauração for
#      um engano, o estado de agora não se perde;
#   3. para o serviço, troca o arquivo, ajusta dono e sobe de volta.
#
#  Restaurar o gestao.db devolve prontuários e anamneses ao estado do backup —
#  ou seja, TUDO que foi lançado depois daquela cópia se perde. Por isso o
#  script pede confirmação e mostra a data do backup antes de agir.
# ==========================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-kenosis.service}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
cd "$APP_DIR" || { echo "Diretório $APP_DIR não existe"; exit 1; }

azul()    { printf "\033[1;34m%s\033[0m\n" "$1"; }
verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

# O nome e a extensão do backup dependem do MOTOR:
#   site   → SQLite  → backups/site.AAAAMMDD-HHMMSS.db     (cópia do arquivo)
#   gestao → Postgres→ backups/<database>.AAAAMMDD-HHMMSS.sql (dump do pg_dump)
PGDATABASE_NOME="${PGDATABASE:-kenosis_gestao}"
prefixo() { [ "$1" = "gestao" ] && echo "$PGDATABASE_NOME" || echo "site"; }
extensao() { [ "$1" = "gestao" ] && echo "sql" || echo "db"; }

listar() {
  for b in site gestao; do
    azul "  $b  ($([ "$b" = "gestao" ] && echo "PostgreSQL, .sql" || echo "SQLite, .db"))"
    local achou=0
    while IFS= read -r f; do
      achou=1
      printf "    %s  %s\n" "$(date -r "$f" '+%d/%m/%Y %H:%M')" "$(basename "$f")"
    done < <(ls -1t "$BACKUP_DIR/$(prefixo "$b")."*".$(extensao "$b")" 2>/dev/null | head -15)
    [ "$achou" = "0" ] && echo "    (nenhum backup ainda)"
  done
}

BANCO="${1:-}"
if [ -z "$BANCO" ]; then
  echo
  azul "Backups disponíveis em $BACKUP_DIR"
  echo
  listar
  echo
  echo "  Para restaurar:  sudo ./restaurar.sh gestao"
  echo "                   sudo ./restaurar.sh site"
  echo
  exit 0
fi

case "$BANCO" in
  site|gestao) ;;
  *) vermelho "Banco inválido: '$BANCO'. Use 'site' ou 'gestao'."; exit 1 ;;
esac

ARQ="${2:-}"
[ -z "$ARQ" ] && ARQ=$(ls -1t "$BACKUP_DIR/$(prefixo "$BANCO")."*".$(extensao "$BANCO")" 2>/dev/null | head -1)
[ -n "$ARQ" ] && [ ! -f "$ARQ" ] && [ -f "$BACKUP_DIR/$ARQ" ] && ARQ="$BACKUP_DIR/$ARQ"
if [ -z "$ARQ" ] || [ ! -f "$ARQ" ]; then
  vermelho "Não encontrei backup de $BANCO em $BACKUP_DIR"
  exit 1
fi

# ------------------------------------------- 1. o backup presta?
azul "1/4  Conferindo o backup"
if [ "$BANCO" = "gestao" ]; then
  # Um dump SQL não tem "integrity_check". O que dá para conferir antes de
  # restaurar é se o arquivo é MESMO um dump completo do pg_dump: ele começa
  # com o cabeçalho conhecido e termina com a linha de conclusão. Dump cortado
  # no meio (disco cheio, processo morto) não tem o final — e restaurá-lo
  # deixaria o banco pela metade.
  if ! head -5 "$ARQ" | grep -q "PostgreSQL database dump"; then
    vermelho "     Este arquivo não parece um dump do pg_dump. Nada foi alterado."
    exit 1
  fi
  if ! tail -5 "$ARQ" | grep -q "PostgreSQL database dump complete"; then
    vermelho "     Dump INCOMPLETO (falta a marca de conclusão) — foi cortado no meio."
    amarelo  "     Tente outro:  sudo ./restaurar.sh gestao"
    exit 1
  fi
  TABELAS=$(grep -c "^CREATE TABLE" "$ARQ")
  verde "     dump completo · $TABELAS tabelas · $(du -h "$ARQ" | cut -f1) · de $(date -r "$ARQ" '+%d/%m/%Y %H:%M')"
else
  VEREDITO=$(node -e '
    const { abrirBanco } = require("./db");
    try {
      const d = abrirBanco(process.argv[1]);
      const r = d.prepare("PRAGMA integrity_check").get();
      const v = r ? (r.integrity_check || Object.values(r)[0]) : "sem resposta";
      const t = d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type=\x27table\x27").get().c;
      d.close();
      console.log(v + "|" + t);
    } catch (e) { console.log("ILEGÍVEL: " + e.message + "|0"); }
  ' "$ARQ" 2>/dev/null)
  INTEG="${VEREDITO%%|*}"; TABELAS="${VEREDITO##*|}"
  if [ "$INTEG" != "ok" ]; then
    vermelho "     Este backup NÃO está íntegro ($INTEG). Nada foi alterado."
    amarelo "     Tente outro:  sudo ./restaurar.sh $BANCO"
    exit 1
  fi
  verde "     íntegro · $TABELAS tabelas · $(du -h "$ARQ" | cut -f1) · de $(date -r "$ARQ" '+%d/%m/%Y %H:%M')"
fi

# ------------------------------------------- 2. confirmação
echo
if [ "$BANCO" = "gestao" ]; then
  amarelo "  Vai substituir  o banco PostgreSQL '$PGDATABASE_NOME'"
else
  amarelo "  Vai substituir  data/site.db"
fi
amarelo "  pelo backup de  $(date -r "$ARQ" '+%d/%m/%Y às %H:%M')"
if [ "$BANCO" = "gestao" ]; then
  vermelho "  ATENÇÃO: prontuários, anamneses e agendamentos lançados DEPOIS"
  vermelho "  dessa data serão perdidos."
fi
echo
printf "  Digite RESTAURAR para confirmar: "
read -r RESP
[ "$RESP" = "RESTAURAR" ] || { amarelo "Cancelado. Nada foi alterado."; exit 0; }

# ------------------------------------------- 3. troca
azul "2/4  Parando o serviço"
systemctl stop "$SERVICO" 2>/dev/null
sleep 1

azul "3/4  Guardando o banco atual e trocando"
if [ "$BANCO" = "gestao" ]; then
  # Antes de sobrescrever, um dump do estado ATUAL. É o desfazer da restauração:
  # sem ele, quem restaurou o backup errado perde o que estava no ar.
  SEGURANCA="$BACKUP_DIR/$PGDATABASE_NOME.antes-da-restauracao.$(date +%Y-%m-%d_%H%M%S).sql"
  if node -e '
      const { dumparPostgres } = require("./backup");
      const { config, carregarAmbiente } = require("./pg");
      carregarAmbiente();
      const r = dumparPostgres({ postgres: config() }, process.argv[1]);
      if (!r.ok) { console.error(r.erro); process.exit(1); }
      require("node:fs").renameSync(r.arquivo, process.argv[2]);
    ' "$BACKUP_DIR" "$SEGURANCA" 2>&1 | sed 's/^/     /'; then
    verde "     estado de agora guardado em $(basename "$SEGURANCA")"
  else
    vermelho "     NÃO consegui salvar o estado atual. Restauração cancelada."
    amarelo  "     (sem esse dump, um engano aqui seria irreversível)"
    systemctl start "$SERVICO"; exit 1
  fi

  # O dump é gerado com --clean --if-exists: ele mesmo apaga e recria tudo.
  # ON_ERROR_STOP faz o psql parar no primeiro erro em vez de seguir adiante e
  # deixar o banco meio restaurado.
  if PGPASSWORD="${PGPASSWORD:-}" psql -v ON_ERROR_STOP=1 \
       -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U "${PGUSER:-kenosis}" \
       -d "$PGDATABASE_NOME" -q -f "$ARQ" 2>&1 | sed 's/^/     /'; then
    verde "     restaurado no PostgreSQL"
  else
    vermelho "     A RESTAURAÇÃO FALHOU. O banco pode estar incompleto."
    amarelo  "     Volte ao estado anterior com:"
    amarelo  "       psql -U ${PGUSER:-kenosis} -d $PGDATABASE_NOME -f $SEGURANCA"
    exit 1
  fi
else
  if [ -f "data/site.db" ]; then
    SEGURANCA="$BACKUP_DIR/site.antes-da-restauracao.$(date +%Y-%m-%d_%H%M%S).db"
    cp "data/site.db" "$SEGURANCA"
    verde "     estado de agora guardado em $(basename "$SEGURANCA")"
  fi
  # o WAL do banco antigo não pode sobreviver ao arquivo novo: seria aplicado
  # por cima e corromperia a restauração
  rm -f "data/site.db-wal" "data/site.db-shm"
  cp "$ARQ" "data/site.db"

  DONO=$(systemctl show "$SERVICO" -p User --value 2>/dev/null); [ -z "$DONO" ] && DONO="root"
  GRUPO=$(systemctl show "$SERVICO" -p Group --value 2>/dev/null); [ -z "$GRUPO" ] && GRUPO="$DONO"
  chown "$DONO:$GRUPO" "data/site.db" 2>/dev/null
  chmod 644 "data/site.db"
  verde "     restaurado (dono: $DONO:$GRUPO)"
fi

# ------------------------------------------- 4. sobe e confere
azul "4/4  Subindo o serviço"
systemctl start "$SERVICO"
sleep 3
PORTA="${PORTA:-5189}"
CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORTA/" || echo 000)
echo
if [ "$CODIGO" = "200" ]; then
  verde "Restauração concluída — sistema no ar."
  [ -n "${SEGURANCA:-}" ] && echo "  O estado anterior continua em: $SEGURANCA"
else
  vermelho "O sistema não respondeu (HTTP $CODIGO). Log:"
  journalctl -u "$SERVICO" -n 25 --no-pager | sed 's/^/  /'
  exit 1
fi
