/* ==========================================================================
   testar-cabecalhos.js — os cabeçalhos que o navegador obedece

   Guarda uma falha que não aparece em lugar nenhum quando acontece: a
   `Permissions-Policy` fechada para câmera e microfone faz o navegador RECUSAR
   `getUserMedia` antes de perguntar ao usuário. Nenhuma janela de permissão,
   nenhum erro no console do chat, nenhum registro no servidor — o botão de
   vídeo apenas não faz nada.

   É a linha que alguém "aperta" numa varredura de segurança seis meses depois,
   com toda a razão do mundo, sem saber que a reunião da equipe depende dela.
   Por isso ela tem teste: cerca sem teste é a que o próximo refactor apaga.

   Sobe uma cópia do site numa porta própria, com banco descartável — não toca
   no banco do cliente e não precisa de senha nenhuma.

     node testar-cabecalhos.js
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORTA = Number(process.env.PORTA_TESTE_CAB) || 5299;
const BANCO = path.join(os.tmpdir(), `kenosis-cabecalhos-${process.pid}.db`);

let passou = 0, falhou = 0;
function ok(nome, real, esperado) {
  if (real === esperado) { passou++; console.log(`    ✓ ${nome}`); return; }
  falhou++;
  console.log(`    ✖ ${nome}\n        esperado: ${JSON.stringify(esperado)}\n        obtido:   ${JSON.stringify(real)}`);
}
function contem(nome, texto, trecho) {
  if (String(texto || "").includes(trecho)) { passou++; console.log(`    ✓ ${nome}`); return; }
  falhou++;
  console.log(`    ✖ ${nome}\n        não contém: ${JSON.stringify(trecho)}\n        veio:       ${JSON.stringify(texto)}`);
}
function naoContem(nome, texto, trecho) {
  if (!String(texto || "").includes(trecho)) { passou++; console.log(`    ✓ ${nome}`); return; }
  falhou++;
  console.log(`    ✖ ${nome}\n        NÃO podia conter: ${JSON.stringify(trecho)}\n        veio:             ${JSON.stringify(texto)}`);
}

/* A porta ocupada por OUTRO processo faria a suíte medir o vizinho e passar
   (ou falhar) por motivo nenhum. Melhor recusar com a razão escrita. */
function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = require("node:net").createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(porta, "127.0.0.1");
  });
}

const pegar = (caminho) => new Promise((ok_, falha) => {
  require("node:http")
    .get({ host: "127.0.0.1", port: PORTA, path: caminho }, (r) => {
      r.resume();
      ok_({ status: r.statusCode, cab: r.headers });
    })
    .on("error", falha);
});

(async () => {
  console.log("\n  ══ CABEÇALHOS — Instituto Kenósis ══\n");

  if (!(await portaLivre(PORTA))) {
    console.error(`  ✖ a porta ${PORTA} já está ocupada por outro processo.`);
    console.error("    Feche o que está usando, ou rode com PORTA_TESTE_CAB=<outra>.\n");
    process.exit(1);
  }

  const filho = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORTA),
      SITE_DB: BANCO,
      /* Sem as variáveis do chat o conector fica inativo — e é o que se quer:
         a prova é do cabeçalho do SITE, que vale com ou sem chat. */
      CHAT_URL: "", CHAT_SEGREDO_PASSE: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  filho.stdout.on("data", (d) => { saida += d; });
  filho.stderr.on("data", (d) => { saida += d; });

  /* Espera o site RESPONDER, e não um tempo fixo: em máquina lenta o sleep
     curto falha, e o longo faz todo mundo esperar à toa. */
  let vivo = false;
  for (let i = 0; i < 60; i++) {
    try { await pegar("/"); vivo = true; break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!vivo) {
    console.error("  ✖ o site não subiu em 15s.\n");
    console.error(saida.slice(-1500));
    filho.kill();
    process.exit(1);
  }

  try {
    /* ====================================================================
       O /restrito ABRE câmera e microfone
       ==================================================================== */
    console.log("  1. o /restrito abre câmera e microfone");
    const r = await pegar("/restrito");
    const pol = r.cab["permissions-policy"];
    contem("camera liberada para a própria origem", pol, "camera=(self)");
    contem("microfone também", pol, "microphone=(self)");
    /* Partilha de tela é o outro pedido da reunião, e ele tem política
       PRÓPRIA: liberar câmera e esquecer esta faz o botão de compartilhar
       falhar sozinho, com a chamada funcionando ao lado. */
    contem("partilha de tela também", pol, "display-capture=(self)");
    naoContem("e a localização continua fechada", pol, "geolocation=(self)");

    /* A sala da reunião por link mora sob o mesmo prefixo, porque o conector
       repassa `/restrito/chat/*`. Se a regra fosse por caminho exato, o
       convidado de fora entraria numa página sem câmera. */
    console.log("\n  2. a sala da reunião por link herda a mesma regra");
    const sala = await pegar("/restrito/chat/call/ABCDEFGHJKL");
    contem("camera liberada na sala", sala.cab["permissions-policy"], "camera=(self)");

    /* ====================================================================
       O SITE PÚBLICO E O /admin CONTINUAM FECHADOS
       ==================================================================== */
    console.log("\n  3. fora do /restrito, nada de câmera");
    for (const caminho of ["/", "/institucional/", "/admin"]) {
      const x = await pegar(caminho);
      const p = x.cab["permissions-policy"];
      contem(`${caminho} fecha a câmera`, p, "camera=()");
      naoContem(`${caminho} não abre por engano`, p, "camera=(self)");
    }

    /* ====================================================================
       OS OUTROS CABEÇALHOS CONTINUAM ONDE ESTAVAM
       ==================================================================== */
    console.log("\n  4. o resto da proteção continua de pé");
    ok("X-Content-Type-Options", r.cab["x-content-type-options"], "nosniff");
    ok("X-Frame-Options", r.cab["x-frame-options"], "SAMEORIGIN");
    ok("Referrer-Policy", r.cab["referrer-policy"], "strict-origin-when-cross-origin");
    /* HSTS só sob HTTPS: emiti-lo em HTTP puro trancaria o acesso em ambiente
       sem certificado — e aqui a conexão é HTTP. */
    ok("sem HSTS em HTTP puro", r.cab["strict-transport-security"], undefined);
  } finally {
    /* Espera o filho MORRER antes de apagar: o SQLite ainda segura o arquivo
       por um instante depois do `kill`, e o `unlink` falharia calado —
       deixando banco de teste espalhado pelo /tmp. */
    await new Promise((pronto) => {
      filho.once("exit", pronto);
      filho.kill();
      setTimeout(pronto, 3000);          /* não travar a suíte se ele emperrar */
    });
    for (const sufixo of ["", "-wal", "-shm", "-journal"]) {
      try { fs.unlinkSync(BANCO + sufixo); } catch { /* não existia */ }
    }
  }

  console.log(`\n  ${falhou ? "✖" : "✔"} ${passou} passaram, ${falhou} falharam\n`);
  process.exit(falhou ? 1 : 0);
})();
