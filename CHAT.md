# LA Chat no Instituto Kenósis — como está e o que a produção precisa

O chat da equipe roda DENTRO do `/restrito` (botão azul 💬 no canto inferior
direito), pela mesma receita do BemEstarClinic:

- `lachat.js` (conector 1.4, copiado do projeto LA-Chat) — emite o passe e
  repassa `/restrito/chat/*` para o serviço do chat. Atualizar o chat =
  substituir este arquivo.
- `server.js` — bloco do conector (contexto `kenosis`, prefixo
  `restrito/chat`), `chat.rota()` no topo do handler, `chat.conectarUpgrade()`
  no servidor e a sincronização de elenco (boot + mudança de usuário + 5 min).
- `restrito/app.html` — o script do cliente no fim do documento; as cores via
  `la-chat { --chat-primaria: #1EA1E4 }` (celeste do Instituto).
- Quem entra: quem tem conta ATIVA no /restrito (admin, secretaria,
  profissional). O /admin do site e o /externo ficam de fora.
- Identidade: `prof-<profissional_id>` quando há vínculo, senão
  `conta-<id>` — a MESMA fórmula no passe e no elenco (divergir duplica gente).

## Para funcionar em produção (institutokenosis.com)

1. **/etc/kenosis.env** ganha (mesmo segredo do `/etc/lachat.env` do serviço
   do chat — divergiu, o passe é recusado com "assinatura inválida"):

       CHAT_URL=http://127.0.0.1:5197
       CHAT_SEGREDO_PASSE=<o mesmo do serviço do chat>

2. **O serviço do chat** precisa aceitar a origem do Instituto: acrescentar
   `https://institutokenosis.com` ao `CHAT_ORIGENS` do `/etc/lachat.env` e
   reiniciar o `lachat.service`. Sem isso o WebSocket é recusado no aperto de
   mão e o chat carrega mas nunca recebe mensagem.

3. **nginx** — o WebSocket precisa do bloco próprio ANTES do `location /`
   (e do `map $http_upgrade $conexao_upgrade` que já existe em conf.d,
   compartilhado com o BemEstar):

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

   Conferir com `sudo nginx -T | grep -A6 'location /restrito/chat/ws'`
   (o `-T` mostra o que está CARREGADO, não só o que passou na sintaxe).

Sem `CHAT_URL`/`CHAT_SEGREDO_PASSE` no ambiente o conector fica INATIVO,
avisa no boot e o resto do sistema não muda de comportamento — o chat é
conveniência; a agenda e o prontuário são o trabalho.
