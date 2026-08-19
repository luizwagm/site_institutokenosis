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

Sem `CHAT_URL`/`CHAT_SEGREDO_PASSE` no ambiente o conector fica INATIVO,
avisa no boot e o resto do sistema não muda — o chat é conveniência; a
agenda e o prontuário são o trabalho.
