/* ==========================================================================
   lachat.js — CONECTOR do LA Chat para os sites do gerador

   Copie este arquivo para a raiz do site (BemEstarClinic, Borda Tudo, Forms
   Fitness, Imobiliária, Kenósis, NYC, Óticas, Troféu, CW Mendes…) e acrescente
   DUAS linhas ao `server.js`. Ver INSTALAR.md.

   ---------------------------------------------------------------------------
   O QUE ELE FAZ — e o que ele deliberadamente NÃO faz

   FAZ:
     1. emite o PASSE assinado, dizendo ao chat quem é a pessoa que já está
        logada no site;
     2. repassa `/chat/*` para o serviço do chat, inclusive o WebSocket.

   NÃO FAZ: nenhum acesso ao banco do site, nenhuma leitura de mensagem,
   nenhuma escrita em disco. Ele não conhece o model de usuário do hospedeiro —
   o site é que responde "quem é este visitante?" pela função `usuario`.

   Sem dependência nenhuma além do Node, como o conector do LA Sentinela.

   ---------------------------------------------------------------------------
   POR QUE REPASSAR EM VEZ DE APONTAR DIRETO PARA O CHAT

   Porque assim o navegador vê TUDO na mesma origem do site do cliente. E
   mesma origem significa:

     · cookie com `SameSite=Strict` — a proteção mais forte contra CSRF, de graça;
     · nenhuma configuração de CORS;
     · nenhum subdomínio novo, nenhum certificado novo;
     · o chat sai do ar? o site continua no ar. O repasse falha sozinho.

   Quem preferir o chat num subdomínio próprio pode usar só `passe()` e apontar
   o cliente para lá — mas aí precisa de `CHAT_ENTRE_SITES=1` e da lista de
   origens bem preenchida. O caminho do repasse é o recomendado.
   ========================================================================== */
"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");

/* 1.6 — `podeSala`: o site passa a declarar QUEM pode criar reunião por
   link. O `papel` continua fechado em membro/admin — alargá-lo seria dar ao
   hospedeiro o poder de inventar privilégios. Uma capacidade nomeada delega
   uma decisão só.
   1.5 — o LINK CURTO de reunião: `site.com/call/<codigo>` passa a ser
   atendido aqui e redirecionado para dentro do prefixo do chat. Sem isto o
   convite cai no 404 do site, porque a rota não existe lá. É o único caminho
   FORA do prefixo que o conector atende, e o padrão é estreito de propósito —
   11 caracteres do alfabeto dos códigos, e nada mais.
   1.4 — `sincronizarElenco()` devolve também `desativados` e `mudou`, para o
   hospedeiro poder reenviar o elenco periodicamente sem encher o log.
   1.3 — o `Path` do cookie também é traduzido na VOLTA. A 1.1 corrigiu a ida;
   faltava a volta, e sem ela o chat montado fora de `/chat` autenticava e
   perdia a sessão no pedido seguinte (ver `traduzirCookies`).
   1.2 — `sincronizarElenco()`: o hospedeiro manda quem existe no sistema dele,
   resolvendo a partida a frio (o chat só conhecia quem já tinha entrado, e a
   primeira pessoa a abrir encontrava a lista vazia).
   1.1 — o repasse passou a TRADUZIR o prefixo (`prefixo` de cá ×
   `prefixoRemoto` de lá). Antes, montar o chat fora de `/chat` fazia o passe
   funcionar e todo o resto responder 404. É contrato: quem atualizar o
   conector ganha isso sem mexer em mais nada. */
const VERSAO_CONECTOR = "1.6";

