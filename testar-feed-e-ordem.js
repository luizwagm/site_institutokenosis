/* ==========================================================================
   testar-feed-e-ordem.js — carrossel no Feed e listas de A a Z (site 2.16.0)

   OS PEDIDOS
     · "no feed, permita inserir mais de uma mídia por feed (ilimitado), e
       quando tiver mais de 1 mídia, mostrar no site como carrossel";
     · "coloque tudo que for inserido em ordem alfabética" — serviços,
       projetos, diretoria e parceiros (a Transparência tem a suíte dela).

   O QUE ESTA SUÍTE GUARDA
     1. O servidor só aceita mídia NOSSA (foto/vídeo enviados pelo painel).
     2. Publicado: matéria com 3 mídias abre com carrossel na ordem certa
        (capa primeiro), a lista mostra o selo "3", e a de uma mídia só fica
        como sempre foi. Diretoria, parceiros, serviços e projetos saem A-Z.
     3. No navegador: setas, contador, pontos e teclado andam juntos; trocar
        de slide pausa o vídeo; o celular não ganha barra lateral; e o painel
        envia várias fotos de uma vez, muda a ordem e tira mídia — salvando.

   RODA NUMA CÓPIA do projeto (publicar reescreve as páginas versionadas). O
   banco do site é temporário; o /restrito (PostgreSQL) é só LIDO pela
   publicação. Sem Chrome, a seção 3 é pulada e diz que foi.

     node testar-feed-e-ordem.js
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* 5294: longe da 5292 (transparência), 5284, 5286, 5288/5289 e 5299. */
const PORTA = Number(process.env.PORTA_TESTE_FEED) || 5294;
const BASE = `http://127.0.0.1:${PORTA}`;
const DEP = PORTA + 1000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kenosis-feed-"));
const COPIA = path.join(TMP, "site");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const ALFA = new Intl.Collator("pt-BR", { sensitivity: "base", numeric: true });
const emOrdem = (l) => l.every((x, i) => i === 0 || ALFA.compare(l[i - 1], x) <= 0);

let passou = 0; const falhas = [];
function certo(nome, cond, detalhe = "") {
  if (cond) { passou++; console.log(`    ✓ ${nome}`); }
  else { falhas.push(nome); console.log(`    ✖ ${nome}${detalhe ? `\n        ${detalhe}` : ""}`); }
}
function copiarProjeto() {
  const fora = /^(node_modules|data|backups|dumps|scratchpad|\.git|\.claude)$|^assets[\\/](video|docs)$|^assets[\\/]img[\\/]uploads$|^restrito[\\/]arquivos$|\.db$/;
  fs.cpSync(__dirname, COPIA, { recursive: true, filter: (src) => !fora.test(path.relative(__dirname, src)) });
}
const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

