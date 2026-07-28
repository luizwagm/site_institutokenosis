#!/usr/bin/env bash
# ==========================================================================
#  deploy.sh — atualiza a Instituto-Kenosis em produção sem arriscar o conteúdo
#
#  Uso:  sudo ./deploy.sh
#
#  O banco data/site.db é TODO o conteúdo do site (textos, especialidades,
#  profissionais, fotos, depoimentos, acessos). Ele vive só no servidor — não
#  está no repositório. Por isso o deploy tira o banco do caminho ANTES do
#  git pull e devolve depois: nem um pull mal resolvido nem um commit antigo
#  que apaga o arquivo conseguem encostar nele.
#
#  Sequência: backup → inventário → parar → proteger → pull → dependências →
#             devolver → subir → conferir inventário → testar.
#             Falhou, restaura sozinho.
#
#  Este backup é o do DEPLOY (uma foto antes de mexer). O sistema também tira
#  um backup DIÁRIO sozinho, na mesma pasta backups/ — ver backup.js.
# ==========================================================================
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-kenosis.service}"
PORTA="${PORTA:-5189}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
MANTER_BACKUPS=20
COFRE="/tmp/kenosis-deploy-$$"

cd "$APP_DIR" || { echo "Diretório $APP_DIR não existe"; exit 1; }

azul()    { printf "\033[1;34m%s\033[0m\n" "$1"; }
verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

# Conta o que existe no banco — serve para provar, no fim, que nada sumiu
inventario() {
  [ -f data/site.db ] || { echo "SEM BANCO"; return; }
  node -e '
    const { abrirBanco } = require("./db");
    try {
      const db = abrirBanco("data/site.db");
      const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      console.log(`${n("services")} especialidades · ${n("team")} profissionais · ${n("posts")} matérias · ${n("portfolio")} fotos · ${n("testimonials")} depoimentos · ${n("settings")} textos · ${n("visits")} visitas`);
    } catch (e) { console.log("BANCO ILEGÍVEL: " + e.message); }
  ' 2>/dev/null
}

restaurar_e_sair() {
  vermelho "$1"
  if [ -f "$COFRE/site.db" ]; then
    mkdir -p data && cp "$COFRE/site.db" data/site.db
    [ -f "$COFRE/gestao.db" ] && cp "$COFRE/gestao.db" data/gestao.db
    amarelo "Bancos devolvidos do cofre temporário."
  elif [ -f "${BACKUP:-}" ]; then
    mkdir -p data && cp "$BACKUP" data/site.db
    amarelo "Banco restaurado do backup: $BACKUP"
  fi
  systemctl start "$SERVICO" 2>/dev/null
  rm -rf "$COFRE"
  exit 1
}

# ----------------------------------------------------------- 1. backup
# Usa o próprio backup.js. Dois motores, duas técnicas:
#   · site.db  (SQLite)     → VACUUM INTO + integrity_check na cópia
#   · gestão   (PostgreSQL) → pg_dump em .sql
# A gestão guarda prontuário e cadastro, dado pessoal SENSÍVEL (LGPD).
azul "1/8  Backup dos bancos"
mkdir -p "$BACKUP_DIR"
if [ -f data/site.db ] || [ -f data/gestao.db ]; then
  if node server.js --backup 2>&1 | sed 's/^/  /'; then
    :
  else
    amarelo "     backup pelo sistema falhou — caindo para cópia simples"
    for b in site gestao; do
      [ -f "data/$b.db" ] && cp "data/$b.db" "$BACKUP_DIR/$b.$(date +%Y-%m-%d_%H%M%S).db"
    done
  fi
  # o mais recente serve de âncora para o restaurar_e_sair
  BACKUP=$(ls -1t "$BACKUP_DIR"/site.*.db 2>/dev/null | head -1)
  for b in site gestao; do
    ls -1t "$BACKUP_DIR/$b."*.db 2>/dev/null | tail -n +$((MANTER_BACKUPS + 1)) | xargs -r rm --
  done
else
  amarelo "     ainda não existem bancos (primeira instalação)"
fi

# -------------------------------------------------------- 2. inventário
azul "2/8  Conteúdo atual"
ANTES=$(inventario)
echo "     $ANTES"

# ------------------------------------------------------------ 3. parar
azul "3/8  Parando o serviço"
systemctl stop "$SERVICO" 2>/dev/null
sleep 1
verde "     parado (o SQLite solta o arquivo antes de mexermos nele)"

# --------------------------------------------------------- 4. proteger
azul "4/8  Tirando banco e fotos do caminho do git"
mkdir -p "$COFRE"
[ -f data/site.db ] && mv data/site.db "$COFRE/site.db"
# gestao.db = prontuário/anamnese dos pacientes. Sai do caminho do git igual.
[ -f data/gestao.db ] && mv data/gestao.db "$COFRE/gestao.db"
for wal in data/site.db-wal data/site.db-shm data/gestao.db-wal data/gestao.db-shm; do
  [ -f "$wal" ] && mv "$wal" "$COFRE/$(basename "$wal")"
done
[ -d assets/img/uploads ] && cp -r assets/img/uploads "$COFRE/uploads"
# anexos de prontuário/documentos dos pacientes
[ -d restrito/arquivos ] && cp -r restrito/arquivos "$COFRE/arquivos"
verde "     guardados em $COFRE"

# ------------------------------------------------------------- 5. pull
azul "5/8  Baixando a versão nova"
DE=$(git rev-parse --short HEAD)
if ! git pull --ff-only; then
  restaurar_e_sair "     git pull falhou — nada foi alterado."
fi
PARA=$(git rev-parse --short HEAD)
if [ "$DE" = "$PARA" ]; then
  amarelo "     já estava atualizado ($PARA)"
