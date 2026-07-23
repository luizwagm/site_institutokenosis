#!/usr/bin/env bash
# ==========================================================================
#  verificar.sh — só olha, não altera nada.
#  Rode ANTES do deploy para saber em que estado a produção está.
# ==========================================================================
APP_DIR="${APP_DIR:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SERVICO="${SERVICO:-kenosis.service}"
PORTA="${PORTA:-5189}"
cd "$APP_DIR" || exit 1

echo "===================== ESTADO DA PRODUÇÃO ====================="
echo
echo "Commit atual : $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"
echo "Node         : $(node -v)"
echo "Serviço      : $(systemctl is-active "$SERVICO" 2>/dev/null)"
printf "Site         : HTTP %s\n" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORTA/")"
echo

echo "--- O banco corre risco no próximo pull? ---"
if git ls-files --error-unmatch data/site.db >/dev/null 2>&1; then
  echo "  ATENÇÃO: data/site.db ainda é RASTREADO neste commit."
  echo "  Um git pull simples pode apagá-lo. Use ./deploy.sh, que o protege."
else
  echo "  OK: data/site.db não é rastreado — o git não mexe nele."
fi
echo

echo "--- Permissão de escrita no banco ---"
DONO_SVC=$(systemctl show "$SERVICO" -p User --value 2>/dev/null); [ -z "$DONO_SVC" ] && DONO_SVC="root"
echo "  serviço roda como : $DONO_SVC"
echo "  dono de data/     : $(stat -c '%U:%G %a' data 2>/dev/null || echo '—')"
echo "  dono do site.db   : $(stat -c '%U:%G %a' data/site.db 2>/dev/null || echo '—')"
# o SQLite grava um -journal ao lado do banco: sem escrita NA PASTA, dá
# "attempt to write a readonly database" mesmo com o .db gravável
if sudo -u "$DONO_SVC" test -w data 2>/dev/null && sudo -u "$DONO_SVC" test -w data/site.db 2>/dev/null; then
  echo "  resultado         : OK, o serviço consegue gravar"
else
  echo "  resultado         : SEM PERMISSÃO — o painel não vai salvar nada"
  echo "                      corrija com: sudo chown -R $DONO_SVC: data assets/img/uploads"
fi
echo

echo "--- Conteúdo do banco ---"
if [ -f data/site.db ]; then
  echo "  arquivo: $(du -h data/site.db | cut -f1)"
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync("data/site.db");
      for (const t of ["services","projetos","documentos","team","posts","portfolio","settings","visits"])
        console.log("  " + t.padEnd(14) + db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
      console.log("  integridade   " + db.prepare("PRAGMA integrity_check").get().integrity_check);
      const g = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
      console.log("  manutencao    " + (g("manutencao") === "1" ? "LIGADA — o site esta fora do ar" : "desligada"));
      const crypto = require("node:crypto");
      const h = g("admin_password_hash") || "";
      const [, N, r, pp, salt, dk] = h.split("$");
      const padrao = dk && crypto.scryptSync("kenosis-admin", Buffer.from(salt, "hex"),
        dk.length / 2, { N: +N, r: +r, p: +pp }).toString("hex") === dk;
      console.log("  senha painel  " + (padrao ? "AINDA E A PADRAO — troque no painel" : "trocada, ok"));
    } catch (e) { console.log("  ERRO ao ler: " + e.message); }
  ' 2>/dev/null
else
  echo "  data/site.db NÃO EXISTE"
fi
echo

echo "--- Sistema de gestão (/restrito) ---"
if [ -f data/gestao.db ]; then
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const crypto = require("node:crypto");
    try {
      const db = new DatabaseSync("data/gestao.db");
      const n = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      console.log("  arquivo: " + require("fs").statSync("data/gestao.db").size + " bytes");
      console.log(`  pacientes ${n("pacientes")} · associados ${n("associados")} · atendimentos ${n("atendimentos")} · eventos ${n("eventos")}`);
      const u = db.prepare("SELECT senha_hash FROM g_usuarios WHERE email=?").get("admin");
      if (u) { const [,N,r,p,salt,dk]=u.senha_hash.split("$");
        const padrao = dk && crypto.scryptSync("kenosis-gestao", Buffer.from(salt,"hex"), dk.length/2, {N:+N,r:+r,p:+p}).toString("hex")===dk;
        console.log("  senha admin: " + (padrao ? "AINDA E A PADRAO — troque em /restrito" : "trocada, ok")); }
    } catch (e) { console.log("  ERRO ao ler: " + e.message); }
  ' 2>/dev/null
else
  echo "  data/gestao.db ainda não existe (será criado no 1º boot)"
fi
echo

echo "--- Backups guardados ---"
# o || não pega o caso vazio porque quem define o código de saída é o sed
LISTA=$(ls -1t backups/site.db.* 2>/dev/null | head -5)
if [ -n "$LISTA" ]; then echo "$LISTA" | sed 's/^/  /'; else echo "  nenhum ainda (o primeiro sai no próximo deploy)"; fi
echo
echo "=============================================================="
