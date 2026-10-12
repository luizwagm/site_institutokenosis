/* ==========================================================================
   testar-transparencia.js — Transparência por ano, com anexos (site 2.15.0)

   O PEDIDO: "fica fora de ordem do ano… uma aba por ano, onde posso postar
   vários arquivos no decorrer de cada um… link do Drive, PDF, fotos e vídeos
   na mesma postagem… o que vai diferenciar é o enunciado (Mês de Agosto,
   Setembro, Outubro…)… senão a página vai ficando muito grande."

   O QUE ESTA SUÍTE GUARDA
     1. A ORDEM NÃO DEPENDE DE QUEM FOI CADASTRADO PRIMEIRO: os anos do mais
        novo para o mais velho; dentro do ano, o "ano todo" e depois os meses
        do mais recente ao mais antigo — cadastrados de propósito fora de ordem.
     2. UMA PUBLICAÇÃO LEVA VÁRIOS ANEXOS (PDF, link, fotos, vídeo) e o site
        mostra todos; documento antigo (só com link) continua aparecendo.
     3. O SERVIDOR RECUSA o que não deve: ano torto, link `javascript:`,
        arquivo fora da pasta, PDF que não é PDF, PDF grande demais.
     4. NO NAVEGADOR: só o ano escolhido aparece; o link de uma publicação abre
        o ano dela; a foto amplia com anterior/próxima; o celular não ganha
        barra lateral; e o painel agrupa por ano, envia PDF e reduz foto.

   RODA NUMA CÓPIA do projeto: publicar reescreve as páginas versionadas, e os
   envios gravam em assets/. O banco do site é temporário. O /restrito
   (PostgreSQL) é só LIDO pela publicação (serviços e projetos), como nas
   outras suítes. Sem Chrome, a seção 4 é pulada e diz que foi.

     node testar-transparencia.js
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* 5292: longe da 5284 (capa), 5286 (ata), 5288/5289 (frequência), 5299. */
const PORTA = Number(process.env.PORTA_TESTE_TRANSP) || 5292;
const BASE = `http://127.0.0.1:${PORTA}`;
const DEP = PORTA + 1000;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kenosis-transp-"));
const COPIA = path.join(TMP, "site");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let passou = 0; const falhas = [];
function certo(nome, cond, detalhe = "") {
  if (cond) { passou++; console.log(`    ✓ ${nome}`); }
  else { falhas.push(nome); console.log(`    ✖ ${nome}${detalhe ? `\n        ${detalhe}` : ""}`); }
}

/* A cópia: tudo menos dados, dependências e o que o cliente enviou. As
   dependências vêm da pasta real por NODE_PATH — e não por junção: apagar a
   cópia no fim nunca pode alcançar o node_modules de verdade. */
function copiarProjeto() {
  const fora = /^(node_modules|data|backups|dumps|scratchpad|\.git|\.claude)$|^assets[\\/](video|docs)$|^assets[\\/]img[\\/]uploads$|^restrito[\\/]arquivos$|\.db$/;
  fs.cpSync(__dirname, COPIA, { recursive: true, filter: (src) => !fora.test(path.relative(__dirname, src)) });
}

/* Um PNG de 1×1: o bastante para o servidor aceitar como foto. */
const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");