else
  verde "     $DE → $PARA"
  git log --oneline "$DE..$PARA" | sed 's/^/       /'
fi

# ---------------------------------------------------- 6. dependências
# O projeto usa o better-sqlite3 (driver estável do SQLite). Se o pull trouxe
# package.json novo, é aqui que ele é instalado — antes de o serviço subir.
# Não é fatal: sem a pasta node_modules o db.js volta sozinho para o driver de
# fábrica do Node e o sistema continua no ar, só com o aviso.
azul "6/8  Dependências"
if [ -f package.json ]; then
  if command -v npm >/dev/null 2>&1; then
    if npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund; then
      verde "     node_modules em dia"
    else
      # O `pg` NÃO tem alternativa: sem ele o /restrito não conecta e o serviço
      # não sobe. Diferente do better-sqlite3, que tinha o driver de fábrica do
      # Node como reserva. Por isso aqui é ERRO, não aviso.
      vermelho "     npm install FALHOU — sem o pacote 'pg' o /restrito não sobe"
      amarelo  "     tente à mão: npm ci --omit=dev   (e confira a rede do servidor)"
    fi
  else
    vermelho "     npm não encontrado — instale com: apt install -y npm"
  fi
else
  amarelo "     sem package.json (versão antiga) — nada a instalar"
fi

# ------------------------------------------------- 6b. migrations do Postgres
# O esquema do /restrito vive em migrations/*.sql. O boot do serviço já aplica o
# que falta, mas rodar AQUI é melhor: se uma migração falhar, o erro aparece no
# deploy, com o serviço ainda parado — e não num restart que não sobe.
azul "6b/8 Migrations do PostgreSQL"
if [ -f migrar.js ]; then
  if node migrar.js 2>&1 | sed 's/^/     /'; then
    verde "     esquema em dia"
  else
    vermelho "     MIGRATION FALHOU — o /restrito não vai subir. Corrija antes de seguir."
    amarelo  "     detalhes: node migrar.js --status"
  fi
else
  amarelo "     sem migrar.js (versão anterior ao PostgreSQL)"
fi

# --------------------------------------------------------- 7. devolver
azul "7/8  Devolvendo banco e fotos"
mkdir -p data assets/img/uploads restrito/arquivos
[ -f "$COFRE/site.db" ] && mv "$COFRE/site.db" data/site.db
[ -f "$COFRE/gestao.db" ] && mv "$COFRE/gestao.db" data/gestao.db
for wal in site.db-wal site.db-shm gestao.db-wal gestao.db-shm; do
  [ -f "$COFRE/$wal" ] && mv "$COFRE/$wal" "data/$wal"
done
[ -d "$COFRE/uploads" ] && cp -rn "$COFRE/uploads/." assets/img/uploads/ 2>/dev/null
[ -d "$COFRE/arquivos" ] && cp -rn "$COFRE/arquivos/." restrito/arquivos/ 2>/dev/null

# O dono precisa ser o usuário do serviço, não um palpite: com o dono errado o
# SQLite responde "attempt to write a readonly database" e o painel não salva
# nada. O systemd sem User= significa root.
DONO=$(systemctl show "$SERVICO" -p User --value 2>/dev/null)
[ -z "$DONO" ] && DONO="root"
GRUPO=$(systemctl show "$SERVICO" -p Group --value 2>/dev/null)
[ -z "$GRUPO" ] && GRUPO="$DONO"
chown -R "$DONO:$GRUPO" data assets/img/uploads restrito/arquivos 2>/dev/null
# a pasta precisa ser gravável: o SQLite cria o -journal ao lado do banco
chmod 755 data assets/img/uploads restrito/arquivos 2>/dev/null
[ -f data/site.db ] && chmod 644 data/site.db
verde "     de volta no lugar (dono: $DONO:$GRUPO)"

systemctl start "$SERVICO"
sleep 3

# ----------------------------------------------------------- 7. testar
azul "8/8  Conferindo"
DEPOIS=$(inventario)
echo "     antes : $ANTES"
echo "     depois: $DEPOIS"
if [ "$ANTES" != "$DEPOIS" ] && [ "$ANTES" != "SEM BANCO" ]; then
  # a contagem de visitas muda sozinha; só alerta se o conteúdo mudou
  A_SEM_VISITAS="${ANTES%· *}"; D_SEM_VISITAS="${DEPOIS%· *}"
  if [ "$A_SEM_VISITAS" != "$D_SEM_VISITAS" ]; then
    restaurar_e_sair "     O CONTEÚDO MUDOU. Restaurando por segurança."
  fi
fi

OK=0
for _ in $(seq 1 10); do
  CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORTA/" || echo 000)
  [ "$CODIGO" = "200" ] && { OK=1; break; }
  sleep 2
done

rm -rf "$COFRE"

if [ "$OK" = "1" ]; then
  VERSAO=$(curl -s "http://127.0.0.1:$PORTA/admin/" | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' | head -1)
  echo
  verde "Deploy concluído — site no ar, gerenciador $VERSAO"
  echo "  Backup desta atualização: ${BACKUP:-nenhum (primeira instalação)}"
  echo "  Se mudou texto ou foto, entre no painel e clique em Publicar."
  echo
  echo "  Backup automático (diário, dentro do serviço):"
  node server.js --backup-status 2>/dev/null | sed 's/^/    /'
else
  echo
  vermelho "O site não respondeu (HTTP $CODIGO). Últimas linhas do log:"
  journalctl -u "$SERVICO" -n 25 --no-pager | sed 's/^/  /'
  echo
  amarelo "O banco está intacto em data/site.db e no backup:"
  amarelo "  ${BACKUP:-(sem backup — primeira instalação)}"
  exit 1
fi
