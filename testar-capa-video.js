/* ==========================================================================
   testar-capa-video.js — a capa de cada vídeo é uma foto dele (site 2.14.0)

   O QUE ESTA SUÍTE GUARDA

   1. O VÍDEO É ENTREGUE POR FAIXA. Era a causa escondida de tudo: o servidor
      ignorava o cabeçalho Range e devolvia 200 com o arquivo inteiro. Com
      isso o navegador marca o vídeo como não-pulável — quem assiste não
      consegue avançar, o Safari do iPhone recusa tocar, e a foto de capa
      saía PRETA, porque toda busca caía no segundo 0.

   2. A CAPA SÓ SE GRAVA AO LADO DE UM VÍDEO QUE EXISTE, e só se for JPEG de
      verdade (pelos bytes). O nome sai do vídeo, nunca do navegador.

   3. O PAINEL TIRA A FOTO CERTA: pula o começo preto, sobrevive a vídeo sem
      duração no cabeçalho (MediaRecorder grava assim) e dá capa sozinho aos
      vídeos que já estavam no ar.

   Com o Chrome instalado, a seção 4 faz o caminho inteiro de verdade: grava um
   vídeo que COMEÇA PRETO, envia, deixa o painel tirar a capa e mede se ela
   saiu clara. Sem Chrome ela é pulada e diz que foi.

   ONDE ELA ESCREVE. O banco é um arquivo novo na pasta temporária. Os vídeos
   de ensaio vão para assets/video/ do projeto — é de lá que o servidor
   serve — com nome "zz-qa-…", e são APAGADOS no fim, pelo nome exato. A
   suíte NÃO publica o site: publicar reescreveria as páginas versionadas.

     node testar-capa-video.js
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

/* 5284: longe da 5286 (ata), 5288 (frequência) e 5299 (cabeçalhos). */
const PORTA = Number(process.env.PORTA_TESTE_CAPA) || 5284;
const BANCO = path.join(os.tmpdir(), `kenosis-capa-video-${process.pid}.db`);
const VIDEOS = path.join(__dirname, "assets", "video");
const MARCA = `zz-qa-capa-${process.pid}`;
const VIDEO_FALSO = `${MARCA}.webm`;              // bytes quaisquer: basta existir
const CRIADOS = [];                               // tudo que esta suíte pôs em assets/video

let passou = 0, falhou = 0;
function ok(nome, real, esperado) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) { passou++; console.log(`    ✓ ${nome}`); return; }
  falhou++;
  console.log(`    ✖ ${nome}\n        esperado: ${JSON.stringify(esperado)}\n        obtido:   ${JSON.stringify(real)}`);
}
const verdade = (nome, cond, detalhe) => { ok(nome, !!cond, true); if (!cond && detalhe) console.log(`        ${detalhe}`); };

function portaLivre(porta) {
  return new Promise((r) => {
    const s = require("node:net").createServer();
    s.once("error", () => r(false));
    s.once("listening", () => s.close(() => r(true)));
    s.listen(porta, "127.0.0.1");
  });
}

let COOKIE = "";
function pedir(caminho, { metodo = "GET", corpo = null, cab = {}, semCookie = false } = {}) {
  return new Promise((resolve, reject) => {
    const dados = corpo == null ? null : Buffer.from(typeof corpo === "string" ? corpo : JSON.stringify(corpo));
    const req = http.request({ host: "127.0.0.1", port: PORTA, path: caminho, method: metodo,
      headers: Object.assign({}, cab,
        !semCookie && COOKIE ? { cookie: COOKIE } : {},
        dados ? { "content-type": "application/json", "content-length": dados.length } : {}) }, (r) => {
      const partes = [];
      r.on("data", (d) => partes.push(d));
      r.on("end", () => {
        const sc = r.headers["set-cookie"];
        if (sc && !semCookie) COOKIE = sc.map((c) => c.split(";")[0]).join("; ");
        const bruto = Buffer.concat(partes);
        let json = null; try { json = JSON.parse(bruto.toString("utf8")); } catch { /* binário */ }
        resolve({ status: r.statusCode, cab: r.headers, bruto, json });
      });
    });
    req.on("error", reject);
    if (dados) req.write(dados);
    req.end();
  });
}