(async () => {
  console.log("\n  ══ TRANSPARÊNCIA POR ANO — Instituto Kenósis ══\n");
  copiarProjeto();
  const servidor = spawn(process.execPath, ["server.js"], {
    cwd: COPIA,
    env: { ...process.env, NODE_PATH: path.join(__dirname, "node_modules"), PORT: String(PORTA),
      SITE_DB: path.join(TMP, "site.db"), CHAT_URL: "", CHAT_SEGREDO_PASSE: "", DOC_MAX_MB: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  servidor.stdout.on("data", (d) => (log += d));
  servidor.stderr.on("data", (d) => (log += d));
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), "kenosis-transp-chrome-"));
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
    const conteudo = async () => (await api("/api/content")).j.documentos || [];
    const idDe = async (titulo) => ((await conteudo()).find((d) => d.title === titulo) || {}).id;

    /* ============================================================ 1. o que o servidor recusa */
    console.log("  1. o servidor só aceita publicação e anexo bem formados");
    certo("sem ano → recusado", (await api("/api/documentos", "POST", { title: "Zz", ano: "" })).status === 400);
    certo("ano que não é ano (20x6) → recusado", (await api("/api/documentos", "POST", { title: "Zz", ano: "20x6" })).status === 400);
    const base = await api("/api/documentos", "POST", { title: "Zz Qa Base", ano: "2024", mes: 13, anexos: "[]" });
    certo("publicação válida entra, e mês 13 vira \"ano todo\"", base.status === 200 && base.j.item && base.j.item.mes === null, JSON.stringify(base.j));
    const idBase = base.j.item.id;
    const recusa = async (anexos) => (await api(`/api/documentos/${idBase}`, "PUT", { anexos: JSON.stringify(anexos) })).status;
    certo("link javascript: → recusado", await recusa([{ tipo: "link", url: "javascript:alert(1)" }]) === 400);
    certo("foto fora da pasta (../) → recusada", await recusa([{ tipo: "foto", url: "/assets/img/uploads/../../server.js" }]) === 400);
    certo("PDF apontando para outra pasta → recusado", await recusa([{ tipo: "pdf", url: "/assets/video/x.pdf" }]) === 400);
    certo("tipo inventado → recusado", await recusa([{ tipo: "script", url: "https://x.test/" }]) === 400);
    certo("mais de 80 anexos → recusado", await recusa(Array.from({ length: 81 }, () => ({ tipo: "link", url: "https://x.test/" }))) === 400);
    certo("…e nada disso chegou ao banco", ((await conteudo()).find((d) => d.id === idBase) || {}).anexos === "[]");
    certo("sem sessão → 401", (await api(`/api/documentos/${idBase}`, "PUT", { title: "x" }, "sid=nada")).status === 401);
    await api(`/api/documentos/${idBase}`, "DELETE");

    console.log("\n  2. o envio de PDF");
    const sobePdf = async (bytes, tipo = "application/pdf", cookie = sid) => {
      const r = await fetch(BASE + "/api/upload-pdf", { method: "POST", headers: { cookie, "content-type": tipo, "x-nome-arquivo": encodeURIComponent("Relatório Agosto.pdf") }, body: bytes });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    };
    const DOCS = path.join(COPIA, "assets", "docs");
    certo("sem sessão → 401", (await sobePdf(PDF, "application/pdf", "sid=nada")).status === 401);
    certo("tipo que não é PDF → 400", (await sobePdf(PDF, "text/html")).status === 400);
    const falso = await sobePdf(Buffer.from("<html><script>alert(1)</script></html>"));
    certo("rótulo de PDF com bytes de HTML → 400", falso.status === 400, JSON.stringify(falso.j));
    const grande = await sobePdf(Buffer.concat([PDF, Buffer.alloc(1.3 * 1024 * 1024)]));
    certo("PDF acima do limite → 413", grande.status === 413, String(grande.status));
    certo("…e as recusas não deixaram arquivo na pasta", fs.readdirSync(DOCS).length === 0, fs.readdirSync(DOCS).join(", "));
    const pdfOk = await sobePdf(PDF);
    certo("PDF de verdade → 200, na pasta dos documentos", pdfOk.status === 200 && /^\/assets\/docs\/[a-z0-9]+-relatorio-agosto\.pdf$/.test(pdfOk.j.path), JSON.stringify(pdfOk.j));
    const servido = await fetch(BASE + pdfOk.j.path);
    certo("…servido como application/pdf", servido.status === 200 && servido.headers.get("content-type") === "application/pdf", servido.headers.get("content-type"));
    const faixa = await fetch(BASE + pdfOk.j.path, { headers: { range: "bytes=0-4" } });
    certo("…e por faixa (o leitor de PDF pede assim)", faixa.status === 206 && (await faixa.text()) === "%PDF-");

    /* ============================================================ 3. a página publicada */
    console.log("\n  3. a página publicada: abas por ano, meses em ordem, vários anexos");
    /* Cadastrados FORA de ordem, de propósito: Agosto primeiro, Setembro por último. */
    const foto1 = (await api("/api/upload", "POST", { name: "evento 1.png", dataUrl: PNG_1X1 })).j.path;
    const foto2 = (await api("/api/upload", "POST", { name: "evento 2.png", dataUrl: PNG_1X1 })).j.path;
    const VIDEOS = path.join(COPIA, "assets", "video");
    fs.mkdirSync(VIDEOS, { recursive: true });
    fs.writeFileSync(path.join(VIDEOS, "zz-qa-acao.mp4"), Buffer.alloc(2000, 1));
    fs.writeFileSync(path.join(VIDEOS, "zz-qa-acao.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    await api("/api/documentos", "POST", { title: "Zz Qa Relatório de 2018", tipo: "Documento antigo, só com link", ano: "2018",
      url: "https://drive.google.com/file/d/zzqa2018/view" });     // como os de antes da 2.15.0
    await api("/api/documentos", "POST", { title: "Mês de Agosto <script>alert(1)</script>", ano: "2026", mes: 8,
      tipo: "Atividades socioeducativas de agosto.",
      anexos: JSON.stringify([
        { tipo: "pdf", url: pdfOk.j.path, titulo: "Relatório \"oficial\" de agosto" },
        { tipo: "link", url: "https://drive.google.com/file/d/zzqaago/view", titulo: "" },
        { tipo: "foto", url: foto1, titulo: "Oficina de artes" },
        { tipo: "foto", url: foto2, titulo: "" },
        { tipo: "video", url: "/assets/video/zz-qa-acao.mp4", titulo: "Apresentação" }]) });
    await api("/api/documentos", "POST", { title: "Mês de Outubro", ano: "2026", mes: 10, anexos: "[]" });
    await api("/api/documentos", "POST", { title: "Relatório anual 2026", ano: "2026", anexos: JSON.stringify([{ tipo: "link", url: "https://drive.google.com/x" }]) });
    await api("/api/documentos", "POST", { title: "Mês de Março", ano: "2025", mes: 3, anexos: "[]" });
    await api("/api/documentos", "POST", { title: "Mês de Setembro", ano: "2026", mes: 9, anexos: "[]" });
    await api("/api/documentos", "POST", { title: "", ano: "2026", mes: 11, anexos: "[]" });   // rascunho em branco
    const pub = await api("/api/publish", "POST");
    certo("publicado", pub.status === 200, JSON.stringify(pub.j).slice(0, 200));
    const html = fs.readFileSync(path.join(COPIA, "transparencia", "index.html"), "utf8");
    const abas = [...html.matchAll(/class="transp-anos__ano" id="aba-(\d{4})"[^>]*>\d{4}<small>(\d+)<\/small>/g)].map((m) => `${m[1]}:${m[2]}`);
    certo("uma aba por ano, do mais novo ao mais velho, com a contagem", JSON.stringify(abas) === JSON.stringify(["2026:4", "2025:1", "2018:1"]), JSON.stringify(abas));
    const ano26 = html.slice(html.indexOf('id="ano-2026"'), html.indexOf('id="ano-2025"'));
    const ordem = [...ano26.matchAll(/class="transp-pub__quando">([^<]+)</g)].map((m) => m[1]);
    certo("dentro do ano: o \"ano todo\" e depois Outubro, Setembro, Agosto — mesmo cadastrados fora de ordem",
      JSON.stringify(ordem) === JSON.stringify(["Ano todo", "Outubro", "Setembro", "Agosto"]), JSON.stringify(ordem));
    const abertas = [...ano26.matchAll(/<details class="transp-pub" id="doc-\d+"( open)?>/g)].map((m) => !!m[1]);
    certo("só a primeira publicação do ano vem aberta (a página não cresce sem fim)", JSON.stringify(abertas) === JSON.stringify([true, false, false, false]), JSON.stringify(abertas));
    certo("o rascunho em branco não vai ao ar", !/Novembro/.test(html));
    const ago = ano26.slice(ano26.indexOf(">Agosto<"));
    certo("a publicação de Agosto leva o PDF, com o nome dado", ago.includes(`href="${pdfOk.j.path}"`) && ago.includes("Relatório &quot;oficial&quot; de agosto") && ago.includes("PDF · abre em nova aba"));
    certo("…o link do Drive, dito como Google Drive", ago.includes('href="https://drive.google.com/file/d/zzqaago/view"') && ago.includes("Link · Google Drive"));
    certo("…as duas fotos, ampliáveis em grupo", (ago.match(/data-amplia="doc-\d+"/g) || []).length === 2 && ago.includes(`src="${foto1}"`) && ago.includes('alt="Oficina de artes"'));
    certo("…o vídeo, com a capa dele e sem baixar nada antes do play", /<video controls preload="none" playsinline poster="\/assets\/video\/zz-qa-acao\.jpg" src="\/assets\/video\/zz-qa-acao\.mp4"/.test(ago));
    certo("…e o resumo do que tem dentro", ago.includes("2 documentos · 2 fotos · 1 vídeo"));
    certo("o título com <script> sai escapado", !html.includes("<script>alert(1)") && html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    const a18 = html.slice(html.indexOf('id="ano-2018"'));
    certo("o documento antigo (só link) continua no ar, no ano dele", a18.includes('href="https://drive.google.com/file/d/zzqa2018/view"') && a18.includes("Documento antigo, só com link"));

    /* ============================================================ 4. no navegador */
    console.log("\n  4. no navegador");
    const CHROME = [process.env.CHROME,
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((c) => { try { return fs.existsSync(c); } catch { return false; } });
    if (!CHROME) { console.log("    · pulado: não achei o Chrome (defina CHROME=<caminho>)"); return; }
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${DEP}`, `--user-data-dir=${perfil}`, "about:blank"], { stdio: "ignore" });
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
    const visiveis = `[...document.querySelectorAll(".transp-ano")].filter((s) => getComputedStyle(s).display !== "none").map((s) => s.id)`;

    await cdp("Page.navigate", { url: BASE + "/transparencia/" });
    await ate(`document.readyState === "complete"`); await espera(400);
    certo("abre só no ano mais recente", JSON.stringify(await na(visiveis)) === JSON.stringify(["ano-2026"]), JSON.stringify(await na(visiveis)));
    await na(`document.querySelector("#aba-2025").click()`, true);
    certo("clicar em 2025 mostra só 2025", JSON.stringify(await na(visiveis)) === JSON.stringify(["ano-2025"]));
    certo("…marca a aba e põe o ano no endereço", await na(`document.querySelector("#aba-2025").getAttribute("aria-selected") === "true" && location.hash === "#ano-2025"`));
    const idAgo = await idDe("Mês de Agosto <script>alert(1)</script>");
    await cdp("Page.navigate", { url: `${BASE}/transparencia/#doc-${idAgo}` });
    await ate(`document.readyState === "complete"`); await espera(400);
    certo("o link de uma publicação abre o ano dela, com ela aberta", JSON.stringify(await na(visiveis)) === JSON.stringify(["ano-2026"])
      && await na(`document.getElementById("doc-${idAgo}").open`));
    await na(`document.querySelector("#doc-${idAgo} [data-amplia]").click()`, true);
    const lupa1 = await na(`(() => { const d = document.querySelector(".transp-lupa"); return { aberta: !!(d && d.open), src: d && d.querySelector("img").getAttribute("src"), leg: d && d.querySelector(".transp-lupa__legenda").textContent }; })()`);
    certo("a foto amplia, com a legenda e a posição", lupa1.aberta && lupa1.src === foto1 && /Oficina de artes\s+\(1\/2\)/.test(lupa1.leg), JSON.stringify(lupa1));
    await na(`document.querySelector(".transp-lupa__prox").click()`, true);
    certo("…a seta leva à próxima da mesma publicação", (await na(`document.querySelector(".transp-lupa img").getAttribute("src")`)) === foto2);
    await na(`document.querySelector(".transp-lupa__fechar").click()`, true);
    certo("…e fecha", !(await na(`document.querySelector(".transp-lupa").open`)));

    await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
    await cdp("Page.navigate", { url: `${BASE}/transparencia/#doc-${idAgo}` });
    await ate(`document.readyState === "complete"`); await espera(500);
    const largura = await na(`({ pagina: document.documentElement.scrollWidth, tela: innerWidth })`);
    certo("no celular, a página não ganha barra lateral", largura.pagina <= largura.tela, JSON.stringify(largura));
    await cdp("Emulation.clearDeviceMetricsOverride");

    /* ---------------------------------------------------- o painel */
    await cdp("Page.navigate", { url: BASE + "/admin/" });
    await ate(`!!document.querySelector("#documentos-list .transp-adm")`);
    const grupos = await na(`[...document.querySelectorAll(".transp-adm__ano")].map((h) => h.firstChild.textContent.trim())`);
    certo("no painel, as publicações vêm agrupadas por ano, do mais novo", JSON.stringify(grupos) === JSON.stringify(["2026", "2025", "2018"]), JSON.stringify(grupos));
    const titulos = await na(`[...document.querySelectorAll('.transp-adm [data-f="title"]')].slice(0, 5).map((i) => i.value)`);
    certo("…na mesma ordem do site (ano todo, depois o mês mais recente)", titulos[0] === "Relatório anual 2026" && titulos[2] === "Mês de Outubro"
      && titulos[3] === "Mês de Setembro" && titulos[4] === "Mês de Agosto <script>alert(1)</script>", JSON.stringify(titulos));
    certo("…e o rascunho de Novembro aparece só no painel, para ser preenchido", titulos[1] === "");

    /* + PDF pelo botão de verdade, numa publicação sem anexos (Setembro). */
    const idSet = await idDe("Mês de Setembro");
    const arqPdf = path.join(TMP, "Prestação de contas setembro.pdf"); fs.writeFileSync(arqPdf, PDF);
    await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
    eventos.length = 0;
    await na(`[...document.querySelectorAll("#doc-adm-${idSet} .anexos__botoes button")].find((b) => b.textContent.includes("PDF")).click()`, true);
    let escolha = null;
    for (let t = 0; t < 5000 && !escolha; t += 100) { escolha = eventos.find((e) => e.method === "Page.fileChooserOpened"); if (!escolha) await espera(100); }
    certo("o + PDF abre o seletor de arquivo", !!escolha);
    if (escolha) await cdp("DOM.setFileInputFiles", { files: [arqPdf], backendNodeId: escolha.params.backendNodeId });
    await ate(`document.querySelectorAll("#anexos-${idSet} .anexo").length === 1`);
    let setDb = null;
    for (let t = 0; t < 6000; t += 300) { setDb = (await conteudo()).find((d) => d.id === idSet); if (setDb && setDb.anexos && setDb.anexos !== "[]") break; await espera(300); }
    const anexSet = JSON.parse((setDb && setDb.anexos) || "[]");
    certo("o PDF entra na publicação e já fica SALVO (sem depender do Salvar)", anexSet.length === 1 && anexSet[0].tipo === "pdf"
      && anexSet[0].titulo === "Prestação de contas setembro", JSON.stringify(anexSet));

    /* + Fotos com uma foto "de celular" de 3000 px: tem de subir reduzida. */
    const grandeB64 = await na(`(() => { const c = document.createElement("canvas"); c.width = 3000; c.height = 2000;
      const g = c.getContext("2d"); g.fillStyle = "#1EA1E4"; g.fillRect(0, 0, 3000, 2000); g.fillStyle = "#C8735B"; g.fillRect(500, 500, 900, 700);
      return c.toDataURL("image/png").split(",")[1]; })()`);
    const arqFoto = path.join(TMP, "foto-celular.png"); fs.writeFileSync(arqFoto, Buffer.from(grandeB64, "base64"));
    eventos.length = 0;
    await na(`[...document.querySelectorAll("#doc-adm-${idSet} .anexos__botoes button")].find((b) => b.textContent.includes("Fotos")).click()`, true);
    escolha = null;
    for (let t = 0; t < 5000 && !escolha; t += 100) { escolha = eventos.find((e) => e.method === "Page.fileChooserOpened"); if (!escolha) await espera(100); }
    if (escolha) await cdp("DOM.setFileInputFiles", { files: [arqFoto], backendNodeId: escolha.params.backendNodeId });
    await ate(`document.querySelectorAll("#anexos-${idSet} .anexo").length === 2`);
    await espera(800);
    const anexSet2 = JSON.parse(((await conteudo()).find((d) => d.id === idSet) || {}).anexos || "[]");
    const fotoNova = anexSet2.find((a) => a.tipo === "foto");
    const medida = fotoNova && await na(`new Promise((ok) => { const i = new Image(); i.onload = () => ok({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => ok(null); i.src = ${JSON.stringify(fotoNova ? fotoNova.url : "")}; })`);
    certo("a foto de 3000 px sobe reduzida a 1920 px, em JPEG", fotoNova && /\.jpg$/.test(fotoNova.url) && medida && medida.w === 1920 && medida.h === 1280, JSON.stringify({ fotoNova, medida }));

    /* Trocar o ano e salvar reagrupa a publicação na hora. */
    await na(`(() => { const a = document.querySelector('[data-t="documentos"][data-id="${idSet}"][data-f="ano"]'); a.value = "2025"; })()`);
    await na(`[...document.querySelectorAll("#doc-adm-${idSet} button")].find((b) => b.textContent === "Salvar").click()`, true);
    await ate(`[...document.querySelectorAll(".transp-adm__ano")].some((h) => /2025/.test(h.textContent) && /2 publica/.test(h.textContent))`, 6000);
    const ano25 = await na(`(() => { const hs = [...document.querySelectorAll(".transp-adm__ano")]; const h = hs.find((x) => /^2025/.test(x.textContent.trim())); const out = []; let el = h && h.nextElementSibling; while (el && !el.matches(".transp-adm__ano")) { out.push(el.querySelector('[data-f="title"]').value); el = el.nextElementSibling; } return out; })()`);
    certo("trocar o ano e salvar leva a publicação para o grupo do novo ano, já em ordem", JSON.stringify(ano25) === JSON.stringify(["Mês de Setembro", "Mês de Março"]), JSON.stringify(ano25));
    const doBanco = (await conteudo()).find((d) => d.id === idSet);
    certo("…e o banco guardou o ano novo sem perder os anexos", doBanco.ano === "2025" && JSON.parse(doBanco.anexos).length === 2, JSON.stringify(doBanco));

    /* "+ Nova publicação": nasce no ano e mês de hoje, e o cursor vai para ELA
       (que, ordenada, nem sempre é a primeira da lista). */
    await na(`document.querySelector('.navbtn[data-p="transparencia"]').click()`, true);
    await espera(300);
    const antes = (await conteudo()).length;
    await na(`[...document.querySelectorAll("#p-transparencia button")].find((b) => b.textContent.includes("Nova publicação")).click()`, true);
    await ate(`document.querySelectorAll(".transp-adm").length === ${antes + 1}`, 6000);
    const nova = (await conteudo()).sort((a, b) => b.id - a.id)[0];
    const hoje = new Date();
    certo("a publicação nova nasce no ano e no mês de hoje", nova.ano === String(hoje.getFullYear()) && nova.mes === hoje.getMonth() + 1, JSON.stringify(nova));
    await espera(700);
    certo("…e o cursor vai para o card DELA", await na(`document.activeElement && document.activeElement.closest(".transp-adm")?.id === "doc-adm-${nova.id}"`));
    /* Sair da tela descarta o que ficou em branco (o rascunho de Novembro e
       esta) — e só isso. */
    await na(`document.querySelector('.navbtn[data-p="home"]').click()`, true);
    await espera(1500);
    const sobrou = (await conteudo()).map((d) => d.title);
    certo("ao sair da tela, as publicações em branco são descartadas", !sobrou.includes("") && sobrou.length === antes - 1, JSON.stringify(sobrou));
    certo("…e as que têm conteúdo continuam todas", ["Mês de Setembro", "Mês de Outubro", "Relatório anual 2026", "Mês de Março", "Zz Qa Relatório de 2018"].every((t) => sobrou.includes(t)));

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