function conectorChat(opcoes = {}) {
  const alvo = String(opcoes.url || process.env.CHAT_URL || "").replace(/\/+$/, "");
  const segredo = opcoes.segredo || process.env.CHAT_SEGREDO_PASSE || "";
  const contexto = String(opcoes.contexto || process.env.CHAT_CONTEXTO || "padrao");
  const prefixo = "/" + String(opcoes.prefixo || "chat").replace(/^\/+|\/+$/g, "");
  /* ==========================================================================
     O PREFIXO DE CÁ E O DE LÁ — e por que são dois

     `prefixo` é onde o chat mora NO SITE. `prefixoRemoto` é onde ele mora no
     SERVIÇO do chat (o `CHAT_PREFIXO` de lá, `/chat` por padrão).

     Eram a mesma coisa até alguém precisar montar o chat fora da raiz. O
     BemEstarClinic precisou: o cookie da gestão tem `Path=/restrito`, e com o
     chat em `/chat` o navegador não enviava o cookie — o passe respondia 401.
     Movido para `/restrito/chat`, o passe passou a funcionar e o REPASSE
     quebrou: o conector mandava `/restrito/chat/cliente.js` para um serviço
     que só conhece `/chat/cliente.js`, e a resposta era 404.

     Agora o caminho é TRADUZIDO na saída. Sem isto, a opção `prefixo` só
     funcionava no valor padrão — ou seja, não funcionava.
     ========================================================================== */
  const prefixoRemoto = "/" + String(
    opcoes.prefixoRemoto || process.env.CHAT_PREFIXO_REMOTO || "chat"
  ).replace(/^\/+|\/+$/g, "");
  const paraOChat = (caminho) =>
    prefixoRemoto + (caminho.slice(prefixo.length) || "");
  const validadeSegundos = Number(opcoes.validadeSegundos || 60);

  /* A função que o HOSPEDEIRO fornece. É o contrato inteiro da integração
     (§39): o chat nunca conhece o `User` do site, só o que sai daqui. */
  const usuarioDe = typeof opcoes.usuario === "function" ? opcoes.usuario : () => null;

  const ligado = !!(alvo && segredo);
  if (!ligado) {
    console.warn("  ⚠ LA Chat: conector inativo (faltou url ou segredo). As rotas /chat não serão servidas.");
  } else if (segredo.length < 32) {
    /* Recusa em vez de avisar: um segredo curto é um segredo adivinhável, e
       adivinhar o segredo do passe é poder entrar como qualquer funcionário. */
    throw new Error("LA Chat: CHAT_SEGREDO_PASSE precisa ter pelo menos 32 caracteres");
  }

  const cliente = alvo.startsWith("https:") ? https : http;

  /* ==========================================================================
     O PASSE — mesma conta do lado do chat (src/infra/seguranca/passe.js)

     Se este código e o de lá divergirem, nada funciona e o erro é claro
     ("assinatura inválida"). É de propósito: uma divergência que falhasse em
     silêncio seria muito pior.
     ========================================================================== */
  function emitirPasse(u) {
    if (!u || !u.id || !u.nome) throw new Error("passe exige id e nome do usuário");
    const iat = Math.floor(Date.now() / 1000);
    const corpo = {
      sub: String(u.id),
      /* QUEM A PESSOA É, quando o site sabe dizer por algo que sobrevive à
         troca de conta (no BemEstarClinic, o `profissional_id`). Sem isto no
         passe, entrar por uma conta que não seja a última sincronizada cria
         uma SEGUNDA pessoa no chat — e a conversa se parte em duas.
         Opcional: quem não manda segue funcionando pelo id da conta. */
      ident: String(u.identidade || "").slice(0, 120),
      nome: String(u.nome).slice(0, 120),
      sobrenome: String(u.sobrenome || "").slice(0, 120),
      email: String(u.email || "").slice(0, 200),
      avatar: String(u.avatar || "").slice(0, 500),
      cargo: String(u.cargo || "").slice(0, 120),
      departamento: String(u.departamento || "").slice(0, 120),
      papel: u.papel === "admin" ? "admin" : "membro",
      /* A CAPACIDADE de criar reunião por link. O papel continua com dois
         valores; esta bandeira é o que permite ao site distinguir perfis que o
         chat não conhece — profissional pode, recepção não.

         A CHAVE É `sala`, curta, porque é ela que o chat lê (`corpo.sala` em
         seguranca/passe.js). Escrevê-la como `podeSala` aqui faz o passe sair
         íntegro, assinado e válido — e a capacidade simplesmente não chegar.
         Nada quebra: o botão só não aparece, e a causa fica a dois arquivos de
         distância. Foi o que aconteceu na primeira versão desta linha. */
      sala: !!u.podeSala,
      ctx: String(u.contexto || contexto).slice(0, 60),
      /* DE QUE VERSÃO ESTE PASSE VEIO.

         O conector é um arquivo COPIADO para dentro de cada site. Uma cópia
         atrasada continua funcionando — ela só deixa de mandar os campos que
         nasceram depois dela, e a capacidade some sem erro nenhum: o botão
         não aparece, e a causa está noutro repositório.

         Com a versão no passe, o chat pode dizer isso em voz alta. */
      cv: VERSAO_CONECTOR,
      iat,
      exp: iat + validadeSegundos,
      jti: crypto.randomBytes(16).toString("base64url"),
    };
    const b64 = Buffer.from(JSON.stringify(corpo)).toString("base64url");
    const assinatura = crypto.createHmac("sha256", segredo).update(b64).digest("base64url");
    return `${b64}.${assinatura}`;
  }

  /* ==========================================================================
     O REPASSE

     Cabeçalhos que NÃO podem ser copiados às cegas:

     · `host`            — precisa ser o do alvo, senão o chat monta URLs erradas;
     · `content-length`  — recalculado pelo próprio Node ao reenviar o corpo;
     · `connection`      — é por salto, não fim a fim.

     E um que precisa ser ACRESCENTADO: `x-forwarded-for`. Sem ele, o chat vê
     todas as requisições vindas do IP do site e o limitador tranca a empresa
     inteira de uma vez. Ele é ACRESCENTADO AO FIM da lista existente — é assim
     que o cabeçalho funciona, e é o que permite ao chat contar do fim para
     trás e achar o IP verdadeiro (ver src/infra/seguranca/ip.js).
     ========================================================================== */
  /* ==========================================================================
     O CAMINHO DO COOKIE, na volta

     Traduzir a URL na ida não basta. O chat responde com

         Set-Cookie: cid=…; Path=/chat

     porque é onde ELE acha que mora. O navegador guarda esse `Path` ao pé da
     letra e nunca mais envia o cookie para `/restrito/chat/*` — sessão nenhuma
     se firma. E o sintoma não parece um problema de cookie: entrar funciona
     (o 200 volta), e é a chamada SEGUINTE que responde `sem_sessao`. Foi
     exatamente assim que a aba "Pessoas" ficou vazia com o elenco já
     sincronizado no servidor.

     Só o prefixo do chat é reescrito. `Path=/` (o cookie de CSRF) fica como
     está: vale para o site inteiro e já chega onde precisa.
     ========================================================================== */
  function traduzirCookies(cabecalhos) {
    const posto = cabecalhos["set-cookie"];
    if (!posto || prefixo === prefixoRemoto) return cabecalhos;
    const trocar = (linha) => linha.replace(
      /(;\s*[Pp]ath=)(\/[^;,]*)/,
      (tudo, rotulo, valor) =>
        valor === prefixoRemoto || valor.startsWith(prefixoRemoto + "/")
          ? rotulo + prefixo + valor.slice(prefixoRemoto.length)
          : tudo
    );
    return { ...cabecalhos, "set-cookie": [].concat(posto).map(trocar) };
  }

  function repassar(req, res, caminho) {
    const cabecalhos = { ...req.headers };
    delete cabecalhos.host;
    delete cabecalhos["content-length"];
    delete cabecalhos.connection;

    const ipDireto = req.socket?.remoteAddress || "";
    cabecalhos["x-forwarded-for"] = [req.headers["x-forwarded-for"], ipDireto]
      .filter(Boolean).join(", ");
    cabecalhos["x-forwarded-proto"] = req.headers["x-forwarded-proto"] || "http";

    const destino = new URL(alvo + caminho);

    const pedido = cliente.request({
      hostname: destino.hostname,
      port: destino.port,
      path: destino.pathname + destino.search,
      method: req.method,
      headers: cabecalhos,
      /* Teto de tempo: sem ele, um chat travado prende requisições do SITE até
         o servidor ficar sem descritores. O site tem de sobreviver ao chat. */
      timeout: 30_000,
    }, (resposta) => {
      res.writeHead(resposta.statusCode || 502, traduzirCookies(resposta.headers));
      resposta.pipe(res);
    });

    pedido.on("timeout", () => { pedido.destroy(); });

    pedido.on("error", (e) => {
      if (res.headersSent) { try { res.destroy(); } catch { } return; }
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ erro: "O chat está indisponível no momento." }));
      if (process.env.CHAT_DEBUG) console.error("  ⚠ LA Chat: repasse falhou —", e.message);
    });

    req.pipe(pedido);
  }

  /* ==========================================================================
     ROTA — chamar no TOPO do handler do site

     Devolve `true` quando tratou a requisição. O site deve então retornar
     imediatamente: `if (chat.rota(req, res)) return;`
     ========================================================================== */
  function rota(req, res) {
    if (!ligado) return false;

    let caminho;
    try { caminho = new URL(req.url, "http://interno").pathname; } catch { return false; }

    /* ----------------------------------------------------------------------
       O LINK CURTO DE REUNIÃO — `site.com/call/<codigo>`

       É o ÚNICO caminho fora do prefixo que o conector atende, e ele não é
       repassado: vira um redirecionamento para dentro do prefixo, onde a
       página do convidado e a API do chat se enxergam.

       Repassar seria pior de um jeito difícil de descobrir: a página abriria
       normalmente em `/call/<codigo>` e depois procuraria `/bilhete` e
       `/chamadas/…` na RAIZ do site do cliente — endereços que pertencem ao
       site, não ao chat. O sintoma seria uma reunião que abre e não conecta.

       O regex é estreito de propósito: 11 caracteres do alfabeto dos códigos,
       e nada mais. Um `/call/*` largo aqui daria ao chat um pedaço da raiz do
       site do hospedeiro, que não é dele.
       ---------------------------------------------------------------------- */
    const curto = /^\/call\/([1-9A-HJ-NP-Za-km-z]{11})\/?$/.exec(caminho);
    if (curto) {
      res.writeHead(301, {
        Location: prefixo + "/call/" + curto[1],
        "Cache-Control": "no-store",
      });
      res.end();
      return true;
    }

    if (caminho !== prefixo && !caminho.startsWith(prefixo + "/")) return false;

    /* ----------------------------------------------------------------------
       A ÚNICA rota servida AQUI: o passe.

       Ela não pode ser repassada, porque só o hospedeiro sabe quem está
       logado. Todo o resto vai para o chat.
       ---------------------------------------------------------------------- */
    if (caminho === `${prefixo}/passe`) {
      let u = null;
      try {
        u = usuarioDe(req);
      } catch (e) {
        console.error("  ⚠ LA Chat: a função `usuario` do site falhou —", e.message);
      }

      if (!u || !u.id) {
        /* 401 sem detalhe. Dizer "não está logado" versus "usuário sem id"
           contaria ao visitante coisas sobre a sessão do site. */
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ erro: "não autenticado" })), true;
      }

      let passe;
      try { passe = emitirPasse(u); }
      catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ erro: "não foi possível emitir o acesso" })), true;
      }

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        /* NUNCA cacheado: um passe em cache seria um passe reutilizável, e a
           validade de 60 s deixaria de significar qualquer coisa. */
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end(JSON.stringify({ passe, validadeSegundos })), true;
    }

    repassar(req, res, paraOChat(caminho) + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""));
    return true;
  }

  /* ==========================================================================
     O WEBSOCKET

     `upgrade` é um evento SEPARADO do fluxo de requisição: ele não passa por
     `rota()`. Quem instalar o conector e esquecer esta linha vai ter um chat
     que carrega, autentica e nunca recebe mensagem em tempo real — sem erro
     nenhum aparecendo. Por isso o INSTALAR.md a trata como obrigatória.

     O repasse aqui é de SOCKET CRU: o aperto de mão do WebSocket é uma
     resposta HTTP 101 seguida de bytes que não são HTTP. Reencaminhar com
     `res.writeHead` não funcionaria; é preciso costurar os dois sockets.
     ========================================================================== */
  function conectarUpgrade(servidorDoSite) {
    if (!ligado) return;

    servidorDoSite.on("upgrade", (req, socket, cabeca) => {
      let caminho;
      try { caminho = new URL(req.url, "http://interno").pathname; } catch { return; }
      if (!caminho.startsWith(prefixo + "/")) return;   // não é nosso: outro ouvinte trata

      socket.on("error", () => { try { socket.destroy(); } catch { } });

      const cabecalhos = { ...req.headers };
      delete cabecalhos.host;
      const ipDireto = req.socket?.remoteAddress || "";
      cabecalhos["x-forwarded-for"] = [req.headers["x-forwarded-for"], ipDireto]
        .filter(Boolean).join(", ");

      /* O WebSocket precisa da MESMA tradução de prefixo do repasse HTTP.
         Esquecê-la aqui daria o pior sintoma possível: o chat carrega, mostra
         as conversas e nunca recebe mensagem — a falha silenciosa que a LINHA
         2 já existe para evitar. */
      const consulta = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      const destino = new URL(alvo + paraOChat(caminho) + consulta);

      const pedido = cliente.request({
        hostname: destino.hostname,
        port: destino.port,
        path: destino.pathname + destino.search,
        method: "GET",
        headers: cabecalhos,
      });

      pedido.on("upgrade", (resposta, socketDoChat, cabecaDoChat) => {
        /* Reescreve a resposta 101 na mão e costura os dois sockets. */
        const linhas = [`HTTP/1.1 101 ${resposta.statusMessage || "Switching Protocols"}`];
        for (const [k, v] of Object.entries(resposta.headers)) linhas.push(`${k}: ${v}`);
        socket.write(linhas.join("\r\n") + "\r\n\r\n");

        if (cabecaDoChat?.length) socket.write(cabecaDoChat);
        if (cabeca?.length) socketDoChat.write(cabeca);

        socketDoChat.on("error", () => { try { socket.destroy(); } catch { } });

        socketDoChat.pipe(socket);
        socket.pipe(socketDoChat);
      });

      /* O chat recusou o aperto de mão (origem, bilhete, limite). A resposta
         dele é repassada como está — o cliente precisa saber que foi recusado,
         e não ficar tentando para sempre contra um socket morto. */
      pedido.on("response", (resposta) => {
        socket.write(`HTTP/1.1 ${resposta.statusCode} ${resposta.statusMessage || ""}\r\nConnection: close\r\n\r\n`);
        try { socket.destroy(); } catch { }
      });

      pedido.on("error", () => { try { socket.destroy(); } catch { } });
      pedido.end();
    });
  }

  /* ==========================================================================
     SINCRONIZAR O ELENCO

     O hospedeiro manda a lista de quem existe no sistema dele — profissionais,
     recepção, administração. Sem isto, o chat só conhece quem já entrou, e a
     primeira pessoa a abrir encontra a lista vazia.

     Quando chamar: no boot do site, e sempre que um usuário for criado,
     editado ou desativado. É barato (uma requisição interna) e idempotente.

     Falha em SILÊNCIO, de propósito: o chat estar fora do ar não pode derrubar
     o boot do site nem fazer o cadastro de um funcionário falhar. Devolve o
     que aconteceu para quem quiser registrar.
     ========================================================================== */
  function sincronizarElenco(lista) {
    if (!ligado) return Promise.resolve({ ok: false, motivo: "conector inativo" });
    if (!Array.isArray(lista) || !lista.length) {
      return Promise.resolve({ ok: false, motivo: "lista vazia" });
    }

    /* O passe é emitido para uma identidade de SERVIÇO, não para uma pessoa:
       `id` fixo e um nome que denuncia o que é, caso apareça em algum log.
       Ele só serve para provar posse do segredo — a rota do elenco não abre
       sessão nem entrega dado nenhum. */
    let passe;
    try { passe = emitirPasse({ id: "__elenco__", nome: "Sincronização de elenco" }); }
    catch (e) { return Promise.resolve({ ok: false, motivo: e.message }); }

    const corpo = JSON.stringify({ passe, usuarios: lista });
    const destino = new URL(alvo + prefixoRemoto + "/elenco");

    return new Promise((resolver) => {
      const pedido = cliente.request({
        hostname: destino.hostname,
        port: destino.port,
        path: destino.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(corpo),
        },
        timeout: 10_000,
      }, (resposta) => {
        let texto = "";
        resposta.on("data", (d) => { texto += d; });
        resposta.on("end", () => {
          if (resposta.statusCode === 200) {
            let r = null; try { r = JSON.parse(texto); } catch { }
            resolver({
              ok: true,
              sincronizados: (r && r.sincronizados) || 0,
              desativados: (r && r.desativados) || 0,
              /* `mudou` é o que permite ao hospedeiro registrar no log só a
                 sincronização que fez diferença — sem isto, reenviar o elenco
                 de 5 em 5 minutos enche o log de linhas idênticas. */
              mudou: !!(r && r.mudou),
            });
          } else {
            resolver({ ok: false, motivo: `HTTP ${resposta.statusCode}` });
          }
        });
      });
      pedido.on("timeout", () => { pedido.destroy(); resolver({ ok: false, motivo: "tempo esgotado" }); });
      pedido.on("error", (e) => resolver({ ok: false, motivo: e.message }));
      pedido.end(corpo);
    });
  }

  return {
    versao: VERSAO_CONECTOR,
    ligado,
    prefixo,
    rota,
    conectarUpgrade,
    sincronizarElenco,
    /* Exposto para o hospedeiro que queira emitir o passe por conta própria
       (por exemplo, para injetá-lo direto no HTML e poupar uma requisição). */
    passe: emitirPasse,
  };
}

module.exports = conectorChat;
module.exports.conectorChat = conectorChat;