/* Um JPEG mínimo: o servidor confere a ASSINATURA dos bytes, e é ela que
   precisa ser de verdade. */
const JPEG = (enchimento = 64) =>
  "data:image/jpeg;base64," + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(enchimento, 9)]).toString("base64");

(async () => {
  console.log("\n  ══ CAPA DO VÍDEO — Instituto Kenósis ══\n");

  if (!(await portaLivre(PORTA))) {
    console.error(`  ✖ a porta ${PORTA} já está ocupada. Rode com PORTA_TESTE_CAPA=<outra>.\n`);
    process.exit(1);
  }

  /* o "vídeo" de ensaio: 20 000 bytes numerados, para conferir que a faixa
     devolvida é exatamente a pedida */
  const conteudo = Buffer.alloc(20000);
  for (let i = 0; i < conteudo.length; i++) conteudo[i] = i % 251;
  fs.writeFileSync(path.join(VIDEOS, VIDEO_FALSO), conteudo);
  CRIADOS.push(VIDEO_FALSO);

  const filho = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: String(PORTA), SITE_DB: BANCO, CHAT_URL: "", CHAT_SEGREDO_PASSE: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  filho.stdout.on("data", (d) => { saida += d; });
  filho.stderr.on("data", (d) => { saida += d; });

  let vivo = false;
  for (let i = 0; i < 60; i++) {
    try { await pedir("/", { semCookie: true }); vivo = true; break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!vivo) { console.error("  ✖ o site não subiu em 15s.\n" + saida.slice(-1500)); filho.kill(); process.exit(1); }

  try {
    /* ====================================================================
       1. o vídeo é entregue por FAIXA
       ==================================================================== */
    console.log("  1. o vídeo é entregue por faixa (é o que permite avançar)");
    const url = "/assets/video/" + VIDEO_FALSO;

    const pedaco = await pedir(url, { cab: { range: "bytes=100-199" }, semCookie: true });
    ok("pedido por faixa responde 206", pedaco.status, 206);
    ok("…dizendo que faixa é essa", pedaco.cab["content-range"], "bytes 100-199/20000");
    verdade("…com exatamente os bytes pedidos", pedaco.bruto.equals(conteudo.subarray(100, 200)),
      `veio ${pedaco.bruto.length} bytes`);

    const fim = await pedir(url, { cab: { range: "bytes=-50" }, semCookie: true });
    verdade("\"bytes=-50\" devolve os ÚLTIMOS 50 bytes",
      fim.status === 206 && fim.bruto.equals(conteudo.subarray(19950)), `${fim.status} · ${fim.bruto.length} bytes`);

    const aberto = await pedir(url, { cab: { range: "bytes=19990-" }, semCookie: true });
    verdade("\"bytes=19990-\" vai até o fim do arquivo",
      aberto.status === 206 && aberto.bruto.equals(conteudo.subarray(19990)));

    const inteiro = await pedir(url, { semCookie: true });
    ok("sem faixa, o arquivo inteiro sai com 200", inteiro.status, 200);
    ok("…anunciando que aceita faixa", inteiro.cab["accept-ranges"], "bytes");
    ok("…com o tamanho declarado", inteiro.cab["content-length"], "20000");
    verdade("…e idêntico ao do disco", inteiro.bruto.equals(conteudo));

    const alem = await pedir(url, { cab: { range: "bytes=50000-" }, semCookie: true });
    ok("faixa depois do fim é 416", alem.status, 416);

    const cabeca = await pedir(url, { metodo: "HEAD", semCookie: true });
    verdade("HEAD responde sem corpo, com o tamanho", cabeca.status === 200 && cabeca.bruto.length === 0
      && cabeca.cab["content-length"] === "20000");

    /* ====================================================================
       2. a capa: só ao lado de um vídeo que existe, e só JPEG
       ==================================================================== */
    console.log("\n  2. a capa só se grava ao lado de um vídeo daqui, e só se for JPEG");
    /* Banco novo: a semente põe a senha padrão do painel. É a do banco de
       ENSAIO, que morre no fim — a do Instituto não entra em lugar nenhum. */
    const entrada = await pedir("/api/login", { metodo: "POST", corpo: { password: "kenosis-admin" } });
    ok("o painel de ensaio abre", entrada.status, 200);

    const materia = await pedir("/api/feed", { metodo: "POST", corpo: {
      title: "ZZ QA matéria em vídeo", slug: MARCA, excerpt: "ensaio", content: "<p>ensaio</p>", image: url, date: "2026-09-25" } });
    ok("uma matéria do Feed com vídeo é criada", materia.status, 200);

    const faltam = await pedir("/api/videos-sem-capa");
    verdade("o vídeo aparece entre os que não têm capa",
      (faltam.json && faltam.json.videos || []).some((v) => v.video === url), JSON.stringify(faltam.json));

    const semLogin = await pedir("/api/capa-video", { metodo: "POST", corpo: { video: url, dataUrl: JPEG() }, semCookie: true });
    ok("sem login, a capa não é aceita", semLogin.status, 401);

    const fora = await pedir("/api/capa-video", { metodo: "POST", corpo: { video: "/assets/video/../../server.mp4", dataUrl: JPEG() } });
    ok("caminho com \"..\" é recusado (o nome não pode sair da pasta)", fora.status, 400);

    /* O nome leva a MARCA: se um dia a recusa falhar e a capa for gravada, a
       limpeza por prefixo leva o arquivo junto (a sabotagem #3 deixou um
       "zz-qa-nao-existe.jpg" para trás antes deste ajuste). */
    const inexistente = await pedir("/api/capa-video", { metodo: "POST", corpo: { video: `/assets/video/${MARCA}-nao-existe.mp4`, dataUrl: JPEG() } });
    ok("capa de vídeo que não existe é recusada", inexistente.status, 400);

    const html = "data:image/jpeg;base64," + Buffer.from("<html><script>alert(1)</script>").toString("base64");
    const disfarce = await pedir("/api/capa-video", { metodo: "POST", corpo: { video: url, dataUrl: html } });
    ok("HTML com nome de JPEG é recusado pelos bytes", disfarce.status, 400);

    const gorda = await pedir("/api/capa-video", { metodo: "POST", corpo: { video: url, dataUrl: JPEG(3.2 * 1024 * 1024) } });
    ok("capa acima de 3 MB é recusada", gorda.status, 413);

    const boa = await pedir("/api/capa-video", { metodo: "POST", corpo: { video: url, dataUrl: JPEG() } });
    ok("um JPEG de verdade é aceito", boa.status, 200);
    ok("…e mora AO LADO do vídeo, com o mesmo nome", boa.json && boa.json.capa, `/assets/video/${MARCA}.jpg`);
    CRIADOS.push(`${MARCA}.jpg`);
    verdade("…o arquivo existe na pasta dos vídeos", fs.existsSync(path.join(VIDEOS, `${MARCA}.jpg`)));
    verdade("…sem sobra do arquivo temporário da gravação",
      !fs.readdirSync(VIDEOS).some((n) => n.startsWith(`${MARCA}.jpg.tmp`)));

    const depois = await pedir("/api/videos-sem-capa");
    verdade("com capa, o vídeo sai da lista dos que faltam",
      !(depois.json.videos || []).some((v) => v.video === url));

    /* ====================================================================
       3. o código do site e do painel
       ==================================================================== */
    console.log("\n  3. o site usa a capa, e o painel tira a foto certa");
    const srv = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
    const adm = fs.readFileSync(path.join(__dirname, "admin", "index.html"), "utf8");
    verdade("o cartão da lista usa a capa do vídeo (e a genérica só na falta)",
      srv.includes("capaDoVideo(p.image) || CAPA_VIDEO) : p.image)}"));
    ok("o pôster do vídeo dentro da matéria usa a capa (Memória e Feed)",
      srv.split('poster="${esc(capaDoVideo(p.image) || CAPA_VIDEO)}"').length - 1, 2);
    ok("o JSON-LD aponta a capa como imagem do artigo (Memória e Feed)",
      srv.split("SITE + (capaDoVideo(p.image) || CAPA_VIDEO)").length - 1, 2);
    verdade("a capa tem largura e altura medidas (a página não pula quando ela chega)",
      srv.includes("medidasDoImg(capaDoVideo(p.image))"));
    /* Vídeo gravado por MediaRecorder diz Infinity de duração. A primeira
       versão supunha 1 s, e toda tentativa caía no começo preto. */
    verdade("sem duração no cabeçalho, a captura mede pulando ao fim",
      adm.includes("medindo = true; v.currentTime = 1e9;"));
    verdade("se todo quadro tentado for escuro, fica com o MAIS CLARO (e não com o último)",
      adm.includes("if (!melhor || luz > melhor.luz)"));
    /* A chamada tem de ser uma linha DE VERDADE: a primeira versão desta prova
       aceitava "// darCapaAosVideos();" comentado (sabotagem #2 escapou). */
    verdade("ao abrir o painel, os vídeos antigos ganham capa sozinhos",
      /async function loadAll\(\) \{[\s\S]{0,600}?\n  darCapaAosVideos\(\);/.test(adm));
    /* .thumb--video tem display:grid, que venceria o atributo hidden. */
    verdade("a miniatura de reserva se esconde por estilo, e não pelo hidden",
      adm.includes('title="Matéria em vídeo — ainda sem capa" style="display:none"'));

    /* ====================================================================
       4. o caminho inteiro, num Chrome de verdade
       ==================================================================== */
    console.log("\n  4. o caminho inteiro, num Chrome de verdade");
    await caminhoInteiro(url);
  } catch (e) {
    falhou++;
    console.log("  ✖ a suíte quebrou: " + e.message);
  } finally {
    filho.kill();
    for (const n of CRIADOS) { try { fs.unlinkSync(path.join(VIDEOS, n)); } catch { /* já saiu */ } }
    for (const n of fs.readdirSync(VIDEOS)) if (n.startsWith(MARCA)) { try { fs.unlinkSync(path.join(VIDEOS, n)); } catch {} }
    for (const x of ["", "-wal", "-shm"]) { try { fs.unlinkSync(BANCO + x); } catch {} }
    console.log(`\n  ${falhou ? "✖" : "✓"} ${passou} passaram, ${falhou} falharam\n`);
    process.exit(falhou ? 1 : 0);
  }
})();

/* --------------------------------------------------------------------------
   O CAMINHO INTEIRO: Chrome headless dirigido pela porta de depuração (o Node
   já traz WebSocket, sem puppeteer). Grava um vídeo que COMEÇA PRETO, envia
   pelo mesmo endereço do painel, põe numa matéria e deixa o próprio painel
   tirar a capa. Depois MEDE a capa: preta, a prova falha.
   -------------------------------------------------------------------------- */
async function caminhoInteiro() {
  const CHROME = [process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((c) => { try { return fs.existsSync(c); } catch { return false; } });
  if (!CHROME) { console.log("    · pulado: não achei o Chrome (defina CHROME=<caminho>)"); return; }

  const PORTA_DEP = PORTA + 1000;
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "kenosis-capa-chrome-"));
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORTA_DEP}`,
    `--user-data-dir=${perfil}`, "about:blank"], { stdio: "ignore" });
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let alvos = null;
    for (let i = 0; i < 40 && !alvos; i++) {
      try { alvos = await (await fetch(`http://127.0.0.1:${PORTA_DEP}/json/list`)).json(); } catch { await espera(250); }
    }
    const pagina = alvos && alvos.find((a) => a.type === "page");
    if (!pagina) { console.log("    · pulado: o Chrome não abriu a porta de depuração"); return; }
    const ws = new WebSocket(pagina.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let seq = 0; const esperando = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && esperando.has(m.id)) { esperando.get(m.id)(m); esperando.delete(m.id); }
    });
    const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; esperando.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const avaliar = async (expression) => {
      const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 90000 });
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result.value;
    };

    const sid = (COOKIE.split("; ").find((c) => c.startsWith("sid=")) || "").slice(4);
    await cdp("Network.enable");
    await cdp("Network.setCookie", { name: "sid", value: sid, domain: "127.0.0.1", path: "/" });
    await cdp("Page.navigate", { url: `http://127.0.0.1:${PORTA}/admin/` });
    await espera(3500);

    /* 1,2 s de PRETO e depois azul — o caso do fade que a captura tem de pular.
       O arquivo sai do MediaRecorder, que não grava a duração no cabeçalho:
       é também o caso da "duração Infinity". */
    const video = await avaliar(`(async () => {
      const c = document.createElement("canvas"); c.width = 640; c.height = 360;
      const g = c.getContext("2d");
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm" });
      const partes = []; rec.ondataavailable = (e) => e.data.size && partes.push(e.data);
      const fim = new Promise((r) => rec.onstop = r);
      rec.start(100);
      const t0 = performance.now();
      await new Promise((pronto) => {
        const quadro = () => {
          const t = (performance.now() - t0) / 1000;
          g.fillStyle = t < 1.2 ? "#000" : "#1EA1E4"; g.fillRect(0, 0, 640, 360);
          if (t < 4) setTimeout(quadro, 33); else pronto();
        };
        quadro();
      });
      rec.stop(); await fim;
      const r = await fetch("/api/upload-video", { method: "POST",
        headers: { "Content-Type": "video/webm", "X-Nome-Arquivo": encodeURIComponent("${MARCA}-real.webm") },
        body: new Blob(partes, { type: "video/webm" }) });
      return (await r.json()).path;
    })()`);
    verdade("o vídeo de ensaio foi gravado e enviado", video && video.startsWith("/assets/video/"), String(video));
    if (!video) return;
    CRIADOS.push(path.basename(video), path.basename(video).replace(/[.]webm$/, ".jpg"));

    await avaliar(`fetch("/api/feed", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ZZ QA vídeo real", slug: "${MARCA}-real", excerpt: "x", content: "<p>x</p>",
        image: ${JSON.stringify(video)}, date: "2026-09-25" }) }).then((r) => r.status)`);

    /* o fluxo do painel, como roda ao abri-lo */
    await avaliar(`darCapaAosVideos().then(() => true)`);

    /* A capa é MEDIDA dentro do navegador: luminosidade média dos pixels. */
    const capa = video.replace(/[.]webm$/, ".jpg");
    const luz = await avaliar(`new Promise((ok) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const p = g.getImageData(0, 0, c.width, c.height).data;
        let s = 0, n = 0; for (let i = 0; i < p.length; i += 4 * 97) { s += p[i] * .299 + p[i + 1] * .587 + p[i + 2] * .114; n++; }
        ok(Math.round(s / n));
      };
      img.onerror = () => ok(-1);
      img.src = ${JSON.stringify(capa)} + "?t=" + Date.now();
    })`);
    verdade("o painel gerou a capa do vídeo", luz >= 0, "a capa não existe");
    verdade("a capa NÃO é o começo preto do vídeo", luz > 18, `luminosidade ${luz}`);
    ws.close();
  } finally {
    chrome.kill();
    await espera(400);
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
  }
}
