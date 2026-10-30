#!/usr/bin/env bash
# ==========================================================================
#  liberar-envios.sh — deixa o vídeo e o PDF do painel passarem pelo nginx
#
#  Uso:  sudo ./nginx/liberar-envios.sh [dominio]
#  Ex.:  sudo ./nginx/liberar-envios.sh institutokenosis.com
#
#  POR QUE EXISTE (2.17.2): o vhost aceita no máximo 25 MB por pedido
#  (`client_max_body_size 25m`, pensado para a foto em base64). O painel
#  aceita vídeo de até 300 MB (2.17.3) e PDF de até 30 MB. Tudo o que passava
#  de 25 MB era recusado PELO NGINX com 413, antes de chegar à aplicação.
#
#  O que faz: põe UM bloco `location` só para as duas rotas de envio, com
#  teto de 320 MB, corpo passado em FLUXO para a aplicação (que conta os
#  bytes e corta no limite dela) e 30 min de prazo. O resto do site continua
#  com 25 MB.
#
#  Pode rodar quantas vezes quiser: um bloco de versão anterior é TROCADO
#  pelo atual (a 2.17.2 parava em "já está lá" e deixava o teto antigo).
#  Guarda cópia do vhost, testa com `nginx -t` e, se falhar, DEVOLVE a cópia
#  — vhost quebrado em sites-enabled derrubaria o próximo reload de qualquer
#  site do servidor.
# ==========================================================================
set -uo pipefail

DOMINIO="${1:-institutokenosis.com}"
INICIO="# kenosis: envios grandes (liberar-envios.sh)"
FIM_BLOCO="# kenosis: fim dos envios grandes"
TETO="320m"
PRAZO="1800s"

verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

[ "$(id -u)" -eq 0 ] || { vermelho "Rode com sudo."; exit 1; }

# -------------------------------------------------- 1. achar o vhost certo
# O nome do arquivo nem sempre é o domínio. Vale o arquivo de sites-enabled
# cujo server_name tem o domínio — é ele que o nginx de fato carrega.
ARQ="/etc/nginx/sites-available/$DOMINIO"
if [ ! -f "$ARQ" ]; then
  ACHADO=$(grep -lE "server_name[^;]*[[:space:]]$DOMINIO([[:space:];]|$)" /etc/nginx/sites-enabled/* 2>/dev/null | head -1)
  [ -n "$ACHADO" ] && ARQ=$(readlink -f "$ACHADO")
fi
[ -f "$ARQ" ] || { vermelho "Não achei o vhost de $DOMINIO em /etc/nginx/sites-enabled."; exit 1; }
echo "Vhost: $ARQ"

# A porta sai do próprio vhost: o bloco novo fala com a MESMA aplicação.
PORTA=$(grep -oE 'proxy_pass http://127\.0\.0\.1:[0-9]+' "$ARQ" | head -1 | grep -oE '[0-9]+$')
[ -n "$PORTA" ] || { vermelho "Não achei o proxy_pass da aplicação em $ARQ"; exit 1; }

N=$(grep -cE '^[[:space:]]*location / \{' "$ARQ")
if [ "$N" -lt 1 ]; then
  vermelho "Não achei nenhum 'location / {' em $ARQ. Nada foi alterado."
  exit 1
fi

COPIA="$ARQ.bak-$(date +%F-%H%M%S)"
cp "$ARQ" "$COPIA"
amarelo "Cópia do vhost em $COPIA"

# ------------------------------------------- 2. tirar o bloco antigo, se houver
# Da linha do INICIO até a linha do FIM_BLOCO; o bloco da 2.17.2 não tinha
# FIM_BLOCO e termina no primeiro "    }" depois do INICIO.
LIMPO=$(mktemp)
TEM_FIM=$(grep -cF "$FIM_BLOCO" "$COPIA")
awk -v ini="$INICIO" -v fim="$FIM_BLOCO" -v temfim="$TEM_FIM" '
  index($0, ini) { pulando = 1; next }
  pulando && index($0, fim) { pulando = 0; tirou_chave = 1; next }
  pulando && temfim == 0 && /^    \}[[:space:]]*$/ { pulando = 0; tirou_chave = 1; next }
  pulando { next }
  tirou_chave && /^[[:space:]]*$/ { tirou_chave = 0; next }
  { tirou_chave = 0; print }
' "$COPIA" > "$LIMPO"
grep -qF "$INICIO" "$COPIA" && amarelo "Havia um bloco anterior — será trocado pelo atual."

# ---------------------------------------------------- 3. pôr o bloco atual
BLOCO=$(mktemp)
# 'FIM' entre aspas: nada aqui dentro é expandido pelo shell — as variáveis
# do nginx ($host, $scheme…) chegam ao arquivo exatamente como escritas.
cat > "$BLOCO" <<'FIM'
    __INICIO__
    # Vídeo (até 300 MB) e PDF (até 30 MB) do painel. Só estas duas rotas
    # passam de 25 MB; o corpo segue em fluxo e a aplicação corta no limite.
    location ~ ^/api/upload-(video|pdf)$ {
        client_max_body_size    __TETO__;
        proxy_request_buffering off;
        client_body_timeout     __PRAZO__;
        proxy_send_timeout      __PRAZO__;
        proxy_read_timeout      __PRAZO__;

        proxy_pass http://127.0.0.1:__PORTA__;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    __FIM_BLOCO__

FIM
sed -i -e "s|__INICIO__|$INICIO|" -e "s|__FIM_BLOCO__|$FIM_BLOCO|" \
       -e "s|__PORTA__|$PORTA|" -e "s|__TETO__|$TETO|" -e "s|__PRAZO__|$PRAZO|g" "$BLOCO"

# Antes de CADA `location / {`: com HTTP e HTTPS em blocos server separados,
# os dois recebem o bloco.
awk -v arq="$BLOCO" '
  BEGIN { while ((getline l < arq) > 0) bloco = bloco l "\n" }
  /^[[:space:]]*location \/ \{/ { printf "%s", bloco }
  { print }
' "$LIMPO" > "$ARQ"
rm -f "$BLOCO" "$LIMPO"

POSTOS=$(grep -cF "$INICIO" "$ARQ")
if [ "$POSTOS" != "$N" ]; then
  vermelho "Esperava $N bloco(s) e o arquivo ficou com $POSTOS. Devolvendo a cópia."
  cp "$COPIA" "$ARQ"; exit 1
fi

if ! nginx -t 2>&1 | sed 's/^/   /'; then
  vermelho "nginx -t recusou. Devolvendo a cópia — nada foi recarregado."
  cp "$COPIA" "$ARQ"
  exit 1
fi
systemctl reload nginx
verde "nginx recarregado: $POSTOS bloco(s), teto $TETO, porta $PORTA."

# ------------------------------------------------------------- 4. a prova
# 150 MB SEM login. Antes dava 413 do nginx; agora o pedido tem de chegar à
# aplicação, que responde 401 em JSON ("Não autenticado").
TMP=$(mktemp)
head -c $((150 * 1024 * 1024)) /dev/zero > "$TMP"
COD=$(curl -s -o /dev/null -w '%{http_code}' -m 300 -X POST -H 'Content-Type: video/mp4' \
      --data-binary @"$TMP" "https://$DOMINIO/api/upload-video")
rm -f "$TMP"
if [ "$COD" = "401" ]; then
  verde "Prova: 150 MB chegaram à aplicação (401 sem login, como deve ser)."
else
  vermelho "Prova: esperava 401 e veio $COD. Confira $ARQ (cópia em $COPIA)."
  exit 1
fi
