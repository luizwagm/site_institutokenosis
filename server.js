/* ==========================================================================
   server.js — Gerenciador do site Instituto Kenósis
   Node puro + SQLite nativo (node:sqlite) — zero dependências.
   · Site:   http://localhost:5189/
   · Painel: http://localhost:5189/admin/   (senha inicial mostrada só no 1º boot)
   "Publicar" regenera o index.html (marcadores <!--#KEY-->) e o config.js.
   ========================================================================== */
const http = require("node:http");
// Sistema de gestão da ONG — módulo independente, banco próprio (data/gestao.db).
// Só compartilha o processo e a porta; ver restrito.js.
const { handleRestrito, handleExterno, listarProjetos, contarProjetos, importarProjetos } = require("./restrito");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5189;   // PORT permite subir uma cópia para testes

/* Versão do gerenciador — fonte única da verdade. O painel lê daqui pela API,
   não do HTML: assim, mesmo com o navegador servindo o admin do cache, o número
   exibido é sempre o da versão que está REALMENTE rodando no servidor.
   Subir ao publicar alterações no painel ou no server.js. */
const APP_VERSION = "2.0.0";
// CSP das telas autenticadas (painel). Bloqueia script/estilo/objeto externos;
// só libera as fontes do Google (CSS + arquivos) que o painel usa.
const CSP_PAINEL = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'";
const UPLOAD_DIR = path.join(ROOT, "assets", "img", "uploads");
fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(ROOT, "data", "site.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, text TEXT, sort INTEGER DEFAULT 0);
  -- a coluna categoria agrupa os serviços na listagem; slug/content vêm do molde herdado

  -- portfolio guarda os PARCEIROS institucionais (nome, descrição da parceria, logo)
  CREATE TABLE IF NOT EXISTS portfolio (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, subtitle TEXT, image TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT, bio TEXT, photo TEXT, sort INTEGER DEFAULT 0);

  -- Projetos socioassistenciais (SASF, SEDESP, Movimento para a Vida). Cada um
  -- vira uma página própria: é o conteúdo que sustenta edital e parceria.
  CREATE TABLE IF NOT EXISTS projetos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE, sigla TEXT, status TEXT, resumo TEXT, publico TEXT,
    content TEXT, sort INTEGER DEFAULT 0);

  -- Transparência: relatórios, estatuto, atas. Para OSC, prestação de contas
  -- pública é o que converte doador, parceiro e órgão público.
  CREATE TABLE IF NOT EXISTS documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    tipo TEXT, ano TEXT, url TEXT, sort INTEGER DEFAULT 0);
  -- Galeria/mídia: biblioteca de imagens do site. Envie aqui uma vez, copie o
  -- link e reaproveite em qualquer campo de imagem das outras áreas.
  CREATE TABLE IF NOT EXISTS galeria (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL,
    categoria TEXT, descricao TEXT, sort INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    excerpt TEXT, content TEXT, image TEXT, date TEXT, sort INTEGER DEFAULT 0);

  -- Contador de acessos do site público. O IP nunca é gravado em claro:
  -- guardamos só o hash (LGPD — dado pseudonimizado, não reversível na prática).
  CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash TEXT NOT NULL, path TEXT, referrer TEXT, ua TEXT, day TEXT NOT NULL, ts INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_visits_ip_ts ON visits(ip_hash, ts);
  CREATE INDEX IF NOT EXISTS idx_visits_day ON visits(day);
  CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
`);

// `categoria` agrupa os serviços na home e em /servicos/ — sem ela, instalação
// nova sobe com a lista inteira sem agrupamento e o aplicar-original.js falha
for (const col of ["slug TEXT DEFAULT ''", "content TEXT DEFAULT ''", "categoria TEXT DEFAULT ''"]) {
  try { db.exec(`ALTER TABLE services ADD COLUMN ${col}`); } catch {}
}
// guia de profissionais: WhatsApp próprio, especialidades que atende e se sai na home
for (const col of ["whatsapp TEXT DEFAULT ''", "especialidades TEXT DEFAULT ''", "na_home INTEGER DEFAULT 0"]) {
  try { db.exec(`ALTER TABLE team ADD COLUMN ${col}`); } catch {}
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");


/* --------------------------------------------------------------------------
   Senha do painel — scrypt com salt individual.
   SHA-256 é rápido de propósito: uma GPU testa bilhões por segundo, então um
   banco vazado entrega a senha em minutos. O scrypt é deliberadamente lento e
   exige 16 MB de memória por tentativa, o que inviabiliza ataque em escala.
   Formato guardado: scrypt$N$r$p$salt$derivado
   -------------------------------------------------------------------------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

// comparação sempre em tempo constante — igualdade com === vaza informação pelo tempo
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function confereSenha(senha, guardado) {
  if (!guardado) return false;
  if (!guardado.startsWith("scrypt$")) {
    // formato antigo (sha256 puro): ainda aceita para não travar ninguém —
    // quem chama migra logo depois de validar
    return iguais(Buffer.from(sha(senha)), Buffer.from(guardado));
  }
  const [, N, r, p, saltHex, dkHex] = guardado.split("$");
  const dk = crypto.scryptSync(String(senha), Buffer.from(saltHex, "hex"), dkHex.length / 2,
    { N: +N, r: +r, p: +p });
  return iguais(Buffer.from(dkHex, "hex"), dk);
}

const senhaEhAntiga = (guardado) => !!guardado && !guardado.startsWith("scrypt$");
const getS = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
const setS = (k, v) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/* ==========================================================================
   Contador de acessos — só visitas humanas ao site público.
   Um mesmo IP conta 1 vez por janela de VISIT_WINDOW_MIN minutos; depois disso
   volta a contar (é uma nova visita, não um novo pageview). IPs diferentes
   contam sempre. Nada disso aparece no site — só em /api/stats, com sessão.
   ========================================================================== */
const VISIT_WINDOW_MIN = 30;
// Salt persistido: sem ele o hash de um IPv4 seria quebrável por força bruta
// (só existem 4 bilhões). Com salt aleatório por instalação, deixa de ser.
if (!getS("visit_salt")) setS("visit_salt", crypto.randomBytes(24).toString("hex"));
const VISIT_SALT = getS("visit_salt");

const BOT_RE = /bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|preview|monitor|uptime|curl|wget|python-requests|axios|headless|lighthouse|pagespeed|semrush|ahrefs|mj12|dotbot|petalbot|gptbot|ccbot|claudebot|perplexity/i;

function clientIp(req) {
  // atrás do nginx o socket é sempre 127.0.0.1 — o IP real vem no X-Forwarded-For
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.headers["x-real-ip"] || req.socket.remoteAddress || "";
}

function trackVisit(req, pathname) {
  try {
    if (req.method !== "GET") return;
    const ua = String(req.headers["user-agent"] || "");
    if (!ua || BOT_RE.test(ua)) return;                 // robôs não são visita
    if (req.headers["sec-fetch-dest"] === "iframe") return;

    const ipHash = sha(VISIT_SALT + clientIp(req));
    const agora = Date.now();
    const ultima = db.prepare("SELECT ts FROM visits WHERE ip_hash=? ORDER BY ts DESC LIMIT 1").get(ipHash);
    if (ultima && agora - Number(ultima.ts) < VISIT_WINDOW_MIN * 60_000) return;  // ainda na mesma visita

    const ref = String(req.headers.referer || "");
    db.prepare("INSERT INTO visits(ip_hash,path,referrer,ua,day,ts) VALUES(?,?,?,?,?,?)")
      .run(ipHash, pathname.slice(0, 300),
        ref.includes("institutokenosis.com") || ref.includes("localhost") ? "" : ref.slice(0, 300),
        ua.slice(0, 300), new Date(agora).toISOString().slice(0, 10), agora);
  } catch { /* medir acesso nunca pode derrubar a entrega da página */ }
}

/* Retenção: a LGPD exige prazo definido, não "para sempre". 12 meses é o que
   permite comparar ano a ano; passou disso, o registro é apagado sozinho. */
const VISIT_RETENCAO_MESES = 12;
function limparVisitasAntigas() {
  try {
    const corte = Date.now() - VISIT_RETENCAO_MESES * 30 * 86_400_000;
    const r = db.prepare("DELETE FROM visits WHERE ts < ?").run(corte);
    if (r.changes) console.log(`  · contador: ${r.changes} registro(s) com mais de ${VISIT_RETENCAO_MESES} meses apagados`);
  } catch { /* nunca derruba o servidor */ }
}
limparVisitasAntigas();
setInterval(limparVisitasAntigas, 24 * 3600 * 1000).unref();

function statsAcessos() {
  const hoje = new Date().toISOString().slice(0, 10);
  const desde = (dias) => Date.now() - dias * 86_400_000;
  const num = (sql, ...p) => Number(db.prepare(sql).get(...p)?.n || 0);
  return {
    total: num("SELECT COUNT(*) n FROM visits"),
    hoje: num("SELECT COUNT(*) n FROM visits WHERE day=?", hoje),
    semana: num("SELECT COUNT(*) n FROM visits WHERE ts>=?", desde(7)),
    mes: num("SELECT COUNT(*) n FROM visits WHERE ts>=?", desde(30)),
    visitantes: num("SELECT COUNT(DISTINCT ip_hash) n FROM visits"),
    visitantesMes: num("SELECT COUNT(DISTINCT ip_hash) n FROM visits WHERE ts>=?", desde(30)),
    porDia: db.prepare("SELECT day, COUNT(*) total FROM visits WHERE ts>=? GROUP BY day ORDER BY day").all(desde(30)),
    topPaginas: db.prepare("SELECT path, COUNT(*) total FROM visits GROUP BY path ORDER BY total DESC LIMIT 12").all(),
    origens: db.prepare("SELECT referrer, COUNT(*) total FROM visits WHERE referrer<>'' GROUP BY referrer ORDER BY total DESC LIMIT 8").all(),
    janelaMin: VISIT_WINDOW_MIN,
  };
}
setInterval(limparVisitasAntigas, 24 * 3600 * 1000).unref();


/* --------------------------------------------------------------------------
   Migração dos textos para o banco.
   Em vez de repetir aqui os valores padrão (que sairiam do ar com o HTML), a
   migração LÊ o conteúdo que já está entre os marcadores nos arquivos e grava
   no banco. Resultado: nada muda de aparência ao atualizar, e nenhuma chave
   fica em branco. Só preenche o que ainda não existe — nunca sobrescreve
   edição feita pelo cliente no painel.
   -------------------------------------------------------------------------- */
const IMG_TAG = {
  img_hero:        { w: 620, h: 775, extra: 'fetchpriority="high" decoding="async"' },   // 4/5 no CSS
  img_instituicao: { w: 620, h: 744, extra: 'loading="lazy" decoding="async"' },         // 5/6 no CSS
};

function lerMarcador(html, chave) {
  const m = new RegExp(`<!--#${chave}-->([\\s\\S]*?)<!--/${chave}-->`).exec(html);
  return m ? m[1].trim() : null;
}

function migrarTextos() {
  const arquivos = [
    path.join(ROOT, "index.html"),
    // todos os templates: é deles que saem os valores iniciais dos marcadores
    ...fs.readdirSync(path.join(ROOT, "src")).filter((n) => n.endsWith(".html"))
      .map((n) => path.join(ROOT, "src", n)),
  ];
  let novos = 0;
  for (const arq of arquivos) {
    if (!fs.existsSync(arq)) continue;
    const html = fs.readFileSync(arq, "utf8");
    // [A-Z0-9_] e não [A-Z_]: chaves como MVV_T1 e BTN_HERO_1 têm dígito e
    // eram silenciosamente ignoradas pela migração
    for (const m of html.matchAll(/<!--#([A-Z0-9_]+)-->/g)) {
      const chave = m[1].toLowerCase();
      if (!KEYS.includes(chave)) continue;      // marcador de bloco gerado, não é texto editável
      if (getS(chave) !== undefined) continue;  // já existe: respeita o que o cliente salvou
      let valor = lerMarcador(html, m[1]) || "";
      if (chave.startsWith("img_")) {
        // guarda só a URL e o alt; a tag <img> é remontada na publicação
        const src = /src="([^"]+)"/.exec(valor);
        const alt = /alt="([^"]*)"/.exec(valor);
        if (getS(chave + "_alt") === undefined && alt) setS(chave + "_alt", alt[1]);
        valor = src ? src[1] : "";
      }
      if (chave === "online_list" || chave === "about_bullets") {
        valor = [...valor.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => x[1].trim()).join("\n");
      }
      // blocos repetidos viram "Título | Descrição [| link]", uma linha por item
      if (chave === "ticker") {
        // o HTML tem 4 grupos repetidos; guarda só a lista, sem duplicar
        valor = [...new Set([...valor.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((x) => x[1].trim()))].join("\n");
      }
      if (chave === "passos_itens") {
        valor = [...valor.matchAll(/step__title">([\s\S]*?)<\/h3>[\s\S]*?step__text">([\s\S]*?)<\/p>/g)]
          .map((x) => `${x[1].trim()} | ${x[2].trim()}`).join("\n");
      }
      if (chave === "empresas_cards") {
        valor = [...valor.matchAll(/<article[\s\S]*?service__title">([\s\S]*?)<\/h3>\s*<p class="service__text">([\s\S]*?)<\/p>([\s\S]*?)<\/article>/g)]
          .map((x) => {
            const link = /href="([^"]+)"/.exec(x[3]);
            return `${x[1].trim()} | ${x[2].trim()}${link ? ` | ${link[1]}` : ""}`;
          }).join("\n");
      }
      setS(chave, valor);
      novos++;
    }
  }
  if (getS("img_og") === undefined) setS("img_og", "/assets/img/og-image.png");
  if (getS("manutencao") === undefined) setS("manutencao", "0");
  if (getS("manutencao_titulo") === undefined) setS("manutencao_titulo", "Estamos atualizando o site");
  if (getS("manutencao_texto") === undefined) setS("manutencao_texto", "Volte em instantes.");
  if (novos) console.log(`  · ${novos} texto(s) do site migrados para o painel`);
}

