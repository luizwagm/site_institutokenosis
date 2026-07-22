#!/usr/bin/env bash
# ==========================================================================
#  deploy.sh — atualiza a Instituto Kenósis em produção sem arriscar o conteúdo
#
#  Uso:  sudo ./deploy.sh
#
#  O banco data/site.db é TODO o conteúdo do site (textos, serviços, projetos,
#  documentos, diretoria, fotos, acessos). Ele vive só no servidor — não
#  está no repositório. Por isso o deploy tira o banco do caminho ANTES do
#  git pull e devolve depois: nem um pull mal resolvido nem um commit antigo
#  que apaga o arquivo conseguem encostar nele.
#
#  Sequência: backup → inventário → parar → proteger → pull → devolver →
#             subir → conferir inventário → testar. Falhou, restaura sozinho.
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
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync("data/site.db");
      const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      console.log(`${n("services")} serviços · ${n("projetos")} projetos · ${n("documentos")} documentos · ${n("team")} diretoria · ${n("posts")} memórias · ${n("portfolio")} parceiros · ${n("settings")} textos · ${n("visits")} visitas`);
    } catch (e) { console.log("BANCO ILEGÍVEL: " + e.message); }
  ' 2>/dev/null
}

restaurar_e_sair() {
  vermelho "$1"
  if [ -f "$COFRE/site.db" ]; then
    mkdir -p data && cp "$COFRE/site.db" data/site.db
    amarelo "Banco devolvido do cofre temporário."
  elif [ -f "${BACKUP:-}" ]; then
    mkdir -p data && cp "$BACKUP" data/site.db
    amarelo "Banco restaurado do backup: $BACKUP"
  fi
  systemctl start "$SERVICO" 2>/dev/null
  rm -rf "$COFRE"
  exit 1
}

# ----------------------------------------------------------- 1. backup
azul "1/7  Backup do banco"
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/site.db.$(date +%Y-%m-%d_%H%M%S)"
if [ -f data/site.db ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 data/site.db ".backup '$BACKUP'" || cp data/site.db "$BACKUP"
  else
    cp data/site.db "$BACKUP"
  fi
  verde "     $BACKUP ($(du -h "$BACKUP" | cut -f1))"
  ls -1t "$BACKUP_DIR"/site.db.* 2>/dev/null | tail -n +$((MANTER_BACKUPS + 1)) | xargs -r rm --
else
  amarelo "     ainda não existe banco (primeira instalação)"
fi

# -------------------------------------------------------- 2. inventário
azul "2/7  Conteúdo atual"
ANTES=$(inventario)
echo "     $ANTES"

# ------------------------------------------------------------ 3. parar
azul "3/7  Parando o serviço"
systemctl stop "$SERVICO" 2>/dev/null
sleep 1
verde "     parado (o SQLite solta o arquivo antes de mexermos nele)"

# --------------------------------------------------------- 4. proteger
azul "4/7  Tirando banco e fotos do caminho do git"
mkdir -p "$COFRE"
[ -f data/site.db ] && mv data/site.db "$COFRE/site.db"
[ -d assets/img/uploads ] && cp -r assets/img/uploads "$COFRE/uploads"
verde "     guardados em $COFRE"

# ------------------------------------------------------------- 5. pull
azul "5/7  Baixando a versão nova"
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

# --------------------------------------------------------- 6. devolver
azul "6/7  Devolvendo banco e fotos"
mkdir -p data assets/img/uploads
[ -f "$COFRE/site.db" ] && mv "$COFRE/site.db" data/site.db
[ -d "$COFRE/uploads" ] && cp -rn "$COFRE/uploads/." assets/img/uploads/ 2>/dev/null

# O dono precisa ser o usuário do serviço, não um palpite: com o dono errado o
# SQLite responde "attempt to write a readonly database" e o painel não salva
# nada. O systemd sem User= significa root.
DONO=$(systemctl show "$SERVICO" -p User --value 2>/dev/null)
[ -z "$DONO" ] && DONO="root"
GRUPO=$(systemctl show "$SERVICO" -p Group --value 2>/dev/null)
[ -z "$GRUPO" ] && GRUPO="$DONO"
chown -R "$DONO:$GRUPO" data assets/img/uploads 2>/dev/null
# a pasta precisa ser gravável: o SQLite cria o -journal ao lado do banco
chmod 755 data assets/img/uploads 2>/dev/null
[ -f data/site.db ] && chmod 644 data/site.db
verde "     de volta no lugar (dono: $DONO:$GRUPO)"

systemctl start "$SERVICO"
sleep 3

# ----------------------------------------------------------- 7. testar
azul "7/7  Conferindo"
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
  echo "  Backup desta atualização: $BACKUP"
  echo "  Se mudou texto ou foto, entre no painel e clique em Publicar."
else
  echo
  vermelho "O site não respondeu (HTTP $CODIGO). Últimas linhas do log:"
  journalctl -u "$SERVICO" -n 25 --no-pager | sed 's/^/  /'
  echo
  amarelo "O banco está intacto em data/site.db e no backup:"
  amarelo "  $BACKUP"
  exit 1
fi
