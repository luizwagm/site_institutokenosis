#!/usr/bin/env bash
# ==========================================================================
#  liberar-envios.sh — deixa o vídeo e o PDF do painel passarem pelo nginx
#
#  Uso:  sudo ./nginx/liberar-envios.sh [dominio]
#  Ex.:  sudo ./nginx/liberar-envios.sh institutokenosis.com
#
#  POR QUE EXISTE (2.17.2): o vhost aceita no máximo 25 MB por pedido
#  (`client_max_body_size 25m`, pensado para a foto em base64). O painel
#  promete vídeo de até 120 MB e PDF de até 30 MB. Tudo o que passava de
#  25 MB era recusado PELO NGINX com 413 em HTML, antes de chegar à
#  aplicação — e o painel mostrava só "Não consegui enviar o vídeo".
#
#  O que faz: acrescenta UM bloco `location` só para as duas rotas de envio,
#  com teto de 130 MB e o corpo passado em FLUXO para a aplicação (que conta
#  os bytes e corta no limite dela). O resto do site continua com 25 MB.
#
#  Seguro de rodar mais de uma vez: se o bloco já estiver lá, não mexe.
#  Guarda cópia do vhost, testa com `nginx -t` e, se falhar, DEVOLVE a cópia
#  — vhost quebrado em sites-enabled derrubaria o próximo reload de qualquer
#  site do servidor.
# ==========================================================================
set -uo pipefail

DOMINIO="${1:-institutokenosis.com}"
ARQ="/etc/nginx/sites-available/$DOMINIO"
MARCA="# kenosis: envios grandes (liberar-envios.sh)"

verde()   { printf "\033[1;32m%s\033[0m\n" "$1"; }
amarelo() { printf "\033[1;33m%s\033[0m\n" "$1"; }
vermelho(){ printf "\033[1;31m%s\033[0m\n" "$1"; }

[ "$(id -u)" -eq 0 ] || { vermelho "Rode com sudo."; exit 1; }
[ -f "$ARQ" ] || { vermelho "Não achei $ARQ"; exit 1; }

if grep -qF "$MARCA" "$ARQ"; then
  verde "O bloco já está em $ARQ — nada a fazer."
  exit 0
fi

# A porta sai do próprio vhost: o bloco novo fala com a MESMA aplicação.
PORTA=$(grep -oE 'proxy_pass http://127\.0\.0\.1:[0-9]+' "$ARQ" | head -1 | grep -oE '[0-9]+$')
[ -n "$PORTA" ] || { vermelho "Não achei o proxy_pass da aplicação em $ARQ"; exit 1; }

# O bloco entra logo antes do `location / {`. Tem de haver exatamente um:
# com zero ou dois (vhost editado à mão), quem decide o lugar é uma pessoa.
N=$(grep -cE '^[[:space:]]*location / \{' "$ARQ")
if [ "$N" != "1" ]; then
  vermelho "Esperava 1 'location / {' em $ARQ e achei $N. Nada foi alterado."
  exit 1
fi

COPIA="$ARQ.bak-$(date +%F-%H%M%S)"
cp "$ARQ" "$COPIA"
amarelo "Cópia do vhost em $COPIA"

BLOCO=$(mktemp)
# 'FIM' entre aspas: nada aqui dentro é expandido pelo shell — as variáveis
# do nginx ($host, $scheme…) chegam ao arquivo exatamente como escritas.
cat > "$BLOCO" <<'FIM'
    __MARCA__
    # Vídeo (até 120 MB) e PDF (até 30 MB) do painel. Só estas duas rotas
    # passam de 25 MB; o corpo segue em fluxo e a aplicação corta no limite.
    location ~ ^/api/upload-(video|pdf)$ {
        client_max_body_size    130m;
        proxy_request_buffering off;
        client_body_timeout     300s;
        proxy_send_timeout      300s;
        proxy_read_timeout      300s;

        proxy_pass http://127.0.0.1:__PORTA__;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

FIM
sed -i -e "s|__MARCA__|$MARCA|" -e "s|__PORTA__|$PORTA|" "$BLOCO"

awk -v arq="$BLOCO" '
  /^[[:space:]]*location \/ \{/ && !feito { while ((getline l < arq) > 0) print l; feito = 1 }
  { print }
' "$COPIA" > "$ARQ"
rm -f "$BLOCO"

if ! grep -qF "$MARCA" "$ARQ"; then
  vermelho "O bloco não entrou no arquivo. Devolvendo a cópia."
  cp "$COPIA" "$ARQ"; exit 1
fi

if ! nginx -t 2>&1 | sed 's/^/   /'; then
  vermelho "nginx -t recusou. Devolvendo a cópia — nada foi recarregado."
  cp "$COPIA" "$ARQ"
  exit 1
fi
systemctl reload nginx
verde "nginx recarregado com o bloco novo (porta $PORTA)."

# Prova: 30 MB SEM login. Antes dava 413 do nginx; agora o pedido tem de
# chegar à aplicação, que responde 401 em JSON ("Não autenticado").
TMP=$(mktemp)
head -c $((30 * 1024 * 1024)) /dev/zero > "$TMP"
COD=$(curl -s -o /dev/null -w '%{http_code}' -m 120 -X POST -H 'Content-Type: video/mp4' \
      --data-binary @"$TMP" "https://$DOMINIO/api/upload-video")
rm -f "$TMP"
if [ "$COD" = "401" ]; then
  verde "Prova: 30 MB chegaram à aplicação (401 sem login, como deve ser)."
else
  vermelho "Prova: esperava 401 e veio $COD. Confira $ARQ (cópia em $COPIA)."
  exit 1
fi