/* ==========================================================================
   Modo manutenção — duas camadas, porque uma sozinha não cobre tudo:

   1) Aqui no app: com a chave ligada, todo visitante recebe a página de aviso
      com HTTP 503. Quem está logado no painel continua vendo o site normal,
      para conferir antes de reabrir.
   2) No nginx: o mesmo arquivo é servido quando o app está FORA DO AR (502/
      503/504). É o que cobre restart, deploy, git stash e qualquer queda —
      momentos em que o app não existe para responder nada.

   Por isso a página é gravada em disco como arquivo estático: o nginx precisa
   conseguir lê-la sem depender do Node.
   ========================================================================== */
const emManutencao = () => getS("manutencao") === "1";

function gerarPaginaManutencao(S) {
  const titulo = S.manutencao_titulo || "Estamos atualizando o site";
  const texto = S.manutencao_texto || "Volte em instantes.";
  // O símbolo entra inline: com o app fora do ar o nginx só serve este arquivo,
  // então nada de /assets/ carrega — imagem referenciada apareceria quebrada.
  let simbolo = "";
  try {
    simbolo = fs.readFileSync(path.join(ROOT, "assets", "img", "simbolo.svg"), "utf8")
      .replace(/<\?xml[^>]*\?>/, "")
      .replace("<svg", '<svg class="marca-svg" role="img" aria-label="Instituto Kenósis"');
  } catch { /* sem o arquivo a página ainda se sustenta pelo texto */ }

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(titulo)} — Instituto Kenósis</title>
  <link rel="icon" type="image/svg+xml" href="/assets/img/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;1,9..144,600&family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
  <style>
    /* CSS embutido de propósito: se o app estiver fora do ar, o styles.css
       também não é servido — a página precisa se sustentar sozinha. */
    *{box-sizing:border-box;margin:0}
    body{min-height:100vh;display:grid;place-items:center;padding:2rem;position:relative;overflow:hidden;
      font:400 16px/1.7 Outfit,system-ui,sans-serif;color:#253282;background:#FAF7F2}
    /* auréola: o mesmo motivo de arcos concêntricos que assina o site */
    .aureola{position:absolute;inset:auto;left:50%;top:50%;translate:-50% -50%;
      width:min(150vw,1100px);aspect-ratio:1;pointer-events:none}
    .aureola span{position:absolute;inset:0;margin:auto;border-radius:50%;
      border:1.5px solid rgba(30,161,228,.16)}
    .aureola span:nth-child(1){width:34%;height:34%}
    .aureola span:nth-child(2){width:52%;height:52%}
    .aureola span:nth-child(3){width:70%;height:70%}
    .aureola span:nth-child(4){width:88%;height:88%}
    .aureola span:nth-child(5){width:100%;height:100%}
    .caixa{position:relative;width:min(560px,100%);background:#fff;border-radius:24px;
      padding:clamp(2rem,5vw,3.2rem);text-align:center;
      border:1px solid rgba(37,50,130,.08);box-shadow:0 26px 60px rgba(37,50,130,.12)}
    .marca-svg{width:96px;height:auto;margin:0 auto 1.6rem;display:block}
    h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:clamp(1.7rem,4.6vw,2.4rem);
      line-height:1.2;color:#253282;margin-bottom:.8rem}
    h1 em{font-style:italic;color:#1EA1E4}
    p{color:#5a6180;font-weight:300;font-size:1.05rem}
    .zap{display:inline-flex;align-items:center;gap:.5rem;margin-top:1.6rem;padding:.85rem 1.6rem;
      border-radius:999px;background:#1EA1E4;color:#fff;text-decoration:none;font-weight:600;
      transition:background .2s ease}
    .zap:hover{background:#253282}
    .marca{margin-top:2rem;padding-top:1.4rem;border-top:1px solid #ece8e0;
      font-family:Outfit,sans-serif;font-weight:600;letter-spacing:.02em;color:#253282}
    .marca small{display:block;font-weight:400;font-size:.82rem;color:#8d92a8;letter-spacing:.06em;
      text-transform:uppercase;margin-top:.25rem}
    .pulso{animation:pulso 3s ease-in-out infinite}
    @keyframes pulso{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.8;transform:scale(.97)}}
    @media(prefers-reduced-motion:reduce){.pulso{animation:none}}
  </style>
</head>
<body>
  <div class="aureola" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
  <main class="caixa">
    <div class="pulso">${simbolo}</div>
    <h1>${esc(titulo)}</h1>
    <p>${esc(texto)}</p>
    ${S.whatsapp ? `<a class="zap" href="https://wa.me/${esc(S.whatsapp)}" target="_blank" rel="noopener">Falar no WhatsApp</a>` : ""}
    <p class="marca">Instituto Kenósis<small>Fonte das Graças Conceição &amp; Menezes</small></p>
  </main>
</body>
</html>`;
  fs.writeFileSync(path.join(ROOT, "manutencao.html"), html);
  return html;
}

/* Remonta a tag <img> a partir da URL e do alt guardados no painel */
function tagImagem(chave, S) {
  const cfg = IMG_TAG[chave] || { w: 800, h: 600, extra: 'loading="lazy" decoding="async"' };
  const src = S[chave] || "";
  const alt = S[chave + "_alt"] || "";
  if (!src) return "";
  return `<img src="${esc(src)}" alt="${esc(alt)}" width="${cfg.w}" height="${cfg.h}" ${cfg.extra}>`;
}

/* ------------------------------- Seed ------------------------------------ */
function seed() {
  if (getS("hero_titulo")) return;

  /* Conteúdo vindo do site atual (sites.google.com/view/institutokenosis), capturado
     na íntegra em CONTEUDO-SITE-ATUAL.md. Nada inventado. Campos que o site atual
     NÃO informa — endereço, telefone, doação — ficam vazios: o cliente preenche. */
  const S = {
    admin_password_hash: hashSenha("kenosis-admin"),

    hero_rotulo: "Organização da Sociedade Civil · Caruaru-PE",
    hero_titulo: "Servir é <em>transformar vidas</em>.",
    hero_texto: "O Instituto Kenósis é uma Organização da Sociedade Civil que atua na promoção da cidadania, na proteção social, no fortalecimento dos vínculos familiares e comunitários e na valorização da dignidade humana.",
    selo_osc: "OSC constituída · CNPJ 63.991.397/0001-40",
    btn_hero_1: "Quero ajudar",
    btn_hero_2: "Conhecer os projetos",
    img_hero: "",
    img_hero_alt: "",
    numeros: JSON.stringify([]),

    sec_nome_rotulo: "O nome",
    sec_nome_titulo: "Kénosis é <em>esvaziar-se</em> para servir",
    sec_nome_texto: "Do grego κένωσις, kénosis descreve o gesto de abrir mão de si mesmo em favor do outro. É desse conceito que nasce o nosso jeito de trabalhar: colocar a pessoa atendida no centro, escutar antes de propor e reconhecer que ninguém se transforma sozinho.",

    sec_inst_rotulo: "A instituição",
    sec_inst_titulo: "Quem <em>somos</em>",
    sec_inst_texto: "Contribuímos para a prevenção de vulnerabilidades e riscos sociais por meio de atividades socioeducativas, acolhimento, orientação e convivência comunitária. Oferecemos também atendimentos em Psicanálise, Acupuntura e Nutrição, entendendo que o cuidado integral da pessoa fortalece sua capacidade de enfrentamento das dificuldades cotidianas.",
    inst_valores: JSON.stringify([
      "Atuação alinhada à LOAS, à PNAS, à NOB/SUAS e à Tipificação Nacional",
      "Acolhimento e escuta qualificada como porta de entrada",
      "Transparência e prestação de contas à sociedade",
      "Respeito à diversidade e à dignidade da pessoa humana",
    ]),
    btn_institucional: "Conhecer a instituição",
    img_instituicao: "",
    img_instituicao_alt: "",
    mvv_t1: "Missão",
    mvv_missao: "Promover ações que contribuam para o fortalecimento da cidadania, da convivência familiar e comunitária, da inclusão social e do desenvolvimento humano, por meio de projetos socioassistenciais, atividades socioeducativas e iniciativas que favoreçam a autonomia, a participação social e a melhoria da qualidade de vida da população.",
    mvv_t2: "Visão",
    mvv_visao: "Ser reconhecido como uma Organização da Sociedade Civil de referência na promoção da cidadania, no fortalecimento da proteção social básica e no desenvolvimento de projetos que gerem impacto social positivo, contribuindo para uma sociedade mais justa, solidária e inclusiva.",
    mvv_t3: "Valores",
    mvv_valores: "Dignidade da pessoa humana · Ética e transparência · Respeito à diversidade · Inclusão social · Promoção da cidadania · Solidariedade · Compromisso com a comunidade · Valorização da família · Desenvolvimento humano · Responsabilidade social.",

    sec_serv_rotulo: "Áreas de atuação",
    sec_serv_titulo: "O que o Instituto <em>oferece</em>",
    sec_serv_sub: "Programas, projetos e serviços de interesse social conforme a Constituição Federal, a LOAS, a PNAS, a NOB/SUAS e a Tipificação Nacional dos Serviços Socioassistenciais.",
    btn_ver_servicos: "Ver todos os serviços",

    sec_proj_rotulo: "Projetos",
    sec_proj_titulo: "Iniciativas que <em>saem do papel</em>",
    sec_proj_sub: "Ações socioassistenciais alinhadas ao Sistema Único de Assistência Social (SUAS), voltadas à proteção social básica e ao fortalecimento de vínculos.",

    sec_transp_rotulo: "Transparência",
    sec_transp_titulo: "Contas <em>abertas</em> à sociedade",
    sec_transp_sub: "Publicamos relatórios de atendimentos, ações e atividades institucionais. A divulgação reafirma nosso compromisso com a prestação de contas, a boa governança e a responsabilidade institucional.",
    btn_transparencia: "Ver todos os documentos",

    sec_ajudar_rotulo: "Como participar",
    sec_ajudar_titulo: "Três formas de <em>fazer parte</em>",
    sec_ajudar_sub: "A transformação social acontece pelo fortalecimento das pessoas, das famílias e da comunidade. Você pode caminhar junto.",
    ajudar_cards: [
      "01 | Seja voluntário | Doe seu tempo e seu talento. O trabalho voluntário segue a Lei nº 9.608/1998 e dá direito a certificado de participação e horas complementares. | Quero ser voluntário | /voluntariado/",
      "02 | Entre no banco de talentos | Envie seu currículo para ser considerado em futuras oportunidades nos projetos e ações do Instituto. | Enviar currículo | /banco-de-talentos/",
      "03 | Seja parceiro | Empresas e instituições que cedem espaço, recursos ou conhecimento ampliam nossa capacidade de atender a comunidade. | Falar sobre parceria | #contato",
    ].join("\n"),

    sec_dir_rotulo: "Quem conduz",
    sec_dir_titulo: "Diretoria <em>executiva</em>",
    btn_organograma: "Ver o organograma completo",

    sec_mem_rotulo: "Memória institucional",
    sec_mem_titulo: "O que <em>já fizemos</em>",
    sec_mem_sub: "O registro das nossas ações, encontros e conquistas — porque história de instituição também se presta contas.",
    btn_ver_memoria: "Ver toda a memória",

    sec_cont_rotulo: "Fale conosco",
    sec_cont_titulo: "Vamos <em>conversar</em>?",
    sec_cont_sub: "Quer participar, propor uma parceria ou entender melhor o nosso trabalho? Escreva — respondemos a todos.",
    form_assuntos: JSON.stringify([
      "Quero ser voluntário",
      "Enviar currículo (banco de talentos)",
      "Proposta de parceria",
      "Preciso de atendimento",
      "Imprensa",
      "Outro assunto",
    ]),
    btn_form: "Enviar pelo WhatsApp",
    form_aviso: "🔒 Seus dados são usados apenas para este contato.",

    pg_inst_titulo: "A <em>instituição</em>",
    pg_inst_texto: "Governança, diretoria, estatuto e parcerias — tudo o que sustenta formalmente o nosso trabalho.",
    pg_serv_titulo: "Nossos <em>serviços</em>",
    pg_serv_texto: "O que oferecemos à população, organizado por área de atuação.",
    pg_proj_titulo: "Nossos <em>projetos</em>",
    pg_proj_texto: "Iniciativas socioassistenciais alinhadas ao SUAS, em execução e em planejamento institucional.",
    pg_transp_titulo: "<em>Transparência</em> e prestação de contas",
    pg_transp_texto: "Relatórios de atendimentos, ações e atividades institucionais, abertos à comunidade, aos parceiros e aos órgãos públicos.",
    pg_vol_titulo: "Seja <em>voluntário</em>",
    pg_vol_texto: "Doe seu tempo e seu talento. O trabalho voluntário transforma quem recebe e quem oferece.",
    pg_vol_conteudo: "O Instituto Kenósis Fonte das Graças Conceição & Menezes acredita que o trabalho voluntário é uma das formas mais generosas de participação social.\n\nPara integrar o programa, envie seu currículo para contato@institutokenosis.com informando a atividade ou área desejada, sua disponibilidade de dias e horários e, se for estudante, a instituição de ensino e o curso. A equipe analisa o currículo e entra em contato conforme as necessidades dos projetos.\n\nO programa segue a Lei nº 9.608/1998 (Lei do Serviço Voluntário) e pressupõe o cumprimento de dias, horários e atividades previamente acordados, além de compromisso, responsabilidade, ética e espírito de cooperação.\n\nO que você recebe: desenvolvimento pessoal e profissional, Certificado de Participação, possibilidade de consideração em futuros processos seletivos e horas complementares reconhecidas.",
    pg_talentos_titulo: "Banco de <em>talentos</em>",
    pg_talentos_texto: "Pessoas comprometidas com a ética, a responsabilidade social e o desenvolvimento humano são fundamentais para construir uma sociedade mais justa e solidária.",
    pg_talentos_conteudo: "Se você deseja integrar nossa equipe, participar de futuros processos seletivos ou colaborar com nossos projetos socioassistenciais e ações institucionais, envie seu currículo para compor o nosso Banco de Talentos.\n\nOs currículos cadastrados poderão ser considerados em futuras oportunidades de atuação, conforme a disponibilidade de vagas, o perfil profissional, as necessidades institucionais e os requisitos exigidos para cada função.\n\nComo enviar: mande seu currículo atualizado para contato@institutokenosis.com. No assunto do e-mail, informe preferencialmente: Currículo – Nome Completo – Área de interesse.",
    pg_editais_titulo: "<em>Editais</em> e chamamentos",
    pg_editais_texto: "Publicamos aqui nossos editais, chamamentos públicos e processos de seleção, reafirmando o compromisso com a transparência e a igualdade de oportunidades.",
    pg_editais_conteudo: "Por meio destes editais, pessoas físicas, profissionais, voluntários, parceiros e demais interessados podem acompanhar as oportunidades de participação nas ações, projetos e atividades desenvolvidas pelo Instituto, em conformidade com sua finalidade estatutária e com a legislação aplicável.\n\nEdital de Chamamento para Voluntários — tem como objetivo selecionar pessoas interessadas em contribuir, de forma espontânea, solidária e não remunerada, com as ações, projetos e atividades desenvolvidos pelo Instituto Kenósis Fonte das Graças Conceição & Menezes.",
    pg_mem_titulo: "Memória <em>institucional</em>",
    pg_mem_texto: "O registro das ações, encontros e conquistas do Instituto ao longo do tempo.",
    pg_priv_titulo: "Política de <em>Privacidade</em>",
    pg_priv_texto: "Escrita para ser entendida. Aqui você encontra o que fazemos com os seus dados — e o que não fazemos.",

    rodape_frase: "Cuidar das pessoas é promover dignidade, fortalecer vínculos e construir oportunidades para uma sociedade mais humana, solidária e inclusiva.",
    rodape_h1: "Institucional",
    rodape_h2: "Atuação",
    rodape_h3: "Participe",
    rodape_horario: "Atendimento de segunda a sexta, em horário comercial.",
    rodape_razao: "Instituto Kenósis Fonte das Graças Conceição &amp; Menezes",

    whatsapp: "5581982753906",
    whatsapp_display: "(81) 9.8275-3906",
    phone_fixed: "",
    contact_email: "contato@institutokenosis.com",
    instagram: "kenosisinstituto",
    address: "",
    cnpj: "63.991.397/0001-40",
    img_og: "/assets/img/og-image.png",

    manutencao: "0",
    manutencao_titulo: "Estamos atualizando o site",
    manutencao_texto: "Volte em instantes.",
  };
  for (const [k, v] of Object.entries(S)) setS(k, v);

  /* --------------------------- Áreas de atuação --------------------------- */
  const servicos = [
    ["Acolhimento e escuta qualificada",
     "Porta de entrada do Instituto: escutar antes de propor, para entender o que a pessoa realmente precisa.",
     "A escuta qualificada é o primeiro passo de todo atendimento no Instituto Kenósis. Antes de encaminhar, orientar ou propor qualquer serviço, é preciso entender quem chega, o que já tentou e o que está ao alcance naquele momento da vida.\n\nO acolhimento acontece sem julgamento e sem exigência de contrapartida. A partir dele, a equipe orienta sobre direitos, benefícios e serviços disponíveis, e faz os encaminhamentos necessários para a rede socioassistencial e para as demais políticas públicas."],
    ["Fortalecimento de vínculos familiares e comunitários",
     "Ações que reaproximam famílias e reconstroem o senso de pertencimento à comunidade.",
     "O fortalecimento de vínculos é um dos eixos centrais da Proteção Social Básica do SUAS. Trabalhamos para que a família consiga exercer sua função protetiva e para que a pessoa se reconheça como parte de uma comunidade.\n\nAs ações incluem grupos de convivência, oficinas socioeducativas, rodas de conversa e atividades comunitárias, sempre em formato coletivo, porque é na convivência que o vínculo se refaz."],
    ["Orientação e acompanhamento socioeducativo",
     "Acompanhamento continuado de famílias e indivíduos em situação de vulnerabilidade.",
     "Mais do que um atendimento pontual, o acompanhamento socioeducativo estabelece um vínculo de médio prazo com a família. Isso permite acompanhar a evolução da situação, ajustar encaminhamentos e prevenir que uma vulnerabilidade se transforme em violação de direitos.\n\nInclui atendimentos individualizados, visitas domiciliares quando necessárias, encontros socioeducativos e articulação permanente com a rede socioassistencial."],
    ["Apoio a mulheres em situação de violência",
     "Acolhimento, orientação e encaminhamento para mulheres em situação de violência doméstica e familiar.",
     "O Instituto acolhe, orienta e encaminha mulheres em situação de violência doméstica e familiar, articulando com os serviços especializados da rede de proteção.\n\nO atendimento respeita o tempo de cada mulher e o sigilo é condição inegociável. Nenhuma decisão é imposta: o papel do Instituto é informar sobre direitos, oferecer suporte e garantir que ela saiba que não está sozinha."],
    ["Pessoas com deficiência e suas famílias",
     "Acompanhamento socioassistencial de pessoas com deficiência, transtornos do neurodesenvolvimento e seus familiares.",
     "O acompanhamento envolve tanto a pessoa com deficiência quanto quem cuida dela. Famílias cuidadoras enfrentam sobrecarga, isolamento e dificuldade de acesso a direitos — e isso também é objeto do nosso trabalho.\n\nAs ações incluem orientação sobre benefícios e direitos, encaminhamentos para a rede, grupos de convivência e apoio ao cuidador."],
    ["Acolhimento à população LGBTQIAPN+",
     "Acolhimento, orientação e fortalecimento de vínculos para pessoas LGBTQIAPN+ em situação de vulnerabilidade social.",
     "O respeito à diversidade é um dos valores do Instituto, e ele se traduz em atendimento concreto. Pessoas LGBTQIAPN+ em situação de vulnerabilidade enfrentam com frequência o rompimento de vínculos familiares, o que agrava todas as outras vulnerabilidades.\n\nO trabalho é de acolhimento, orientação sobre direitos, fortalecimento de vínculos e encaminhamento para a rede de proteção."],
    ["Empreendedorismo social e geração de renda",
     "Oficinas de artesanato, cursos de qualificação e capacitação profissional.",
     "Autonomia financeira é parte da autonomia como um todo. O Instituto oferece oficinas de artesanato, cursos de qualificação e capacitação profissional, reconhecendo o trabalho e a qualificação como direitos sociais e como caminhos de inclusão.\n\nAs atividades são pensadas para gerar renda de forma realista, considerando o contexto e as possibilidades de cada participante."],
    ["Palestras, oficinas e rodas de conversa",
     "Ações socioeducativas em assistência social, saúde, educação, cultura, segurança alimentar, esporte, cidadania e direitos humanos.",
     "As ações socioeducativas levam informação onde ela costuma faltar. São palestras, seminários, oficinas e rodas de conversa realizadas na comunidade, em escolas e em espaços cedidos por instituições parceiras.\n\nOs temas cobrem assistência social, saúde, educação, cultura, segurança alimentar, esporte, cidadania e direitos humanos."],
    ["Canto coral e convivência comunitária",
     "Atividades culturais que criam pertencimento e ocupam o tempo com propósito.",
     "O canto coral é uma atividade de convivência: reúne pessoas em torno de um objetivo comum, cria disciplina coletiva e devolve o senso de pertencimento a quem estava isolado.\n\nÉ uma das formas mais diretas de fortalecer vínculos comunitários, e não exige experiência prévia de ninguém."],
    ["Saúde integrativa",
     "Terapia Psicanalítica (individual e casal) e Acupuntura — o cuidado integral fortalece o enfrentamento das dificuldades.",
     "O Instituto oferece atendimento em Terapia Psicanalítica (individual e de casal) e Acupuntura. A premissa é que o cuidado com o corpo, a mente e os aspectos emocionais fortalece a capacidade de enfrentar as dificuldades do dia a dia.\n\nOutros serviços de saúde integrativa estão em implantação e serão oferecidos gradualmente, conforme a celebração de parcerias, a disponibilidade de recursos, as habilitações profissionais e a observância da legislação aplicável."],
  ];
  servicos.forEach(([title, text, content], i) =>
    db.prepare("INSERT INTO services(title,slug,text,content,sort) VALUES(?,?,?,?,?)")
      .run(title, slug(title), text, content, i));

  /* ------------------------------- Projetos ------------------------------- */
  const projetos = [
    ["Movimento para a Vida", "MOV", "Em execução",
     "Serviço de Convivência e Fortalecimento de Vínculos com Atividades Corporais no Meio Aquático (SCFV-AQ).",
     "Prioritariamente idosos, adultos e famílias em situação de vulnerabilidade e risco social com vínculos familiares ou comunitários fragilizados.",
     "Desenvolvido no âmbito do Serviço de Convivência e Fortalecimento de Vínculos (SCFV), integrante da Proteção Social Básica do SUAS, o Movimento para a Vida utiliza atividades corporais realizadas no meio aquático como estratégia socioeducativa.\n\nO objetivo é promover convivência, fortalecer vínculos familiares e comunitários, incentivar a inclusão social, estimular a autonomia e ampliar a participação cidadã. O trabalho é coletivo e respeita a dignidade da pessoa humana, a participação social, a valorização de potencialidades e a promoção da cidadania.\n\nObjetivos: fortalecer vínculos familiares e comunitários; prevenir o isolamento social e a fragilização de vínculos; estimular a convivência grupal e o sentimento de pertencimento; promover autonomia, protagonismo e participação social; valorizar potencialidades individuais e coletivas; incentivar hábitos de vida saudáveis por meio de atividades corporais coletivas; contribuir para a melhoria da qualidade de vida.\n\nFormas de atendimento: atividades corporais no meio aquático realizadas em grupo, encontros de convivência, rodas de conversa, oficinas socioeducativas, ações comunitárias, acompanhamento social quando necessário e articulação com a rede socioassistencial e demais políticas públicas.\n\nResultados esperados: fortalecimento dos vínculos familiares e comunitários; ampliação da convivência social e comunitária; redução do isolamento social; incentivo à participação cidadã; desenvolvimento da autonomia e do protagonismo; promoção da inclusão social; melhoria da qualidade de vida dos participantes."],
    ["Serviço de Assistência Social à Família", "SASF", "Em planejamento institucional",
     "Acompanhamento social a famílias em situação de vulnerabilidade, para fortalecer a função protetiva e prevenir violações de direitos.",
     "Famílias em situação de vulnerabilidade e risco social, com prioridade para aquelas com crianças, adolescentes, idosos, pessoas com deficiência ou membros que demandem acompanhamento.",
     "O SASF integra o planejamento estratégico para ampliação das ações na Proteção Social Básica do SUAS. Desenvolve acompanhamento social às famílias em situação de vulnerabilidade e risco social, visando fortalecer a função protetiva, prevenir violações de direitos, ampliar o acesso às políticas públicas e promover o fortalecimento dos vínculos familiares e comunitários.\n\nObjetivos: fortalecer vínculos familiares e comunitários; prevenir vulnerabilidade, risco social, exclusão e isolamento; promover acesso a direitos, serviços, programas e benefícios socioassistenciais; estimular autonomia, protagonismo e participação social das famílias; fortalecer a função protetiva da família; contribuir para a melhoria da qualidade de vida.\n\nFormas de atendimento: acolhimento social, acompanhamento familiar, atendimentos individualizados, reuniões e encontros socioeducativos, atividades de convivência e fortalecimento de vínculos, visitas domiciliares quando necessárias, oficinas temáticas, rodas de conversa, ações comunitárias, encaminhamentos e articulação com a rede socioassistencial.\n\nResultados esperados: fortalecimento da função protetiva das famílias; fortalecimento dos vínculos familiares e comunitários; ampliação do acesso a direitos e políticas públicas; prevenção de vulnerabilidade e violação de direitos; desenvolvimento da autonomia e participação social; melhoria da qualidade de vida."],
    ["Serviço de Desenvolvimento Social e Produtivo", "SEDESP", "Em planejamento institucional",
     "Ações socioeducativas voltadas ao desenvolvimento humano, à participação cidadã e à qualificação profissional como instrumento de inclusão.",
     "Prioritariamente adolescentes, jovens e adultos entre 15 e 59 anos em situação de vulnerabilidade e risco social, especialmente com vínculos familiares e comunitários fragilizados.",
     "Desenvolvido no âmbito da Proteção Social Básica do SUAS, o SEDESP foca na promoção de convivência, fortalecimento de vínculos familiares e comunitários, inclusão social, autonomia e desenvolvimento de potencialidades.\n\nPromove ações socioeducativas voltadas ao desenvolvimento humano, à participação cidadã e ao fortalecimento de capacidades, reconhecendo a qualificação profissional e o acesso ao trabalho como instrumentos de inclusão social e cidadania. Contribui para a construção de trajetórias de vida mais autônomas, participativas e integradas à comunidade.\n\nObjetivos: fortalecer vínculos familiares e comunitários; prevenir vulnerabilidade, risco social e violação de direitos; promover convivência social e comunitária; estimular o protagonismo de adolescentes, jovens e adultos; desenvolver autonomia e participação cidadã; incentivar o desenvolvimento de competências pessoais, sociais e produtivas; contribuir para o reconhecimento da qualificação profissional e do trabalho como direitos sociais.\n\nFormas de atendimento: grupos de convivência, oficinas socioeducativas, oficinas de desenvolvimento pessoal, social e produtivo, rodas de diálogo e encontros temáticos, ações de orientação para o mundo do trabalho, atividades voltadas ao fortalecimento da cidadania e da participação comunitária, encaminhamentos para a rede socioassistencial e articulação com instituições parceiras e órgãos públicos.\n\nResultados esperados: fortalecimento dos vínculos familiares e comunitários; ampliação da participação social; desenvolvimento da autonomia e do protagonismo; incentivo ao exercício da cidadania; desenvolvimento de competências pessoais, sociais e produtivas; fortalecimento da inclusão social; ampliação de oportunidades de desenvolvimento pessoal e inserção produtiva."],
  ];
  projetos.forEach(([title, sigla, status, resumo, publico, content], i) =>
    db.prepare("INSERT INTO projetos(title,slug,sigla,status,resumo,publico,content,sort) VALUES(?,?,?,?,?,?,?,?)")
      .run(title, slug(title), sigla, status, resumo, publico, content, i));

  /* --------------------------- Diretoria executiva ------------------------ */
  const diretoria = [
    ["Dr. Prof. Ronalldo JM", "Presidente e fundador",
     "Educador, Terapeuta e Psicanalista Clínico. Acupunturista, Ozonioterapeuta e Terapeuta Floral. Especialista em Planejamento e Gestão Escolar e em Medicina Tradicional Chinesa. Mestre e Doutor em Psicanálise. CEO da BemEstarClinic.", 1],
    ["Dr. Prof. Samuel Teixdan", "Vice-presidente",
     "Educador, Terapeuta e Psicanalista Clínico. Doutor em Psicanálise. Fitoterapeuta, Homeopata e Aromaterapeuta. Detox Iônico.", 1],
    ["Wallysson de Menezes Vieira", "Tesoureiro", "", 0],
    ["Maria Renailda de Menezes", "Secretária", "", 0],
    ["Renê da Cruz Silva", "Conselho Fiscal", "", 0],
    ["Christiane Holanda de Melo Lapa", "Conselho Fiscal", "", 0],
    ["Plínio Rafael Silva Ferreira", "Conselho Fiscal", "", 0],
  ];
  diretoria.forEach(([name, role, bio, na_home], i) =>
    db.prepare("INSERT INTO team(name,role,bio,photo,whatsapp,especialidades,na_home,sort) VALUES(?,?,?,'','','',?,?)")
      .run(name, role, bio, na_home, i));

  console.log("  · banco inicializado com o conteúdo real. Senha do painel: kenosis-admin");
}

seed();
// migração leve: garante chaves novas em bancos já existentes
if (!getS("cnpj") || getS("cnpj") === "00.000.000/0001-00") setS("cnpj", "02.192.745/0001-25");

/* ------------------------------ Sessões ---------------------------------- */
/* ------------------------- Sessão e força bruta --------------------------- */
const SESSAO_HORAS = 12;          // sessão parada por mais que isso, cai
const TENTATIVAS_MAX = 5;         // erros de senha antes do bloqueio
const BLOQUEIO_MIN = 15;          // duração do bloqueio por IP

const sessions = new Map();
const authed = (req) => {
  const m = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const inicio = sessions.get(m[1]);
  if (!inicio) return false;
  // sessão sem prazo é sessão eterna: cookie roubado valeria para sempre
  if (Date.now() - inicio > SESSAO_HORAS * 3600_000) { sessions.delete(m[1]); return false; }
  sessions.set(m[1], Date.now());   // renova enquanto estiver em uso
  return true;
};

/* Sem isto, dá para tentar senha à vontade: 100 mil tentativas por minuto
   quebram qualquer senha curta. O bloqueio é por IP e some sozinho. */
const tentativas = new Map();
function loginBloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t) return 0;
  if (Date.now() > t.ate) { tentativas.delete(ip); return 0; }
  return t.erros >= TENTATIVAS_MAX ? Math.ceil((t.ate - Date.now()) / 60000) : 0;
}
function registrarErro(ip) {
  const t = tentativas.get(ip) || { erros: 0, ate: 0 };
  t.erros++;
  t.ate = Date.now() + BLOQUEIO_MIN * 60000;
  tentativas.set(ip, t);
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of tentativas) if (agora > v.ate) tentativas.delete(k);
  for (const [k, v] of sessions) if (agora - v > SESSAO_HORAS * 3600_000) sessions.delete(k);
}, 10 * 60 * 1000).unref();

/* ------------------------------ Publicar --------------------------------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ICONS = [
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a7 7 0 0 1 7 7c0 1.9-.7 3.2-1.7 4.5-.8 1-1.3 2.1-1.3 3.5v3h-6v-2H8a2 2 0 0 1-2-2v-3H4.5L6.2 10A7 7 0 0 1 12 3Z"/><path d="M11 9.5a1.8 1.8 0 1 1 1.8 1.8V13"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/><path d="M9 14a3 3 0 0 0 3 3"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.8 14.6A5.4 5.4 0 0 1 21 20"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12.6 12 20l-7.5-7.4a5 5 0 1 1 7.5-6.3 5 5 0 1 1 7.5 6.3Z"/><path d="M6 12h3l1.5-2 2 3.5L14 12h4"/></svg>',
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20c-5.5 0-8-3.5-8-8 5.5 0 8 3.5 8 8Z"/><path d="M12 20c5.5 0 8-3.5 8-8-5.5 0-8 3.5-8 8Z"/><path d="M12 12c1.6-2.2 1.6-4.8 0-7-1.6 2.2-1.6 4.8 0 7Z"/></svg>',
];
const CHECK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';


function setMarker(html, key, content) {
  const re = new RegExp(`(<!--#${key}-->)[\\s\\S]*?(<!--\\/${key}-->)`);
  if (!re.test(html)) throw new Error(`Marcador ${key} não encontrado`);
  // replacement em função: evita que "$" no conteúdo seja interpretado ($$, $1…)
  return html.replace(re, (_m, open, close) => `${open}\n${content}\n${close}`);
}

/* O Google corta a <title> por volta de 60 caracteres. Com nomes longos ("Serviço
   de Desenvolvimento Social e Produtivo") o sufixo da marca some no meio da
   palavra e o resultado fica truncado feio. Aqui a marca encolhe antes disso, e
   só sai de cena se nem assim couber. */
function tituloSeo(base, limite = 60) {
  const b = String(base).trim();
  for (const sufixo of [" — Instituto Kenósis", " — Kenósis"]) {
    if ((b + sufixo).length <= limite) return b + sufixo;
  }
  return b.length <= limite ? b : b.slice(0, limite - 1).trimEnd() + "…";
}

function publish() {
  const S = {}; for (const r of db.prepare("SELECT key,value FROM settings").all()) S[r.key] = r.value;
  const servicos = db.prepare("SELECT * FROM services ORDER BY sort,id").all();
  const projetos = listarProjetos();   // fonte agora é o sistema de gestão (/restrito)
  const documentos = db.prepare("SELECT * FROM documentos ORDER BY sort,id").all();
  const parceiros = db.prepare("SELECT * FROM portfolio ORDER BY sort,id").all();
  const diretoria = db.prepare("SELECT * FROM team ORDER BY sort,id").all();
  const posts = db.prepare("SELECT * FROM posts ORDER BY date DESC, id DESC").all();

  const SITE = "https://institutokenosis.com";
  const dataBR = (iso) => { const [a, m, d] = String(iso || "").split("-"); return d ? `${d}/${m}/${a}` : iso || ""; };
  const paras = (txt) => String(txt || "").split(/\n{2,}/).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("\n        ");
  const jsonldTag = (o) => `<script type="application/ld+json">\n  ${JSON.stringify(o, null, 2).replace(/\n/g, "\n  ")}\n  </script>`;

  /* Conteúdo longo escrito no painel: "## título" vira h2, "> frase" vira
     destaque e linha em branco separa parágrafo.

     O texto NÃO é escapado — os campos do painel anunciam "aceita HTML", e
     antes disto o publish escapava tudo, então um <strong> digitado pelo
     cliente aparecia como texto na tela. Quem escreve aqui é o administrador
     autenticado, a mesma pessoa que poderia editar os arquivos: não há elevação
     de privilégio em confiar nesse conteúdo. Só o que vem de fora (formulário,
     visitante) continua passando por esc().

     Bloco que já começa com tag de bloco não é embrulhado em <p> — senão um
     <ul> do cliente sairia dentro de um parágrafo, que é HTML inválido. */
  const BLOCO_HTML = /^<(p|div|ul|ol|table|section|figure|h[1-6]|blockquote|pre|iframe|img)[\s>]/i;
  const marcado = (txt) => String(txt || "").split(/\n{2,}/).map((b) => {
    const t = b.trim();
    if (!t) return "";
    if (t.startsWith("## ")) return `<h2>${t.slice(3)}</h2>`;
    if (t.startsWith("> ")) return `<blockquote class="cartao" style="margin:1.4rem 0"><p class="fala__texto">${t.slice(2)}</p></blockquote>`;
    if (BLOCO_HTML.test(t)) return t;
    return `<p>${t.replace(/\n/g, "<br>")}</p>`;
  }).filter(Boolean).join("\n        ");

  /* ============================ blocos da home ============================ */
  const numeros = JSON.parse(S.numeros || "[]").map((n) =>
    `<div class="numero"><dd class="numero__valor">${esc(n.num)}</dd><dt class="numero__rotulo">${esc(n.label)}</dt></div>`).join("\n          ");

  const CHECK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const instValores = JSON.parse(S.inst_valores || "[]").map((v) => `<li>${CHECK} ${esc(v)}</li>`).join("\n          ");

  /* A página original é uma LISTA categorizada — reproduzimos exatamente assim.
     Não existe texto original por serviço, então não se cria página individual
     (seria inventar conteúdo, que é justamente o que não pode). */
  const CHECK_SERV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const categorias = [...new Set(servicos.map((s) => s.categoria).filter(Boolean))];
  /* Mostra 5 itens por card; o resto abre no clique. Uma categoria tem 16
     itens — sem cortar, o card estica e desalinha toda a linha da grade. */
  const blocoCategoria = (cat, i) => {
    const itens = servicos.filter((s) => s.categoria === cat);
    const extras = Math.max(0, itens.length - 5);
    return `<article class="cartao serv-cartao" data-revela${i % 3 ? ` data-revela-atraso="${i % 3}"` : ""}>
            <div class="cartao__icone">${ICONS[i % ICONS.length]}</div>
            <h3 class="cartao__titulo">${esc(cat)}</h3>
            <ul class="lista-valores" style="margin-top:.9rem">
              ${itens.map((x) => `<li>${CHECK_SERV} ${esc(x.title)}</li>`).join("\n              ")}
            </ul>${extras ? `
            <button type="button" class="serv-cartao__botao" data-mais="${extras}" aria-expanded="false">+${extras} itens</button>` : ""}
          </article>`;
  };
  const servicosHome = categorias.map(blocoCategoria).join("\n          ");
  const servicosTodos = servicosHome;

  const linhaProjeto = (p, i) => `<a class="projeto" href="/projetos/${esc(p.slug)}/" data-revela${i % 3 ? ` data-revela-atraso="${i % 3}"` : ""}>
            <span class="projeto__sigla">${esc(p.sigla || "•")}</span>
            <span>
              <span class="projeto__nome">${esc(p.title)}</span>
              <span class="projeto__desc">${esc(p.resumo || "")}</span>
            </span>
            <span class="etiqueta etiqueta--${/execu/i.test(p.status || "") ? "ativo" : "planejado"}">${esc(p.status || "")}</span>
          </a>`;
  const projetosHtml = projetos.map(linhaProjeto).join("\n          ");

  /* Na home os projetos viram cards lado a lado, limitados a 3 — a lista
     completa continua em /projetos/, no formato de linha. */
  const cartaoProjeto = (p, i) => `<a class="cartao proj-cartao" href="/projetos/${esc(p.slug)}/" data-revela${i % 3 ? ` data-revela-atraso="${i % 3}"` : ""}>
            <span class="etiqueta etiqueta--${/execu/i.test(p.status || "") ? "ativo" : "planejado"}">${esc(p.status || "")}</span>
            <h3 class="cartao__titulo" style="margin-top:.8rem">${esc(p.title)}</h3>
            <p class="cartao__texto">${esc(p.resumo || "")}</p>
          </a>`;
  const projetosHome = projetos.slice(0, 3).map(cartaoProjeto).join("\n          ");

  const ICONE_DOC = '<svg class="doc__icone" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>';
  const cartaoDoc = (d, i) => `<a class="doc" href="${esc(d.url || "#")}"${d.url ? ' target="_blank" rel="noopener"' : ""} data-revela${i % 2 ? ' data-revela-atraso="1"' : ""}>
            ${ICONE_DOC}
            <span>
              <span class="doc__nome">${esc(d.title)}</span><br>
              <span class="doc__meta">${esc([d.tipo, d.ano].filter(Boolean).join(" · "))}</span>
            </span>
          </a>`;
  // Estado vazio: sem isto a seção fica com um buraco e parece quebrada.
  // A OSC vai publicando os documentos aos poucos — o site precisa aguentar isso.
  const SEM_DOC = '<p class="sub-secao">Os documentos estão em publicação. Precisa de algum agora? <a href="/#contato" style="color:var(--celeste-claro)">Fale conosco</a>.</p>';
  const docsHome = documentos.slice(0, 4).map(cartaoDoc).join("\n          ") || SEM_DOC;
  const docsTodos = documentos.map(cartaoDoc).join("\n          ");

  const ajudarHtml = String(S.ajudar_cards || "").split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l, i) => {
      const [num, titulo, texto, rotulo, link] = l.split("|").map((x) => x.trim());
      return `<article class="ajudar__cartao" data-revela${i % 3 ? ` data-revela-atraso="${i % 3}"` : ""}>
            <p class="ajudar__num">${esc(num || "")}</p>
            <h3 class="cartao__titulo">${esc(titulo || "")}</h3>
            <p class="cartao__texto">${esc(texto || "")}</p>
            ${rotulo ? `<p style="margin-top:1.2rem"><a class="btn btn--contorno btn--p" href="${esc(link || "#")}">${esc(rotulo)}</a></p>` : ""}
          </article>`;
    }).join("\n          ");

  const cartaoPessoa = (m, i) => `<article class="cartao pessoa" data-revela${i % 2 ? ' data-revela-atraso="1"' : ""}>
            ${m.photo ? `<figure class="pessoa__foto"><img src="${esc(m.photo)}" alt="${esc(m.name)} — ${esc(m.role)}" loading="lazy" decoding="async" width="120" height="120"></figure>` : ""}
            <h3 class="cartao__titulo">${esc(m.name)}</h3>
            <p class="rotulo" style="margin:.2rem 0 .7rem">${esc(m.role)}</p>
            ${m.bio ? `<p class="cartao__texto">${esc(m.bio)}</p>` : ""}
          </article>`;
  const diretoriaHome = diretoria.filter((m) => Number(m.na_home) === 1).map(cartaoPessoa).join("\n          ");
  const diretoriaTodos = diretoria.map(cartaoPessoa).join("\n          ");

  const cartaoMateria = (p, i) => `<article class="materia" data-revela${i % 3 ? ` data-revela-atraso="${i % 3}"` : ""}>
            ${p.image ? `<a class="materia__foto" href="/memoria/${esc(p.slug)}/" tabindex="-1" aria-hidden="true"><img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy" decoding="async" width="900" height="560"></a>` : ""}
            <div class="materia__corpo">
              <time class="materia__data" datetime="${esc(p.date)}">${dataBR(p.date)}</time>
              <h3 class="materia__titulo"><a href="/memoria/${esc(p.slug)}/">${esc(p.title)}</a></h3>
              <p class="materia__resumo">${esc(p.excerpt || "")}</p>
              <a class="materia__mais" href="/memoria/${esc(p.slug)}/">Ler mais →</a>
            </div>
          </article>`;
  const memoriaHome = posts.slice(0, 3).map(cartaoMateria).join("\n          ");
  const memoriaTodas = posts.map(cartaoMateria).join("\n          ") || '<p class="sub-secao">Em breve, o registro das nossas ações. 💙</p>';

  const canal = (icone, rotulo, valor, href, externo) => !valor ? "" :
    `<a class="canal" href="${href}"${externo ? ' target="_blank" rel="noopener"' : ""}>
            <span class="canal__icone">${icone}</span>
            <span><span class="canal__rotulo">${rotulo}</span><br><span class="canal__valor">${esc(valor)}</span></span>
          </a>`;
  const IC = {
    zap: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l2-5.6A8.5 8.5 0 1 1 21 11.5Z"/></svg>',
    mail: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>',
    insta: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>',
    tel: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.8 2.1Z"/></svg>',
    pin: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  };
  const canaisHtml = [
    canal(IC.zap, "WhatsApp", S.whatsapp_display, `https://wa.me/${S.whatsapp}`, true),
    canal(IC.mail, "E-mail", S.contact_email, `mailto:${S.contact_email}`),
    canal(IC.insta, "Instagram", "@" + (S.instagram || ""), `https://www.instagram.com/${S.instagram}/`, true),
    canal(IC.tel, "Telefone", S.phone_fixed, `tel:${String(S.phone_fixed || "").replace(/\D/g, "")}`),
    canal(IC.pin, "Endereço", S.address, `https://maps.google.com/?q=${encodeURIComponent(S.address || "")}`, true),
  ].filter(Boolean).join("\n          ");

  const assuntos = JSON.parse(S.form_assuntos || "[]").map((a) => `<option>${esc(a)}</option>`).join("\n                ");

  /* ============================== JSON-LD ================================= */
  const jsonld = { "@context": "https://schema.org", "@graph": [
    { "@type": "NGO", "@id": `${SITE}/#org`, name: "Instituto Kenósis",
      legalName: String(S.rodape_razao || "").replace(/&amp;/g, "&"),
      alternateName: "Instituto Kénosis", url: `${SITE}/`,
      logo: { "@type": "ImageObject", url: `${SITE}/assets/img/logo.svg` },
      image: `${SITE}${S.img_og || "/assets/img/og-image.png"}`,
      description: "Organização da Sociedade Civil que atua na promoção da cidadania, na proteção social, no fortalecimento dos vínculos familiares e comunitários e na valorização da dignidade humana.",
      taxID: S.cnpj, email: S.contact_email, telephone: S.whatsapp ? "+" + S.whatsapp : undefined,
      sameAs: [`https://www.instagram.com/${S.instagram}/`],
      /* O Google usa areaServed para decidir em que buscas locais a instituição
         entra. Caruaru é a sede; as vizinhas fazem parte da região de atuação
         declarada e é nelas que a concorrência por "OSC", "assistência social"
         e "voluntariado" é mais rala — logo, onde é mais viável ranquear. */
      areaServed: [
        { "@type": "City", name: "Caruaru", containedInPlace: { "@type": "State", name: "Pernambuco" } },
        ...["Bezerros", "Riacho das Almas", "Toritama", "Santa Cruz do Capibaribe", "Gravatá",
            "São Caetano", "Agrestina", "Brejo da Madre de Deus", "Bonito", "Belo Jardim"]
          .map((c) => ({ "@type": "City", name: c, containedInPlace: { "@type": "State", name: "Pernambuco" } })),
        { "@type": "AdministrativeArea", name: "Agreste Pernambucano" },
      ],
      address: S.address
        ? { "@type": "PostalAddress", streetAddress: S.address, addressLocality: "Caruaru", addressRegion: "PE", addressCountry: "BR" }
        // sem endereço cadastrado, ao menos a localidade — é o que ancora a
        // instituição em Caruaru para o buscador
        : { "@type": "PostalAddress", addressLocality: "Caruaru", addressRegion: "PE", addressCountry: "BR" },
      nonprofitStatus: "NonprofitANBI",
      knowsAbout: servicos.map((s) => s.title),
      member: diretoria.map((m) => ({ "@type": "Person", name: m.name, jobTitle: m.role })),
      /* Marca as ações como oferta gratuita: o Google distingue serviço
         assistencial de serviço comercial, e isso muda o tipo de resultado. */
      makesOffer: servicos.slice(0, 20).map((s) => ({
        "@type": "Offer", price: "0", priceCurrency: "BRL",
        itemOffered: { "@type": "Service", name: s.title, category: s.categoria || undefined },
      })),
    },
    { "@type": "WebSite", "@id": `${SITE}/#site`, url: `${SITE}/`, name: "Instituto Kenósis", inLanguage: "pt-BR",
      publisher: { "@id": `${SITE}/#org` },
      potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${SITE}/busca/?q={search_term_string}` }, "query-input": "required name=search_term_string" } },
  ] };

  /* =============================== HOME =================================== */
  const idx = path.join(ROOT, "index.html");
  let html = fs.readFileSync(idx, "utf8");
  html = setMarker(html, "JSONLD", "  " + jsonldTag(jsonld));
  html = aplicarTextos(html, S);
  html = setMarker(html, "NUMEROS", "          " + numeros);
  html = setMarker(html, "INST_VALORES", "          " + instValores);
  html = setMarker(html, "SERVICOS", "        " + servicosHome);
  html = setMarker(html, "PROJETOS", "        " + projetosHome);
  html = setMarker(html, "AJUDAR_CARDS", "        " + ajudarHtml);
  html = setMarker(html, "DIRETORIA", "        " + diretoriaHome);
  html = setMarker(html, "MEMORIA", "        " + memoriaHome);
  html = setMarker(html, "CANAIS", "          " + canaisHtml);
  html = setMarker(html, "FORM_ASSUNTOS", "                " + assuntos);
  html = html.replace(/wa\.me\/\d+/g, `wa.me/${S.whatsapp}`);
  if (S.img_hero) html = html.replace(/(<link rel="preload" as="image"[^>]*href=")[^"]*(")/, `$1${S.img_hero}$2`);
  fs.writeFileSync(idx, html);

  /* ===================== helper: página interna simples ==================== */
  const tpl = (nome) => fs.readFileSync(path.join(ROOT, "src", nome), "utf8");
  const gravar = (pasta, conteudo) => {
    fs.mkdirSync(path.join(ROOT, pasta), { recursive: true });
    fs.writeFileSync(path.join(ROOT, pasta, "index.html"), conteudo);
  };
  /* --------------------------------------------------------------------
     Navegação relacionada no pé de cada página interna.

     Antes daqui, as páginas internas tinham 1 ou 2 links no corpo — só o menu
     ligava uma à outra. Isso prende o visitante num beco e, para o buscador,
     deixa páginas importantes a um único caminho de distância da home.
     O bloco é montado a partir do canonical da própria página, então cada uma
     nunca aponta para si mesma.
     -------------------------------------------------------------------- */
  const MAPA_PAGINAS = [
    ["/institucional/", "A instituição", "Quem somos, governança, documentos constitutivos e parcerias."],
    ["/servicos/", "Serviços", "O que o Instituto oferece em assistência social e saúde integrativa."],
    ["/projetos/", "Projetos", "As iniciativas socioassistenciais em execução e em planejamento."],
    ["/transparencia/", "Transparência", "Relatórios de atendimentos e documentos abertos à sociedade."],
    ["/voluntariado/", "Voluntariado", "Como doar seu tempo e talento às ações do Instituto."],
    ["/banco-de-talentos/", "Banco de talentos", "Envie seu currículo e participe de futuras oportunidades."],
    ["/editais/", "Editais", "Chamamentos públicos e oportunidades de parceria."],
    ["/memoria/", "Memória institucional", "O registro das nossas ações, encontros e conquistas."],
  ];
  const relacionados = (url) => {
    const lista = MAPA_PAGINAS.filter(([u]) => u !== "/memoria/" || posts.length);
    // começa na página SEGUINTE à atual e dá a volta: assim cada página sugere
    // um trio diferente e, somadas, todas ficam a um clique de alguma outra.
    // Sem isso, as três primeiras do mapa recebiam todos os links do site.
    const i = lista.findIndex(([u]) => u === url);
    const ordem = i < 0 ? lista : [...lista.slice(i + 1), ...lista.slice(0, i)];
    return ordem.slice(0, 3)
      .map(([u, titulo, texto], k) => `<a class="cartao proj-cartao" href="${u}" data-revela${k % 3 ? ` data-revela-atraso="${k % 3}"` : ""}>
            <h3 class="cartao__titulo">${esc(titulo)}</h3>
            <p class="cartao__texto">${esc(texto)}</p>
          </a>`).join("\n          ");
  };

  const base = (t, extras = {}) => {
    let h = aplicarTextos(tpl(t), S);
    for (const [k, v] of Object.entries(extras)) h = h.replaceAll(`{{${k}}}`, v);
    if (h.includes("{{RELACIONADOS}}")) {
      // o caminho vem depois do domínio — capturar a partir da primeira "/"
      // pegaria a barra do "https://" e a página apontaria para si mesma
      const canonical = /<link rel="canonical" href="https?:\/\/[^/"]+(\/[^"]*)"/.exec(h);
      h = h.replaceAll("{{RELACIONADOS}}", "        " + relacionados(canonical ? canonical[1] : ""));
    }
    return h.replace(/wa\.me\/\d+(?![?\d])/g, `wa.me/${S.whatsapp}`);
  };
  const migalha = (nome, url) => ({ "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
    { "@type": "ListItem", position: 2, name: nome, item: `${SITE}${url}` } ] });

  /* ============================= /servicos/ =============================== */
  gravar("servicos", base("servicos.html", {
    LISTA: "        " + servicosTodos, COUNT: String(servicos.length),
    INTRO: marcado(S.pg_serv_intro), OBSERVACAO: esc(S.pg_serv_observacao || ""),
    JSONLD: jsonldTag({ "@context": "https://schema.org", "@graph": [migalha("Serviços", "/servicos/"),
      { "@type": "ItemList", name: "Serviços do Instituto Kenósis",
        itemListElement: servicos.map((s, i) => ({ "@type": "ListItem", position: i + 1, name: s.title, url: `${SITE}/servicos/${s.slug}/` })) }] }),
  }));
  // sem páginas por serviço: o original não traz texto individual para elas

  /* ============================= /projetos/ =============================== */
  gravar("projetos", base("projetos.html", {
    LISTA: "        " + projetosHtml, INTRO: marcado(S.pg_proj_intro),
    JSONLD: jsonldTag({ "@context": "https://schema.org", "@graph": [migalha("Projetos", "/projetos/"),
      { "@type": "ItemList", name: "Projetos do Instituto Kenósis",
        itemListElement: projetos.map((p, i) => ({ "@type": "ListItem", position: i + 1, name: p.title, url: `${SITE}/projetos/${p.slug}/` })) }] }),
  }));
  const manterProj = new Set(projetos.map((p) => p.slug));
  for (const d of fs.readdirSync(path.join(ROOT, "projetos"), { withFileTypes: true }))
    if (d.isDirectory() && !manterProj.has(d.name)) fs.rmSync(path.join(ROOT, "projetos", d.name), { recursive: true, force: true });
  for (const p of projetos) {
    gravar(`projetos/${p.slug}`, base("projeto.html", {
      TITULO: esc(p.title), SLUG: esc(p.slug), SIGLA: esc(p.sigla || ""),
      TITLE_TAG: esc(tituloSeo(p.title)),
      STATUS: esc(p.status || ""), CLASSE_STATUS: /execu/i.test(p.status || "") ? "ativo" : "planejado",
      RESUMO: esc(p.resumo || ""), PUBLICO: esc(p.publico || ""), CONTEUDO: marcado(p.content),
      JSONLD: jsonldTag({ "@context": "https://schema.org", "@graph": [
        { "@type": "Project", name: p.title, alternateName: p.sigla, description: p.resumo,
          url: `${SITE}/projetos/${p.slug}/`, parentOrganization: { "@id": `${SITE}/#org` } },
        { "@type": "BreadcrumbList", itemListElement: [
          { "@type": "ListItem", position: 1, name: "Início", item: `${SITE}/` },
          { "@type": "ListItem", position: 2, name: "Projetos", item: `${SITE}/projetos/` },
          { "@type": "ListItem", position: 3, name: p.title, item: `${SITE}/projetos/${p.slug}/` }] }] }),
    }));
  }

  /* ======================= páginas de conteúdo fixo ======================= */
  gravar("institucional", base("institucional.html", {
    INST_CONTEUDO: marcado(S.pg_inst_conteudo),
    ORGANOGRAMA_CONTEUDO: marcado(S.pg_organograma_conteudo),
    ESTATUTO_CONTEUDO: marcado(S.pg_estatuto_conteudo),
    PARCEIROS_CONTEUDO: marcado(S.pg_parceiros_conteudo),
    DIRETORIA: "        " + diretoriaTodos,
    PARCEIROS: "        " + (parceiros.map((p, i) => `<article class="cartao" data-revela${i % 3 ? ` data-revela-atraso="${i % 3}"` : ""}>
            ${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.title)}" loading="lazy" style="height:52px;width:auto;margin-bottom:1rem">` : ""}
            <h3 class="cartao__titulo">${esc(p.title)}</h3>
            <p class="cartao__texto">${esc(p.subtitle || "")}</p>
          </article>`).join("\n          ") || '<p class="sub-secao">Parcerias em cadastramento.</p>'),
    JSONLD: jsonldTag({ "@context": "https://schema.org", "@graph": [migalha("Institucional", "/institucional/"),
      { "@type": "AboutPage", name: "Institucional — Instituto Kenósis", url: `${SITE}/institucional/`, about: { "@id": `${SITE}/#org` } }] }),
  }));

  gravar("transparencia", base("transparencia.html", {
    TRANSP_INTRO: esc(S.pg_transp_intro || ""), TRANSP_OBSERVACAO: esc(S.pg_transp_observacao || ""),
    DOCUMENTOS: "        " + (docsTodos || '<p class="sub-secao">Documentos em publicação.</p>'),
    JSONLD: jsonldTag({ "@context": "https://schema.org", "@graph": [migalha("Transparência", "/transparencia/")] }),
  }));

  const zapLink = (texto) => `https://wa.me/${S.whatsapp}?text=${encodeURIComponent(texto)}`;
  for (const [pasta, arquivo, chave, nome, destino] of [
    ["voluntariado", "texto.html", "pg_vol", "Voluntariado", "/#contato"],
    ["banco-de-talentos", "texto.html", "pg_talentos", "Banco de Talentos",
      zapLink("Olá! Vim pelo site e gostaria de falar sobre o banco de talentos do Instituto Kenósis.")],
    ["editais", "texto.html", "pg_editais", "Editais", "/#contato"],
  ]) {
    gravar(pasta, base(arquivo, {
      PG_CTA: esc(S[`${chave}_cta`] || "Quer conversar antes de decidir? Estamos por aqui."),
      PG_CTA_BOTAO: esc(S[`${chave}_cta_botao`] || "Falar conosco"),
      PG_CTA_LINK: destino,
      PG_CTA_ALVO: destino.startsWith("http") ? ' target="_blank" rel="noopener"' : "",
      PG_TITULO: S[`${chave}_titulo`] || "", PG_TEXTO: esc(S[`${chave}_texto`] || ""),
      PG_CONTEUDO: marcado(S[`${chave}_conteudo`] || ""), MIGALHA: esc(nome), URL: `/${pasta}/`,
      TITLE_TAG: esc(tituloSeo(nome)),
      META_DESC: esc(String(S[`${chave}_texto`] || "").slice(0, 155)),
      JSONLD: jsonldTag({ "@context": "https://schema.org", "@graph": [migalha(nome, `/${pasta}/`)] }),
    }));
  }

  /* =============================== /memoria/ ============================== */
  /* Página de listagem sem nenhum item é conteúdo raso: o Google indexa, avalia
     como fraca e isso pesa contra o site inteiro. Enquanto não houver matéria,
     ela fica fora do índice — e volta sozinha na primeira publicação. */
  gravar("memoria", base("memoria.html", {
    LISTA: "        " + memoriaTodas,
    ROBOTS: posts.length ? "index, follow, max-image-preview:large, max-snippet:-1" : "noindex, follow",
    JSONLD: jsonldTag({ "@context": "https://schema.org", "@graph": [migalha("Memória institucional", "/memoria/"),
      { "@type": "Blog", name: "Memória institucional", url: `${SITE}/memoria/`, publisher: { "@id": `${SITE}/#org` } }] }),
  }));
  const manterPosts = new Set(posts.map((p) => p.slug));
  for (const d of fs.readdirSync(path.join(ROOT, "memoria"), { withFileTypes: true }))
    if (d.isDirectory() && !manterPosts.has(d.name)) fs.rmSync(path.join(ROOT, "memoria", d.name), { recursive: true, force: true });
  for (const p of posts) {
    gravar(`memoria/${p.slug}`, base("materia.html", {
      TITULO: esc(p.title), SLUG: esc(p.slug), RESUMO: esc(p.excerpt || ""), IMAGEM: esc(p.image || ""),
      DATA_ISO: esc(p.date), DATA_BR: dataBR(p.date), CONTEUDO: marcado(p.content),
      FIGURA: p.image
        ? `<figure class="materia-capa" data-revela><img src="${esc(p.image)}" alt="${esc(p.title)}" fetchpriority="high" decoding="async"></figure>`
        : "",
      JSONLD: jsonldTag({ "@context": "https://schema.org", "@type": "Article",
        headline: p.title, description: p.excerpt, image: p.image, datePublished: p.date, inLanguage: "pt-BR",
        author: { "@id": `${SITE}/#org` }, publisher: { "@id": `${SITE}/#org` },
        mainEntityOfPage: `${SITE}/memoria/${p.slug}/` }),
    }));
  }

  /* ====================== privacidade, busca, índice ====================== */
  const hojeISO = new Date().toISOString().slice(0, 10);
  const mail = `<a href="mailto:${esc(S.contact_email)}">${esc(S.contact_email)}</a>`;
  let priv = base("privacidade.html", {
    DATA_BR: dataBR(hojeISO),
    JSONLD: jsonldTag({ "@context": "https://schema.org", "@graph": [migalha("Privacidade", "/privacidade/"),
      { "@type": "WebPage", name: "Política de Privacidade", url: `${SITE}/privacidade/`, dateModified: hojeISO }] }),
  });
  priv = setMarker(priv, "PRIV_CNPJ", esc(S.cnpj));
  priv = setMarker(priv, "PRIV_RAZAO", S.rodape_razao || "");
  for (const k of ["PRIV_EMAIL", "PRIV_EMAIL2", "PRIV_EMAIL3"]) priv = setMarker(priv, k, mail);
  gravar("privacidade", priv);

  gravar("busca", base("busca.html", { JSONLD: "" }));

  const limpo = (t) => String(t || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const indice = [
    { t: "Início — Instituto Kenósis", u: "/", tipo: "Página", d: limpo(S.hero_texto) },
    { t: "A instituição", u: "/institucional/", tipo: "Institucional", d: limpo(S.sec_inst_texto) },
    { t: "Transparência e prestação de contas", u: "/transparencia/", tipo: "Institucional", d: limpo(S.sec_transp_sub) },
    { t: "Seja voluntário", u: "/voluntariado/", tipo: "Participe", d: limpo(S.pg_vol_conteudo).slice(0, 300) },
    { t: "Banco de talentos", u: "/banco-de-talentos/", tipo: "Participe", d: limpo(S.pg_talentos_conteudo).slice(0, 300) },
    { t: "Editais e chamamentos", u: "/editais/", tipo: "Participe", d: limpo(S.pg_editais_conteudo).slice(0, 300) },
    { t: "Política de Privacidade", u: "/privacidade/", tipo: "Institucional", d: "Como tratamos os seus dados pessoais, conforme a LGPD." },
    ...servicos.map((s) => ({ t: s.title, u: "/servicos/", tipo: "Serviço", d: limpo(s.categoria) })),
    ...projetos.map((p) => ({ t: p.title, u: `/projetos/${p.slug}/`, tipo: "Projeto", d: limpo(p.resumo) + " " + limpo(p.content).slice(0, 300) })),
    ...posts.map((p) => ({ t: p.title, u: `/memoria/${p.slug}/`, tipo: "Memória", d: limpo(p.excerpt) + " " + limpo(p.content).slice(0, 300) })),
    ...diretoria.map((m) => ({ t: m.name, u: "/institucional/#diretoria", tipo: "Diretoria", d: `${limpo(m.role)}. ${limpo(m.bio)}` })),
  ];
  fs.mkdirSync(path.join(ROOT, "assets", "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "assets", "data", "search-index.json"), JSON.stringify(indice));

  /* ============================== sitemap ================================= */
  const urls = [
    { loc: `${SITE}/`, pri: "1.0", freq: "weekly" },
    { loc: `${SITE}/institucional/`, pri: "0.9", freq: "monthly" },
    { loc: `${SITE}/servicos/`, pri: "0.9", freq: "monthly" },
    { loc: `${SITE}/projetos/`, pri: "0.9", freq: "monthly" },
    ...projetos.map((p) => ({ loc: `${SITE}/projetos/${p.slug}/`, pri: "0.8", freq: "monthly" })),
    { loc: `${SITE}/transparencia/`, pri: "0.8", freq: "monthly" },
    { loc: `${SITE}/voluntariado/`, pri: "0.8", freq: "monthly" },
    { loc: `${SITE}/banco-de-talentos/`, pri: "0.7", freq: "monthly" },
    { loc: `${SITE}/editais/`, pri: "0.7", freq: "weekly" },
    // vazia, ela está com noindex — anunciar no sitemap seria pedir para o
    // buscador rastrear algo que mandamos ignorar
    ...(posts.length ? [{ loc: `${SITE}/memoria/`, pri: "0.7", freq: "weekly" }] : []),
    ...posts.map((p) => ({ loc: `${SITE}/memoria/${p.slug}/`, pri: "0.6", freq: "yearly" })),
    { loc: `${SITE}/privacidade/`, pri: "0.3", freq: "yearly" },
  ];
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${hojeISO}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`).join("\n") +
    `\n</urlset>\n`);

  gerarPaginaManutencao(S);

  const cfgPath = path.join(ROOT, "assets/js/config.js");
  let cfg = fs.readFileSync(cfgPath, "utf8");
  cfg = cfg.replace(/WHATSAPP_NUMBER = "[^"]*"/, `WHATSAPP_NUMBER = "${S.whatsapp}"`)
           .replace(/CONTACT_EMAIL = "[^"]*"/, `CONTACT_EMAIL = "${S.contact_email}"`);
  fs.writeFileSync(cfgPath, cfg);

  return { servicos: servicos.length, projetos: projetos.length, documentos: documentos.length,
           diretoria: diretoria.length, posts: posts.length, parceiros: parceiros.length };
}

/* ------------------------------ HTTP util --------------------------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain" };
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, bad) => {
  let d = "", n = 0;
  req.on("data", (c) => { n += c.length; if (n > 25e6) { bad(new Error("payload muito grande")); req.destroy(); } d += c; });
  req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { bad(new Error("JSON inválido")); } });
});
const TABLES = {
  services:     ["title", "slug", "text", "content", "sort"],
  projetos:     ["title", "slug", "sigla", "status", "resumo", "publico", "content", "sort"],
  documentos:   ["title", "tipo", "ano", "url", "sort"],
  portfolio:    ["title", "subtitle", "image", "sort"],          // parceiros
  team:         ["name", "role", "bio", "photo", "whatsapp", "especialidades", "na_home", "sort"],
  posts:        ["title", "slug", "excerpt", "content", "image", "date", "sort"],
  galeria:      ["path", "categoria", "descricao", "sort"],
};
/* ==========================================================================
   CAMPOS — declaração única de tudo que é editável em "Textos do site".
   O painel monta a tela a partir daqui, então incluir um campo novo é acrescentar
   uma linha nesta lista + o marcador <!--#CHAVE--> no HTML. Nada mais.
   tipos: input | textarea | bigtext | image | lista
   ========================================================================== */
/* ==========================================================================
   CAMPOS — declaração única de tudo que é editável.
   `painel` roteia o grupo para a tela certa do gerenciador: assim cada tela
   do site tem a sua área de edição, em vez de um formulão só.
   tipos: input | textarea | bigtext | html | image | lista | stats | json_lista
   ========================================================================== */
const CAMPOS = [
  /* ------------------------------ TEXTOS DA HOME ------------------------- */
  { painel: "home", grupo: "🏠 Topo", campos: [
    ["hero_rotulo", "Rótulo acima do título", "input"],
    ["hero_titulo", "Título — <em>texto</em> fica em itálico celeste", "input"],
    ["hero_texto", "Texto de apresentação", "textarea"],
    ["selo_osc", "Selo de credibilidade (CNPJ)", "input"],
    ["btn_hero_1", "Botão principal", "input"],
    ["btn_hero_2", "Botão secundário", "input"],
    ["img_hero", "Foto do topo (sem foto, a área fica só com as auréolas)", "image"],
    ["img_hero_alt", "Descrição da foto", "input"],
    ["numeros", "Números de impacto — um por linha: 3 | projetos ativos", "stats"],
  ]},
  { painel: "home", grupo: "✨ O nome", campos: [
    ["sec_nome_rotulo", "Rótulo", "input"],
    ["sec_nome_titulo", "Título", "input"],
    ["sec_nome_texto", "Texto", "textarea"],
  ]},
  { painel: "home", grupo: "💙 A instituição", campos: [
    ["sec_inst_rotulo", "Rótulo", "input"],
    ["sec_inst_titulo", "Título", "input"],
    ["sec_inst_texto", "Texto (um parágrafo por linha em branco)", "bigtext"],
    ["inst_valores", "Destaques em lista — um por linha", "lista"],
    ["btn_institucional", "Botão", "input"],
    ["img_instituicao", "Foto da seção (sem foto, a seção fica em coluna única)", "image"],
    ["img_instituicao_alt", "Descrição da foto", "input"],
  ]},
  { painel: "home", grupo: "🎯 Missão, Visão e Valores", campos: [
    ["mvv_t1", "Título do 1º card", "input"],
    ["mvv_missao", "Missão", "textarea"],
    ["mvv_t2", "Título do 2º card", "input"],
    ["mvv_visao", "Visão", "textarea"],
    ["mvv_t3", "Título do 3º card", "input"],
    ["mvv_valores", "Valores", "textarea"],
  ]},
  { painel: "home", grupo: "🤝 Áreas de atuação", campos: [
    ["sec_serv_rotulo", "Rótulo", "input"],
    ["sec_serv_titulo", "Título", "input"],
    ["sec_serv_sub", "Subtítulo", "textarea"],
    ["btn_ver_servicos", "Botão", "input"],
  ]},
  { painel: "home", grupo: "📋 Projetos", campos: [
    ["sec_proj_rotulo", "Rótulo", "input"],
    ["sec_proj_titulo", "Título", "input"],
    ["btn_ver_projetos", "Botão “ver mais projetos”", "input"],
  ]},
  { painel: "home", grupo: "🔎 Transparência", campos: [
    ["sec_transp_rotulo", "Rótulo", "input"],
    ["sec_transp_titulo", "Título", "input"],
    ["sec_transp_sub", "Texto", "textarea"],
    ["btn_transparencia", "Botão", "input"],
  ]},
  { painel: "home", grupo: "🙌 Formas de fazer parte", campos: [
    ["sec_ajudar_rotulo", "Rótulo", "input"],
    ["sec_ajudar_titulo", "Título", "input"],
    ["sec_ajudar_sub", "Subtítulo", "textarea"],
    ["ajudar_cards", "Um card por linha: Número | Título | Texto | Botão | Link", "bigtext"],
  ]},
  { painel: "home", grupo: "👥 Diretoria executiva", campos: [
    ["sec_dir_rotulo", "Rótulo", "input"],
    ["sec_dir_titulo", "Título", "input"],
    ["sec_dir_sub", "Texto de apoio", "textarea"],
    ["btn_organograma", "Botão", "input"],
  ]},
  { painel: "home", grupo: "📰 Memória institucional", campos: [
    ["sec_mem_rotulo", "Rótulo", "input"],
    ["sec_mem_titulo", "Título", "input"],
    ["sec_mem_sub", "Subtítulo", "textarea"],
    ["btn_ver_memoria", "Botão", "input"],
  ]},
  { painel: "home", grupo: "📞 Fale conosco", campos: [
    ["sec_cont_rotulo", "Rótulo", "input"],
    ["sec_cont_titulo", "Título", "input"],
    ["sec_cont_sub", "Subtítulo", "textarea"],
    ["form_assuntos", "Opções de “Assunto” do formulário — uma por linha", "lista"],
    ["btn_form", "Botão do formulário", "input"],
    ["form_aviso", "Aviso abaixo do formulário", "input"],
    ["whatsapp", "WhatsApp (só números, com 55) — vazio esconde o card", "input"],
    ["whatsapp_display", "WhatsApp como aparece na tela", "input"],
    ["contact_email", "E-mail — vazio esconde o card", "input"],
    ["instagram", "Instagram sem @ — vazio esconde o card", "input"],
    ["phone_fixed", "Telefone fixo — vazio esconde o card", "input"],
    ["address", "Endereço — vazio esconde o card", "textarea"],
  ]},

  /* ------------------------------- SERVIÇOS ------------------------------ */
  { painel: "servicos", grupo: "📄 Textos da página", campos: [
    ["pg_serv_titulo", "Título da página (área azul)", "input"],
    ["pg_serv_texto", "Texto da área azul", "textarea"],
    ["pg_serv_intro", "Texto de abertura, acima das categorias", "html"],
    ["pg_serv_observacao", "Texto de observação, ao final", "textarea"],
  ]},

  /* ------------------------------- PROJETOS ------------------------------ */
  { painel: "projetos", grupo: "📄 Textos da página", campos: [
    ["pg_proj_titulo", "Título da página (área azul)", "input"],
    ["pg_proj_texto", "Texto da área azul", "textarea"],
    ["pg_proj_intro", "Texto que antecede os projetos", "html"],
  ]},

  /* ----------------------------- INSTITUCIONAL --------------------------- */
  { painel: "institucional", grupo: "📄 Cabeçalho da página", campos: [
    ["pg_inst_titulo", "Título da página (área azul)", "input"],
    ["pg_inst_texto", "Texto da área azul", "textarea"],
  ]},
  { painel: "institucional", grupo: "📖 Corpo da página", campos: [
    ["pg_inst_conteudo", "Conteúdo — aceita HTML. Use ## para título de seção e > para citação", "html"],
  ]},
  { painel: "institucional", grupo: "👥 Diretoria e conselho fiscal", campos: [
    ["pg_dir_titulo", "Título da seção", "input"],
    ["pg_dir_texto", "Texto de apoio", "textarea"],
  ]},
  { painel: "institucional", grupo: "🏛️ Organograma", campos: [
    ["pg_organograma_titulo", "Título da seção", "input"],
    ["pg_organograma_texto", "Texto de apoio", "textarea"],
    ["pg_organograma_conteudo", "Conteúdo — aceita HTML", "html"],
  ]},
  { painel: "institucional", grupo: "📜 Documentos constitutivos", campos: [
    ["pg_estatuto_titulo", "Título da seção", "input"],
    ["pg_estatuto_texto", "Texto de apoio", "textarea"],
    ["pg_estatuto_conteudo", "Conteúdo — aceita HTML", "html"],
  ]},
  { painel: "institucional", grupo: "🤝 Parcerias institucionais", campos: [
    ["pg_parceiros_titulo", "Título da seção", "input"],
    ["pg_parceiros_texto", "Texto de apoio", "textarea"],
    ["pg_parceiros_texto", "Texto de apoio", "textarea"],
    ["pg_parceiros_conteudo", "Conteúdo — aceita HTML", "html"],
  ]},

  /* ----------------------------- TRANSPARÊNCIA --------------------------- */
  { painel: "transparencia", grupo: "📄 Textos da página", campos: [
    ["pg_transp_titulo", "Título da página (área azul)", "input"],
    ["pg_transp_texto", "Texto da área azul", "textarea"],
    ["pg_transp_intro", "Texto de abertura da lista", "textarea"],
    ["pg_transp_titulo_lista", "Título acima dos documentos", "input"],
    ["pg_transp_observacao", "Texto de observação", "textarea"],
  ]},

  /* ----------------------------- VOLUNTARIADO ---------------------------- */
  { painel: "voluntariado", grupo: "📄 Textos da página", campos: [
    ["pg_vol_titulo", "Título da página (área azul)", "input"],
    ["pg_vol_texto", "Texto da área azul", "textarea"],
    ["pg_vol_conteudo", "Conteúdo — aceita HTML", "html"],
    ["pg_vol_cta", "Chamada da caixa ao final", "textarea"],
    ["pg_vol_cta_botao", "Rótulo do botão", "input"],
  ]},

  /* --------------------------- BANCO DE TALENTOS ------------------------- */
  { painel: "talentos", grupo: "📄 Textos da página", campos: [
    ["pg_talentos_titulo", "Título da página (área azul)", "input"],
    ["pg_talentos_texto", "Texto da área azul", "textarea"],
    ["pg_talentos_conteudo", "Conteúdo — aceita HTML", "html"],
    ["pg_talentos_cta", "Chamada da caixa ao final", "textarea"],
    ["pg_talentos_cta_botao", "Rótulo do botão (vai para o WhatsApp)", "input"],
  ]},

  /* -------------------------- OUTRAS PÁGINAS + RODAPÉ -------------------- */
  { painel: "outras", grupo: "📄 Página Editais", campos: [
    ["pg_editais_titulo", "Título da página", "input"],
    ["pg_editais_texto", "Texto da área azul", "textarea"],
    ["pg_editais_conteudo", "Conteúdo — aceita HTML", "html"],
  ]},
  { painel: "outras", grupo: "📄 Página Memória", campos: [
    ["pg_mem_titulo", "Título da página", "input"],
    ["pg_mem_texto", "Texto da área azul", "textarea"],
  ]},
  { painel: "outras", grupo: "📄 Página Privacidade", campos: [
    ["pg_priv_titulo", "Título da página", "input"],
    ["pg_priv_texto", "Texto da área azul", "textarea"],
  ]},
  { painel: "outras", grupo: "🔗 Rodapé e identidade", campos: [
    ["rodape_frase", "Frase do rodapé", "textarea"],
    ["rodape_h1", "Título da 1ª coluna", "input"],
    ["rodape_h2", "Título da 2ª coluna", "input"],
    ["rodape_h3", "Título da 3ª coluna", "input"],
    ["rodape_horario", "Horário de atendimento", "textarea"],
    ["rodape_razao", "Razão social completa", "input"],
    ["cnpj", "CNPJ", "input"],
    ["img_og", "Imagem de compartilhamento (WhatsApp/Facebook)", "image"],
  ]},
];
const KEYS = CAMPOS.flatMap((g) => g.campos.map(([k]) => k));

// precisa vir depois de KEYS: a migração consulta a lista para saber o que é editável
migrarTextos();

/* Projetos passaram a ser cadastrados no /restrito. Se o banco de gestão ainda
   não tem nenhum, leva os que já existiam aqui no site.db — migração única, para
   não perder os projetos publicados. Depois disso o site.db.projetos fica ocioso. */
try {
  if (contarProjetos() === 0) {
    const antigos = db.prepare("SELECT title,slug,sigla,status,resumo,publico,content,sort FROM projetos ORDER BY sort,id").all();
    if (antigos.length) console.log(`  · projetos migrados para o sistema de gestão: ${importarProjetos(antigos)}`);
  }
} catch (e) { console.error("  ✖ migração de projetos:", e.message); }

// garante que a página de manutenção exista em disco desde o primeiro boot —
// o nginx a serve nas quedas, e nessa hora não há app para gerá-la
try {
  const S0 = {}; for (const r of db.prepare("SELECT key,value FROM settings").all()) S0[r.key] = r.value;
  if (!fs.existsSync(path.join(ROOT, "manutencao.html"))) gerarPaginaManutencao(S0);
} catch { /* nunca impedir o servidor de subir */ }

/* Aplica em qualquer arquivo os textos simples guardados no painel.
   Chaves com formatação própria (listas, imagens) são tratadas à parte. */
const ESPECIAIS = ["stats", "about_bullets", "online_list", "passos_itens", "empresas_cards", "ticker"];

/* Faixa rolante: 4 grupos idênticos para o loop não ter emenda (ver styles.css) */
function renderTicker(S) {
  const itens = String(S.ticker || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!itens.length) return "";
  const grupo = `<div class="ticker__group">${itens.map((i) => `<span>${esc(i)}</span><i>🪷</i>`).join("")}</div>`;
  return Array(4).fill(grupo).join("\n        ");
}

/* Blocos repetidos: cada linha "Título | Descrição [| link]" vira um item */
const linhasDe = (v) => String(v || "").split("\n").map((l) => l.trim()).filter(Boolean)
  .map((l) => l.split("|").map((p) => p.trim()));

function renderPassos(S) {
  return linhasDe(S.passos_itens).map(([titulo, texto], i) =>
    `<li class="step" data-reveal${i ? ` data-reveal-delay="${i}"` : ""}>
            <span class="step__num">${String(i + 1).padStart(2, "0")}</span>
            <h3 class="step__title">${esc(titulo || "")}</h3>
            <p class="step__text">${esc(texto || "")}</p>
          </li>`).join("\n          ");
}

function renderEmpresas(S) {
  return linhasDe(S.empresas_cards).map(([titulo, texto, link], i) =>
    `<article class="card" data-reveal${i % 3 ? ` data-reveal-delay="${i % 3}"` : ""}>
            <div class="service__icon">${ICONS[i % ICONS.length]}</div>
            <h3 class="service__title">${esc(titulo || "")}</h3>
            <p class="service__text">${esc(texto || "")}</p>
            ${link ? `<a class="service__more" href="${esc(link)}">Saiba mais →</a>` : ""}
          </article>`).join("\n          ");
}
function aplicarTextos(html, S) {
  for (const chave of KEYS) {
    if (ESPECIAIS.includes(chave) || chave.endsWith("_alt")) continue;
    const MARCA = chave.toUpperCase();
    if (!html.includes(`<!--#${MARCA}-->`)) continue;
    html = setMarker(html, MARCA, chave.startsWith("img_") ? tagImagem(chave, S) : (S[chave] ?? ""));
  }
  // imagem de compartilhamento (og:image / twitter:image) em todas as páginas
  if (S.img_og) {
    const abs = S.img_og.startsWith("http") ? S.img_og : "https://institutokenosis.com" + S.img_og;
    html = html.replace(/(<meta (?:property|name)="(?:og|twitter):image" content=")[^"]*(")/g, `$1${abs}$2`);
  }
  return html;
}
function slug(s) { return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

/* ------------------------------ Servidor ---------------------------------- */
// `node server.js --publicar` regenera as páginas sem subir o servidor: serve
// para o deploy e para verificar uma alteração de template sem passar pelo painel
if (process.argv.includes("--publicar")) {
  const r = publish();
  console.log(`  publicado: ${JSON.stringify(r)}`);
  process.exit(0);
}

http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;

  // Cabeçalhos de segurança em toda resposta
  res.setHeader("X-Content-Type-Options", "nosniff");        // barra MIME sniffing
  res.setHeader("X-Frame-Options", "SAMEORIGIN");            // impede clickjacking no painel
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  // HSTS: uma vez servido por HTTPS, o navegador nunca mais tenta HTTP (evita
  // downgrade/MITM na 1ª visita). Só faz sentido — e só é honrado — sob HTTPS.
  if (req.headers["x-forwarded-proto"] === "https")
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  // Área restrita (sistema de gestão): atendida por módulo à parte, antes de
  // qualquer roteamento do site. Se ele tratou, encerra aqui.
  try { if (handleRestrito(req, res, p)) return; if (handleExterno(req, res, p)) return; }
  catch (e) { console.error("  ✖ /restrito|externo:", e.message); if (!res.headersSent) { res.writeHead(500); res.end("Erro interno"); } return; }

  try {
    /* Modo manutenção: barra o visitante mas deixa passar o painel, a API e os
       assets (a própria página de aviso usa o favicon). Quem tem sessão de
       administrador continua vendo o site normal, para conferir antes de reabrir. */
    if (emManutencao() && !p.startsWith("/admin") && !p.startsWith("/api/")
        && !p.startsWith("/assets/") && !p.startsWith("/.well-known/") && !authed(req)) {
      const arq = path.join(ROOT, "manutencao.html");
      const corpo = fs.existsSync(arq) ? fs.readFileSync(arq) : "Estamos atualizando o site. Volte em instantes.";
      // 503 + Retry-After: diz ao Google que é temporário. Com 200 ele indexaria
      // a página de aviso; com 404 acharia que o site sumiu.
      res.writeHead(503, { "Content-Type": MIME[".html"], "Retry-After": "3600", "Cache-Control": "no-store" });
      return res.end(corpo);
    }

    if (p.startsWith("/api/")) {
      if (p === "/api/login" && req.method === "POST") {
        const ip = clientIp(req);
        const faltam = loginBloqueado(ip);
        if (faltam) return json(res, 429, { error: `Muitas tentativas. Tente de novo em ${faltam} min.` });
        const { password } = await readBody(req);
        const guardado = getS("admin_password_hash");
        if (!confereSenha(password, guardado)) {
          registrarErro(ip);
          console.warn(`  ⚠ senha incorreta no painel — origem ${ip}`);
          return json(res, 401, { error: "Senha incorreta" });
        }
        // migração transparente: quem ainda estava no sha256 sobe para scrypt
        // no primeiro login certo, sem precisar trocar de senha
        if (senhaEhAntiga(guardado)) {
          setS("admin_password_hash", hashSenha(password));
          console.log("  · senha do painel migrada de sha256 para scrypt");
        }
        tentativas.delete(ip);
        const t = crypto.randomBytes(24).toString("hex");
        sessions.set(t, Date.now());
        // Secure só quando a requisição chegou por HTTPS (nginx informa no X-Forwarded-Proto).
        // Em produção isso impede que o cookie de sessão trafegue em claro.
        const https = req.headers["x-forwarded-proto"] === "https";
        res.setHeader("Set-Cookie", `sid=${t}; HttpOnly; Path=/; SameSite=Lax${https ? "; Secure" : ""}`);
        return json(res, 200, { ok: true });
      }
      if (!authed(req)) return json(res, 401, { error: "Não autenticado" });
      if (p === "/api/me") return json(res, 200, { ok: true, version: APP_VERSION });
      if (p === "/api/stats") return json(res, 200, statsAcessos());
      if (p === "/api/manutencao") {
        if (req.method === "POST") {
          const { ligar, titulo, texto } = await readBody(req);
          if (titulo !== undefined) setS("manutencao_titulo", titulo);
          if (texto !== undefined) setS("manutencao_texto", texto);
          setS("manutencao", ligar ? "1" : "0");
          const S = {}; for (const r of db.prepare("SELECT key,value FROM settings").all()) S[r.key] = r.value;
          gerarPaginaManutencao(S);   // regrava o arquivo que o nginx usa nas quedas
          console.log(`  · modo manutenção ${ligar ? "LIGADO" : "desligado"}`);
        }
        return json(res, 200, { ok: true, ligado: emManutencao(),
          titulo: getS("manutencao_titulo") || "", texto: getS("manutencao_texto") || "" });
      }
      if (p === "/api/logout" && req.method === "POST") {
        const m = /sid=([a-f0-9]+)/.exec(req.headers.cookie || ""); if (m) sessions.delete(m[1]);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/password" && req.method === "POST") {
        const { current, next } = await readBody(req);
        if (!confereSenha(current, getS("admin_password_hash"))) return json(res, 400, { error: "Senha atual incorreta" });
        if (!next || String(next).length < 8) return json(res, 400, { error: "A nova senha precisa ter pelo menos 8 caracteres" });
        if (confereSenha(next, getS("admin_password_hash"))) return json(res, 400, { error: "A nova senha é igual à atual" });
        setS("admin_password_hash", hashSenha(next));
        // trocar a senha derruba as outras sessões: se alguém tinha um cookie
        // roubado, ele para de valer no momento da troca
        const meu = (/sid=([a-f0-9]+)/.exec(req.headers.cookie || "") || [])[1];
        for (const k of [...sessions.keys()]) if (k !== meu) sessions.delete(k);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/content") {
        const S = {}; for (const k of KEYS) S[k] = getS(k) || "";
        return json(res, 200, {
          settings: S,
          campos: CAMPOS,   // o painel monta a tela "Textos do site" a partir daqui
          services: db.prepare("SELECT * FROM services ORDER BY sort,id").all(),
          projetos: listarProjetos(),   // somente leitura no painel: cadastro é no /restrito
          documentos: db.prepare("SELECT * FROM documentos ORDER BY sort,id").all(),
          portfolio: db.prepare("SELECT * FROM portfolio ORDER BY sort,id").all(),
          team: db.prepare("SELECT * FROM team ORDER BY sort,id").all(),
          posts: db.prepare("SELECT * FROM posts ORDER BY date DESC, id DESC").all(),
        });
      }
      if (p === "/api/settings" && req.method === "PUT") {
        const b = await readBody(req);
        for (const [k, v] of Object.entries(b)) if (KEYS.includes(k)) setS(k, v);
        return json(res, 200, { ok: true });
      }
      /* Galeria unificada: as fotos cadastradas aqui + as que já estão em uso
         nas outras áreas (topo, instituição, diretoria, parceiros, matérias).
         Assim o cliente vê tudo num lugar só e copia o link de qualquer uma. */
      if (p === "/api/gallery") {
        const daGaleria = db.prepare("SELECT id, path, categoria, descricao FROM galeria ORDER BY sort, id DESC").all();
        const conhecidos = new Set(daGaleria.map((g) => g.path));
        const emUso = [];
        const registrar = (path, origem) => {
          if (path && path.startsWith("/assets/") && !conhecidos.has(path)) {
            conhecidos.add(path);
            emUso.push({ id: null, path, categoria: origem, descricao: "", origem });
          }
        };
        for (const k of ["img_hero", "img_instituicao", "img_og"]) registrar(getS(k), "Textos da Home");
        for (const t of db.prepare("SELECT name, photo FROM team WHERE photo<>''").all()) registrar(t.photo, "Diretoria");
        for (const p of db.prepare("SELECT title, image FROM portfolio WHERE image<>''").all()) registrar(p.image, "Parceiros");
        for (const p of db.prepare("SELECT title, image FROM posts WHERE image<>''").all()) registrar(p.image, "Memórias");
        return json(res, 200, { galeria: daGaleria, emUso });
      }
      // projetos saíram do CRUD do painel: agora são cadastrados no /restrito e
      // aqui o admin só lê (via /api/content) e publica.
      const tm = p.match(/^\/api\/(services|portfolio|documentos|team|posts|galeria)(?:\/(\d+))?$/);
      if (tm) {
        const table = tm[1], id = tm[2], cols = TABLES[table];
        if (req.method === "POST" && !id) {
          const b = await readBody(req);
          if ((table === "services" || table === "posts" || table === "projetos") && (b.slug || b.title)) {
            b.slug = slug(b.slug || b.title || table) || table;
            const clash = db.prepare(`SELECT id FROM ${table} WHERE slug=?`).get(b.slug);
            if (clash) b.slug = `${b.slug}-${Date.now().toString(36)}`;
          }
          const use = cols.filter((c) => c in b);
          db.prepare(`INSERT INTO ${table}(${use.join(",")}) VALUES(${use.map(() => "?").join(",")})`).run(...use.map((c) => b[c]));
          return json(res, 200, { ok: true });
        }
        if (req.method === "PUT" && id) {
          const b = await readBody(req);
          if ((table === "services" || table === "posts" || table === "projetos") && ("slug" in b || "title" in b)) {
            b.slug = slug(b.slug || b.title || table) || table;
            const clash = db.prepare(`SELECT id FROM ${table} WHERE slug=?`).get(b.slug);
            if (clash && String(clash.id) !== String(id)) b.slug = `${b.slug}-${Date.now().toString(36)}`;
          }
          const use = cols.filter((c) => c in b);
          if (use.length) db.prepare(`UPDATE ${table} SET ${use.map((c) => c + "=?").join(",")} WHERE id=?`).run(...use.map((c) => b[c]), id);
          return json(res, 200, { ok: true });
        }
        if (req.method === "DELETE" && id) {
          db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
          return json(res, 200, { ok: true });
        }
      }
      if (p === "/api/upload" && req.method === "POST") {
        const { name, dataUrl } = await readBody(req);
        // SVG fica DE FORA de propósito: pode conter <script> e, servido como
        // image/svg+xml, executaria na origem do site (XSS armazenado). As fotos
        // do painel são todas raster; os SVGs do layout são arquivos do projeto.
        const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/.exec(dataUrl || "");
        if (!m) return json(res, 400, { error: "Envie uma imagem PNG, JPG, WEBP ou GIF." });
        const safe = slug(path.parse(name || "foto").name).slice(0, 40) || "foto";
        const ext = "." + m[1].split("/")[1].replace("jpeg", "jpg");
        const file = `${Date.now().toString(36)}-${safe}${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], "base64"));
        return json(res, 200, { ok: true, path: `/assets/img/uploads/${file}` });
      }
      if (p === "/api/publish" && req.method === "POST") return json(res, 200, { ok: true, ...publish() });
      return json(res, 404, { error: "Rota não encontrada" });
    }

    if (p === "/admin" || p === "/admin/") {
      // no-store: painel autenticado não deve ficar em cache — e garante que a
      // versão mostrada na tela de login seja sempre a que está rodando agora.
      // CSP: mesmo que algo injete um <script src=...> externo, o navegador o
      // bloqueia. 'unsafe-inline' é necessário porque o painel usa script/estilo
      // inline; ainda assim, object/base/frame ficam trancados.
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": CSP_PAINEL });
      const adminHtml = fs.readFileSync(path.join(ROOT, "admin", "index.html"), "utf8")
        .replaceAll("{{APP_VERSION}}", APP_VERSION);
      return res.end(adminHtml);
    }
    /* Nunca servir: banco, fontes, metadados de repositório e arquivos ocultos.
       O /.git é o mais crítico — com ele, um git-dumper reconstrói o repositório
       inteiro (histórico incluso) a partir do site publicado.
       Exceção: /.well-known/ precisa passar, é por onde o Let's Encrypt valida
       o domínio para emitir e renovar o certificado. */
    const ocultoProibido = /(^|\/)\.(?!well-known\/)/.test(p);
    // .sh e .service entram na lista: deploy.sh e a unit do systemd descrevem
    // caminhos, usuário e serviço do servidor — mapa pronto para quem sondar
    const extProibida = /\.(js|json|md|db|log|bak|sh|service|conf|sqlite3?|ya?ml|toml|lock)$/i.test(p) && !p.startsWith("/assets/");
    if (/^\/(data|src|nginx|backups|node_modules)(\/|$)/.test(p) || ocultoProibido || extProibida) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404");
    }

    let file = path.normalize(path.join(ROOT, decodeURIComponent(p)));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("403"); }
    if (p === "/") file = path.join(ROOT, "index.html");
    else if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404"); }

    // Conta só a entrega de uma PÁGINA (não CSS, JS, imagem, sitemap ou robots):
    // é isso que faz 1 visita valer 1, e não 15 por causa dos assets da página.
    if (path.extname(file) === ".html") trackVisit(req, p);

    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  } catch (e) {
    // detalhe do erro vai só para o log do servidor: mensagem de exceção
    // costuma revelar caminho de arquivo e estrutura interna
    console.error(`  ✖ erro em ${p}:`, e.message);
    json(res, 500, { error: "Erro interno" });
  }
// Escuta só no localhost: quem fala com o mundo é o nginx. Sem isto, o painel
// ficaria acessível por http://IP:5189/admin/, sem HTTPS e sem cookie Secure.
// Para expor direto (ambiente sem proxy), rode com HOST=0.0.0.0
}).listen(PORT, process.env.HOST || "127.0.0.1", () => {
  console.log(`\n  Instituto Kenósis — site + gerenciador v${APP_VERSION}`);
  console.log(`  · Site:   http://localhost:${PORT}/`);
  console.log(`  · Painel: http://localhost:${PORT}/admin/`);

  // Testa a escrita no boot. Sem isto, um banco somente-leitura só aparece
  // quando o cliente tenta salvar algo e nada acontece — e o log fica mudo.
  try {
    setS("_teste_escrita", String(Date.now()));
    db.prepare("DELETE FROM settings WHERE key='_teste_escrita'").run();
  } catch (e) {
    const usuario = (() => { try { return require("node:os").userInfo().username; } catch { return "root"; } })();
    console.error(`  ✖ BANCO SEM PERMISSÃO DE ESCRITA: ${e.message}`);
    console.error("    O painel não vai conseguir salvar nada. O processo roda como:", usuario);
    console.error(`    Corrija com: sudo chown -R ${usuario}: "${ROOT}/data" "${ROOT}/assets/img/uploads"`);
  }
  // avisa sem imprimir a senha: em produção esse log vai parar no journalctl
  if (confereSenha("kenosis-admin", getS("admin_password_hash")))
    console.log(`  ⚠ A senha do painel ainda é a padrão. Troque em Painel → Senha antes de publicar.\n`);
  else console.log("");
});
