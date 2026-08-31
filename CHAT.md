# LA Chat no Instituto Kenósis — instância PRÓPRIA

O chat da equipe roda DENTRO do `/restrito` (botão azul 💬 no canto inferior
direito), pela mesma receita do BemEstarClinic — mas contra uma **instância
própria do LA-Chat**: mesmo código, porta **5210**, banco, anexos, segredos e
origens exclusivos do Instituto. Nada é compartilhado com o chat da clínica:
nem o banco, nem a chave de cifragem, nem o segredo do passe (comprometer o
ambiente de um site não permite forjar passe para o outro).

Peças no site:

- `lachat.js` (conector 1.4) — emite o passe e repassa `/restrito/chat/*`.
- `server.js` — conector (contexto `kenosis`, prefixo `restrito/chat`),
  `chat.rota()` no topo do handler, `chat.conectarUpgrade()` e o elenco
  (boot + mudança de usuário + 5 min).
- `restrito/app.html` — o script do cliente no fim; cores via
  `la-chat { --chat-primaria: #1EA1E4 }`.
- Quem entra: conta ATIVA do /restrito (admin, secretaria, profissional).
- Identidade: `prof-<profissional_id>` ou `conta-<id>` — a MESMA fórmula no
  passe e no elenco.

No LA-Chat (0.8.0): `node instancia.js .env.kenosis` sobe a instância em
desenvolvimento; o `.env.kenosis` (fora do git) declara PORT=5210,
CHAT_BASE=http://127.0.0.1:5210, banco em `dados/kenosis/`, os três segredos
próprios e as origens do Instituto. **CHAT_BASE é URL completa** — um caminho
tipo `/chat` derruba toda requisição em 400 "Requisição inválida".

## Para funcionar em produção (institutokenosis.com)

1. **/etc/lachat-kenosis.env** — copie o `.env.kenosis` local como base e
   ajuste para produção:

       NODE_ENV=production
       PORT=5210
       HOST=127.0.0.1
       CHAT_BASE=http://127.0.0.1:5210
       CHAT_ORIGENS=https://institutokenosis.com
       CHAT_SEGREDO_PASSE=<o mesmo que estiver no /etc/kenosis.env>
       CHAT_SEGREDO_BUSCA=<próprio desta instância>
       CHAT_DADOS_CHAVE=<própria desta instância — perder = perder as mensagens>
       CHAT_SQLITE=/var/www/projetos/LA-Chat/dados/kenosis/chat.db
       CHAT_ARQUIVOS=/var/www/projetos/LA-Chat/dados/kenosis/arquivos
       CHAT_PROXIES=2

   `CHAT_PROXIES=2` porque em produção são dois saltos: nginx → conector → chat.

2. **Unit própria** `/etc/systemd/system/lachat-kenosis.service` — cópia da
   `lachat.service` trocando duas linhas:

       EnvironmentFile=/etc/lachat-kenosis.env
       ExecStart=/usr/bin/node /var/www/projetos/LA-Chat/instancia.js /etc/lachat-kenosis.env

   (o `instancia.js` aceita caminho absoluto; com `EnvironmentFile` o systemd
   já põe tudo no ambiente e o arquivo só confirma — os dois caminhos valem).
   Depois: `systemctl daemon-reload && systemctl enable --now lachat-kenosis`.

3. **/etc/kenosis.env** ganha:

       CHAT_URL=http://127.0.0.1:5210
       CHAT_SEGREDO_PASSE=<o MESMO do /etc/lachat-kenosis.env>

4. **nginx** — bloco do WebSocket ANTES do `location /` no server do
   institutokenosis.com (o `map $http_upgrade $conexao_upgrade` do conf.d já
   existe, é compartilhado):

       location /restrito/chat/ws {
           proxy_pass http://127.0.0.1:5189;
           proxy_http_version 1.1;
           proxy_set_header Upgrade    $http_upgrade;
           proxy_set_header Connection $conexao_upgrade;
           proxy_set_header Host              $host;
           proxy_set_header X-Real-IP         $remote_addr;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout  7d;
           proxy_send_timeout  7d;
           proxy_buffering     off;
       }

   Conferir com `sudo nginx -T | grep -A6 'location /restrito/chat/ws'`.

5. **Backup**: o banco novo (`dados/kenosis/`) precisa entrar no LA Backup —
   é onde moram as mensagens da equipe do Instituto.

6. Reiniciar o `kenosis.service` e conferir no journal a linha
   `LA Chat: N pessoa(s) da equipe no chat.` — é a prova de que o segredo
   bateu e o elenco subiu.

---

## Ligar o chat COMPLETO (vídeo, reunião por link, edição)