(async () => {
  console.log("\n  ══ FEED COM CARROSSEL E LISTAS DE A A Z — Instituto Kenósis ══\n");
  copiarProjeto();
  const servidor = spawn(process.execPath, ["server.js"], {
    cwd: COPIA,
    env: { ...process.env, NODE_PATH: path.join(__dirname, "node_modules"), PORT: String(PORTA),
      SITE_DB: path.join(TMP, "site.db"), CHAT_URL: "", CHAT_SEGREDO_PASSE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  servidor.stdout.on("data", (d) => (log += d));
  servidor.stderr.on("data", (d) => (log += d));
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "kenosis-feed-chrome-"));
  let chrome = null;
  try {
    let vivo = false;
    for (let i = 0; i < 80 && !vivo; i++) { try { await fetch(BASE + "/"); vivo = true; } catch { await espera(250); } }
    if (!vivo) throw new Error("o servidor não subiu:\n" + log.slice(-1200));
    const ent = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "kenosis-admin" }) });
    const sid = (ent.headers.get("set-cookie") || "").split(";")[0];
    const api = async (rota, metodo = "GET", corpo, cookie = sid) => {
      const r = await fetch(BASE + rota, { method: metodo, headers: { cookie, "content-type": "application/json" },
        body: corpo === undefined ? undefined : JSON.stringify(corpo) });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    };
    const conteudo = async () => (await api("/api/content")).j;
    const foto = async (nome) => (await api("/api/upload", "POST", { name: nome, dataUrl: PNG_1X1 })).j.path;
    const VIDEOS = path.join(COPIA, "assets", "video");
    fs.mkdirSync(VIDEOS, { recursive: true });

    /* =========================================================== 1. recusas */
    console.log("  1. o servidor só aceita mídia enviada pelo painel");
    const hoje = new Date().toISOString().slice(0, 10);
    const base = await api("/api/feed", "POST", { title: "Zz Qa Base", excerpt: "x", date: hoje });
    const idBase = base.j.item.id;
    const recusa = async (midias) => (await api(`/api/feed/${idBase}`, "PUT", { midias: JSON.stringify(midias) })).status;
    certo("link javascript: → recusado", await recusa([{ tipo: "foto", url: "javascript:alert(1)" }]) === 400);
    certo("foto fora da pasta (../) → recusada", await recusa([{ tipo: "foto", url: "/assets/img/uploads/../../server.js" }]) === 400);
    certo("tipo que não é foto nem vídeo → recusado", await recusa([{ tipo: "pdf", url: "/assets/docs/x.pdf" }]) === 400);
    certo("JSON torto → recusado", (await api(`/api/feed/${idBase}`, "PUT", { midias: "{nao" })).status === 400);
    certo("…e nada disso chegou ao banco", !((await conteudo()).feed.find((f) => f.id === idBase) || {}).midias);
    await api(`/api/feed/${idBase}`, "DELETE");

    /* =========================================================== 2. publicado */
    console.log("\n  2. a página publicada");
    const f1 = await foto("capa.png"), f2 = await foto("terceira.png");
    fs.writeFileSync(path.join(VIDEOS, "zz-qa-feed.mp4"), Buffer.alloc(3000, 1));
    fs.writeFileSync(path.join(VIDEOS, "zz-qa-feed.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    const varias = await api("/api/feed", "POST", { title: "Zz Qa Festa da Família", excerpt: "Com fotos e vídeo.", content: "<p>Texto.</p>", image: f1, date: hoje,
      midias: JSON.stringify([{ tipo: "video", url: "/assets/video/zz-qa-feed.mp4" }, { tipo: "foto", url: f2 }]) });
    certo("matéria com capa + 2 mídias aceita", varias.status === 200, JSON.stringify(varias.j).slice(0, 200));
    await api("/api/feed", "POST", { title: "Zz Qa Uma Foto Só", excerpt: "Só a capa.", content: "<p>Texto.</p>", image: await foto("unica.png"), date: hoje });
    /* Cadastrados fora de ordem, de propósito. */
    await api("/api/team", "POST", { name: "Zz Qa Bruno", role: "Conselho" });
    await api("/api/team", "POST", { name: "Zz Qa Ana", role: "Presidente" });
    await api("/api/team", "POST", { name: "Zz Qa Álvaro", role: "Tesoureiro" });
    await api("/api/portfolio", "POST", { title: "Zz Qa Zeta Parceiro" });
    await api("/api/portfolio", "POST", { title: "Zz Qa Alfa Parceiro" });
    const pub = await api("/api/publish", "POST");
    certo("publicado", pub.status === 200, JSON.stringify(pub.j).slice(0, 200));

    const ler = (rel) => fs.readFileSync(path.join(COPIA, rel), "utf8");
    const pag = ler("feed/zz-qa-festa-da-familia/index.html");
    const itens = [...pag.matchAll(/<div class="carrossel__item"[^>]*>\s*<(img|video) src="([^"]+)"([^>]*)>/g)].map((m) => ({ tag: m[1], src: m[2], resto: m[3] }));
    certo("a matéria abre com um carrossel de 3 mídias, a capa primeiro", pag.includes("data-carrossel") && itens.length === 3
      && itens[0].src === f1 && itens[1].src === "/assets/video/zz-qa-feed.mp4" && itens[2].src === f2, JSON.stringify(itens));
    certo("só a primeira foto carrega de cara; a outra espera", /fetchpriority="high"/.test(itens[0].resto) && /loading="lazy"/.test(itens[2].resto));
    certo("o vídeo não baixa nada antes do play e mostra a capa dele", /preload="none"/.test(itens[1].resto) && /poster="\/assets\/video\/zz-qa-feed\.jpg"/.test(itens[1].resto));
    const unica = ler("feed/zz-qa-uma-foto-so/index.html");
    certo("matéria de uma foto só fica como sempre foi (sem carrossel)", !unica.includes("data-carrossel") && /<figure class="materia-capa" data-revela><img/.test(unica));
    const lista = ler("feed/index.html");
    const cartao = (slug) => (new RegExp(`<a class="materia__foto[^"]*" href="/feed/${slug}/"[^>]*>(.*?)<img`, "s").exec(lista) || [])[1] || "";
    certo("na lista, o cartão da matéria com 3 mídias leva o selo \"3\"", /<span class="materia__qtd" aria-label="3 fotos e vídeos">3<\/span>/.test(cartao("zz-qa-festa-da-familia")), cartao("zz-qa-festa-da-familia"));
    certo("…e o de uma foto só, não", !cartao("zz-qa-uma-foto-so").includes("materia__qtd"));

    const inst = ler("institucional/index.html");
    const nomes = [...inst.matchAll(/Zz Qa (Ana|Bruno|Álvaro)/g)].map((m) => m[1]);
    const primeiros = [...new Set(nomes)];
    certo("diretoria em ordem alfabética (Álvaro, Ana, Bruno — acento não atrapalha)", JSON.stringify(primeiros) === JSON.stringify(["Álvaro", "Ana", "Bruno"]), JSON.stringify(primeiros));
    const parc = [...new Set([...inst.matchAll(/Zz Qa (Alfa|Zeta) Parceiro/g)].map((m) => m[1]))];
    certo("parceiros em ordem alfabética", JSON.stringify(parc) === JSON.stringify(["Alfa", "Zeta"]), JSON.stringify(parc));
    /* Serviços e projetos vêm do /restrito: a suíte não cadastra nada lá, só
       confere que o que existe sai em ordem. */
    const serv = ler("servicos/index.html");
    const blocos = [...serv.matchAll(/<article class="cartao serv-cartao"[\s\S]*?<h3 class="cartao__titulo">([^<]+)<\/h3>([\s\S]*?)<\/ul>/g)];
    const cats = blocos.map((m) => m[1].trim());
    const itensFora = blocos.filter((m) => !emOrdem([...m[2].matchAll(/<\/svg> ([^<]+)<\/li>/g)].map((x) => x[1].trim()))).map((m) => m[1]);
    if (blocos.length) certo("dentro de cada categoria, os serviços em ordem alfabética", !itensFora.length, "fora de ordem: " + itensFora.join(", "));
    const projs = [...ler("projetos/index.html").matchAll(/<span class="projeto__nome">([^<]+)</g)].map((m) => m[1].trim());
    certo(`projetos em ordem alfabética (${projs.length} no banco de gestão)`, emOrdem(projs), JSON.stringify(projs));
    if (cats.length) certo(`categorias de serviço em ordem alfabética (${cats.length})`, emOrdem(cats), JSON.stringify(cats));
    else console.log("    · categorias de serviço: o molde não tem o título esperado — conferir à mão");
    const c = await conteudo();
    certo("no painel, diretoria e parceiros vêm na mesma ordem A-Z", JSON.stringify(c.team.map((t) => t.name).filter((n) => /^Zz Qa/.test(n))) === JSON.stringify(["Zz Qa Álvaro", "Zz Qa Ana", "Zz Qa Bruno"])
      && JSON.stringify(c.portfolio.map((t) => t.title).filter((n) => /^Zz Qa/.test(n))) === JSON.stringify(["Zz Qa Alfa Parceiro", "Zz Qa Zeta Parceiro"]));

    /* =========================================================== 3. navegador */
    console.log("\n  3. no navegador");
    const CHROME = [process.env.CHROME,
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((x) => { try { return fs.existsSync(x); } catch { return false; } });
    if (!CHROME) { console.log("    · pulado: não achei o Chrome (defina CHROME=<caminho>)"); return; }
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--autoplay-policy=no-user-gesture-required",
      `--remote-debugging-port=${DEP}`, `--user-data-dir=${perfil}`, "about:blank"], { stdio: "ignore" });
    let alvos = null;
    for (let i = 0; i < 60 && !alvos; i++) { try { alvos = await (await fetch(`http://127.0.0.1:${DEP}/json/list`)).json(); } catch { await espera(250); } }
    const ws = new WebSocket(alvos.find((a) => a.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let seq = 0; const esp = new Map(); const eventos = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && esp.has(m.id)) { esp.get(m.id)(m); esp.delete(m.id); } else if (m.method) eventos.push(m);
    });
    const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; esp.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const na = async (expr, gesto = false) => {
      const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: gesto });
      if (r.result.exceptionDetails) throw new Error("no navegador: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result?.value;
    };
    const ate = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await na(expr)) return true; await espera(200); } return false; };
    await cdp("Page.enable");
    await cdp("Network.enable");
    await cdp("Network.setCookie", { name: "sid", value: sid.split("=")[1], url: BASE });
    await cdp("Page.navigate", { url: BASE + "/privacidade/" });
    await ate(`document.readyState === "complete"`);

    /* Um vídeo de verdade (o falso não toca), para provar a pausa. */
    const webm = await na(`(async () => {
      const c = document.createElement("canvas"); c.width = 320; c.height = 180; const g = c.getContext("2d");
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm;codecs=vp8" });
      const partes = []; rec.ondataavailable = (e) => { if (e.data.size) partes.push(e.data); };
      const t0 = performance.now(); rec.start(200);
      await new Promise((ok) => { const tq = setInterval(() => { g.fillStyle = "hsl(" + ((performance.now() - t0) / 10 % 360) + ",80%,50%)"; g.fillRect(0, 0, 320, 180);
        if (performance.now() - t0 > 3000) { clearInterval(tq); ok(); } }, 33); });
      rec.stop(); await new Promise((r) => (rec.onstop = r));
      const b = new Blob(partes, { type: "video/webm" });
      return await new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result.split(",")[1]); f.readAsDataURL(b); });
    })()`);
    fs.writeFileSync(path.join(VIDEOS, "zz-qa-feed.mp4"), Buffer.from(webm, "base64"));   // o servidor serve pelo nome; o Chrome lê o conteúdo

    const estado = `(() => { const c = document.querySelector("[data-carrossel]"); const t = c.querySelector(".carrossel__trilho");
      return { cont: c.querySelector(".carrossel__contador")?.textContent, ant: c.querySelector(".carrossel__seta--ant")?.disabled,
        prox: c.querySelector(".carrossel__seta--prox")?.disabled, ponto: [...c.querySelectorAll(".carrossel__pontos button")].findIndex((b) => b.getAttribute("aria-current") === "true"),
        pos: Math.round(t.scrollLeft / t.clientWidth) }; })()`;
    await cdp("Page.navigate", { url: BASE + "/feed/zz-qa-festa-da-familia/" });
    await ate(`!!document.querySelector(".carrossel__contador")`);
    let e = await na(estado);
    certo("abre na 1ª mídia: contador 1 / 3, sem seta para trás", e.cont === "1 / 3" && e.ant === true && e.prox === false && e.ponto === 0, JSON.stringify(e));
    await na(`document.querySelector(".carrossel__seta--prox").click()`, true);
    await ate(`document.querySelector(".carrossel__contador").textContent === "2 / 3"`, 4000);
    e = await na(estado);
    certo("a seta avança: 2 / 3, o ponto acompanha e a faixa rolou", e.cont === "2 / 3" && e.ponto === 1 && e.pos === 1 && e.ant === false, JSON.stringify(e));
    /* toca o vídeo do slide 2 e troca de slide pelo teclado: tem de pausar */
    await na(`(async () => { const v = document.querySelectorAll(".carrossel__item video")[0]; v.muted = true; await v.play(); })()`, true);
    await espera(400);
    const tocando = await na(`!document.querySelectorAll(".carrossel__item video")[0].paused`);
    await na(`(() => { const t = document.querySelector(".carrossel__trilho"); t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); })()`, true);
    await ate(`document.querySelector(".carrossel__contador").textContent === "3 / 3"`, 4000);
    e = await na(estado);
    certo("a seta do teclado leva à 3ª, e a seta para frente some no fim", e.cont === "3 / 3" && e.prox === true, JSON.stringify(e));
    certo("…e o vídeo que tocava no slide anterior PAUSOU", tocando && await na(`document.querySelectorAll(".carrossel__item video")[0].paused`), `tocando antes: ${tocando}`);
    await na(`document.querySelectorAll(".carrossel__pontos button")[0].click()`, true);
    await ate(`document.querySelector(".carrossel__contador").textContent === "1 / 3"`, 4000);
    certo("o ponto leva direto à 1ª", (await na(estado)).cont === "1 / 3");
    certo("sem script, a faixa ainda rola e para em cada mídia (scroll-snap)", (await na(`getComputedStyle(document.querySelector(".carrossel__trilho")).scrollSnapType`)) === "x mandatory");

    await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
    await cdp("Page.navigate", { url: BASE + "/feed/zz-qa-festa-da-familia/" });
    await ate(`!!document.querySelector(".carrossel__contador")`); await espera(400);
    const larg = await na(`({ pagina: document.documentElement.scrollWidth, tela: innerWidth, item: document.querySelector(".carrossel__item").getBoundingClientRect().width, trilho: document.querySelector(".carrossel__trilho").clientWidth })`);
    certo("no celular: sem barra lateral na página, e cada mídia ocupa a faixa inteira", larg.pagina <= larg.tela && Math.abs(larg.item - larg.trilho) < 1, JSON.stringify(larg));
    await cdp("Emulation.clearDeviceMetricsOverride");

    /* ---------------------------------------------------------- o painel */
    const idVarias = varias.j.item.id;
    await cdp("Page.navigate", { url: BASE + "/admin/" });
    await ate(`!!document.getElementById("midias-${idVarias}")`);
    await na(`window.confirm = () => true`);
    const minis = () => na(`[...document.querySelectorAll("#midias-${idVarias} .midia")].map((m) => m.querySelector(".midia__num").textContent)`);
    certo("no painel, a matéria mostra as 2 mídias além da capa, numeradas 2 e 3", JSON.stringify(await minis()) === JSON.stringify(["2", "3"]), JSON.stringify(await minis()));
    /* + Fotos com DUAS fotos de uma vez */
    const arqs = [];
    for (const n of ["quarta", "quinta"]) {
      const b64 = await na(`(() => { const c = document.createElement("canvas"); c.width = 800; c.height = 600; const g = c.getContext("2d"); g.fillStyle = "#${n === "quarta" ? "1EA1E4" : "C8735B"}"; g.fillRect(0, 0, 800, 600); return c.toDataURL("image/png").split(",")[1]; })()`);
      const p = path.join(TMP, n + ".png"); fs.writeFileSync(p, Buffer.from(b64, "base64")); arqs.push(p);
    }
    await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
    eventos.length = 0;
    await na(`[...document.querySelectorAll("#midias-${idVarias} ~ .anexos__botoes button")].find((b) => b.textContent.includes("Fotos")).click()`, true);
    let escolha = null;
    for (let t = 0; t < 5000 && !escolha; t += 100) { escolha = eventos.find((x) => x.method === "Page.fileChooserOpened"); if (!escolha) await espera(100); }
    certo("o + Fotos abre o seletor (e aceita várias)", !!escolha && escolha.params.mode === "selectMultiple", JSON.stringify(escolha && escolha.params));
    if (escolha) await cdp("DOM.setFileInputFiles", { files: arqs, backendNodeId: escolha.params.backendNodeId });
    await ate(`document.querySelectorAll("#midias-${idVarias} .midia").length === 4`);
    const lerMidias = async () => JSON.parse(((await conteudo()).feed.find((f) => f.id === idVarias) || {}).midias || "[]");
    let m = [];
    for (let t = 0; t < 6000; t += 300) { m = await lerMidias(); if (m.length === 4) break; await espera(300); }
    certo("as duas fotos entram e já ficam SALVAS (4 mídias além da capa)", m.length === 4 && m[2].tipo === "foto" && m[3].tipo === "foto", JSON.stringify(m));
    /* move a última para a esquerda */
    const antes = m.map((x) => x.url);
    await na(`[...document.querySelectorAll("#midias-${idVarias} .midia")][3].querySelector('[aria-label="Mover para a esquerda"]').click()`, true);
    await espera(900);
    m = await lerMidias();
    certo("mover troca a ordem e salva", m[2].url === antes[3] && m[3].url === antes[2], JSON.stringify(m.map((x) => x.url)));
    /* tira o vídeo */
    await na(`[...document.querySelectorAll("#midias-${idVarias} .midia")][0].querySelector('[aria-label="Tirar"]').click()`, true);
    await espera(900);
    m = await lerMidias();
    certo("tirar remove a mídia e salva", m.length === 3 && !m.some((x) => x.tipo === "video"), JSON.stringify(m));
    /* Salvar a matéria (botão de sempre) não pode perder as mídias */
    await na(`(() => { const i = document.querySelector('[data-t="feed"][data-id="${idVarias}"][data-f="excerpt"]'); i.value = "Resumo novo."; })()`);
    await na(`[...document.querySelectorAll("button")].find((b) => b.getAttribute("onclick") === "saveRow('feed',${idVarias})").click()`, true);
    await espera(900);
    const salvo = (await conteudo()).feed.find((f) => f.id === idVarias);
    certo("Salvar a matéria guarda o texto e mantém as mídias", salvo.excerpt === "Resumo novo." && JSON.parse(salvo.midias).length === 3, JSON.stringify({ excerpt: salvo.excerpt, midias: salvo.midias }));

    ws.close();
  } catch (e) {
    falhas.push("execução: " + e.message);
    console.log("    ✖ execução — " + e.message);
  } finally {
    if (chrome) chrome.kill();
    servidor.kill();
    await espera(600);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch {}
    console.log(`\n  ${passou} ok, ${falhas.length} falha(s)`);
    if (falhas.length) { console.log("  " + falhas.join("\n  ")); process.exitCode = 1; }
  }
})();