O código já está no servidor: as instâncias do parque compartilham o mesmo
`/var/www/projetos/LA-Chat`, e o Instituto serve **exatamente o mesmo
`la-chat.js`** que o BemEstarClinic. A diferença é só configuração — com
`CHAT_VIDEO` desligado, `la-chat-video.js` não é lido, não é concatenado e não
chega ao navegador. O recurso não existe, em vez de existir escondido atrás de
um `if`.

Medido em 24/08/2026: o Instituto servia 122.286 bytes de cliente; o BemEstar,
268.936 — os mesmos 122.286 mais o arquivo do vídeo.

### 1. No site (já feito)

* `lachat.js` atualizado para o **conector 1.6**. Ele traz duas coisas de que a
  reunião por link depende: o **link curto** `institutokenosis.com/call/<código>`
  (redireciona para dentro do prefixo — sem ele a página abre e não conecta) e a
  **capacidade** `sala` dentro do passe.
* `server.js` declara **quem pode abrir reunião**: `admin` e `profissional`.
  Secretaria não — ela agenda e recebe, não conduz atendimento. A capacidade vai
  nos DOIS lugares (o passe do login e o elenco); faltando num deles, a aba de
  reuniões aparece e some conforme o caminho por onde a pessoa entrou.

### 2. No servidor — `/etc/lachat-kenosis.env`

```bash
CHAT_VIDEO=1

# O endereço PÚBLICO. É com ele que o link do convite é montado
# (`<CHAT_BASE>/call/<código>`) — e é a raiz do site, não o prefixo do chat,
# porque quem atende /call na raiz é o conector.
CHAT_BASE=https://institutokenosis.com

# O MESMO relay do BemEstar. Duas instâncias podem dividir um coturn: a
# credencial é um HMAC do id do usuário com o segredo, e não tem instância
# dentro. O segredo aqui é o `static-auth-secret` do coturn.
CHAT_TURN=<o mesmo valor de /etc/lachat-bemestar.env>
CHAT_TURN_SEGREDO=<o mesmo valor de /etc/lachat-bemestar.env>
```

> **Sem TURN o vídeo não fica "pior", fica QUEBRADO para a reunião por link.**
> Ela força `iceTransportPolicy: relay` para o convidado não ver o IP de quem
> está dentro — e sem servidor de relay o navegador descarta todo candidato e
> não sobra nenhum. Entre colegas na mesma rede a chamada ainda funciona; o
> link, não.

Conferir que `CHAT_ORIGENS` já tem `https://institutokenosis.com` — é de lá que
a página do convidado faz os pedidos dela.

### 3. As migrações — com o ambiente DESTA instância

```bash
cd /var/www/projetos/LA-Chat
set -a; . /etc/lachat-kenosis.env; set +a
npm run migrar
```

**As duas primeiras linhas não são enfeite.** Sem elas o comando usa o banco
PADRÃO e migra `dados/chat.db` — imprimindo ✓ para tudo enquanto o banco do
Instituto continua parado. Já custou uma tarde. O migrador hoje recusa o caso
óbvio, mas carregar o ambiente é o que torna a pergunta desnecessária.

Faltam `005-arquivo`, `006-podesala` e `007-espera` se a instância não foi
migrada desde então. `npm run migrar` é idempotente: rodar de novo não faz mal.

### 4. Reiniciar e conferir

```bash
systemctl restart lachat-kenosis
systemctl restart kenosis
cd /var/www/projetos/LA-Chat && ./verificar.sh https://institutokenosis.com
```

A prova de que o vídeo subiu, de fora do servidor:

```bash
curl -s https://institutokenosis.com/restrito/chat/cliente.js | grep -c RTCPeerConnection
```

Zero significa que `CHAT_VIDEO` não chegou ao processo — quase sempre é o
`EnvironmentFile` apontando para outro arquivo, ou o serviço não reiniciado.

### 5. O que aparece para a equipe

* **Chamada de vídeo** em qualquer conversa, até 6 pessoas.
* **Reunião por link** (aba Reuniões) para admin e profissional: link de 11
  caracteres, com duração, sala de espera com aprovação nominal, e o histórico
  de encerradas recolhido atrás de uma linha.
* **Janela separada** — a reunião muda para uma janela própria e o sistema
  continua navegável na aba de origem (abrir prontuário, anotar).
* **Editar a própria mensagem** nos primeiros 5 minutos. Este já está no ar,
  porque não depende do vídeo.

---

Sem `CHAT_URL`/`CHAT_SEGREDO_PASSE` no ambiente o conector fica INATIVO,
avisa no boot e o resto do sistema não muda — o chat é conveniência; a
agenda e o prontuário são o trabalho.
