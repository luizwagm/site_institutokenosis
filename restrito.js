/* ==========================================================================
   restrito.js — Sistema de Gestão do Instituto Kenósis (área /restrito)

   INDEPENDENTE do painel do site (/admin). Compartilha só o processo Node e a
   porta; tudo o mais é separado:
     · banco próprio  → data/gestao.db  (nunca toca em data/site.db)
     · sessão própria → cookie "rid"    (não confunde com o "sid" do admin)
     · login próprio, layout próprio, rotas próprias sob /restrito

   O server.js delega para cá tudo que começa com /restrito. Como o nginx já
   encaminha o domínio inteiro para o Node, /restrito funciona sem mexer no
   vhost. Basta o link no rodapé do site.

   ATENÇÃO — dado sensível (LGPD): este banco guarda CPF, endereço e prontuário
   de saúde. É dado pessoal sensível. Por isso: escuta só no localhost (herda do
   server.js), envia noindex, exige login, e o deploy.sh precisa proteger o
   gestao.db do mesmo jeito que protege o site.db.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "restrito");
const db = new DatabaseSync(path.join(ROOT, "data", "gestao.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- operadores do sistema (login). perfil: admin | profissional | secretaria
  CREATE TABLE IF NOT EXISTS g_usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, email TEXT UNIQUE, senha_hash TEXT NOT NULL,
    perfil TEXT NOT NULL DEFAULT 'admin', ativo INTEGER DEFAULT 1, criado TEXT);

  -- configurações internas do sistema (chave/valor)
  CREATE TABLE IF NOT EXISTS g_config (key TEXT PRIMARY KEY, value TEXT);

  -- 3.1 pacientes
  CREATE TABLE IF NOT EXISTS pacientes (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, foto TEXT, nascimento TEXT, cpf TEXT, rg TEXT,
    endereco TEXT, telefone TEXT, email TEXT, nis TEXT, cartao_sus TEXT,
    escolaridade TEXT, vulneravel INTEGER DEFAULT 0, vulnerabilidade TEXT,
    primeiro_atendimento TEXT, consentimento INTEGER DEFAULT 0,
    observacoes TEXT, criado TEXT);

  -- 3.2 associados (não pacientes)
  CREATE TABLE IF NOT EXISTS associados (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, cpf TEXT, contato TEXT, endereco TEXT, foto TEXT,
    vinculo TEXT, adesao TEXT, mensalidade TEXT, status TEXT DEFAULT 'Ativo', criado TEXT);

  -- profissionais e especialidades atendidas
  CREATE TABLE IF NOT EXISTS profissionais (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, especialidade TEXT, registro TEXT, contato TEXT, ativo INTEGER DEFAULT 1);

  -- 3.3 agenda de atendimentos
  CREATE TABLE IF NOT EXISTS atendimentos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, profissional_id INTEGER, especialidade TEXT,
    data TEXT, hora TEXT, local TEXT, status TEXT DEFAULT 'Agendado',
    observacoes TEXT, criado TEXT);

  -- 3.4 prontuário eletrônico (evolução por sessão)
  CREATE TABLE IF NOT EXISTS prontuario (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, atendimento_id INTEGER, profissional TEXT, especialidade TEXT,
    data TEXT, avaliacao TEXT, evolucao TEXT, plano TEXT, encaminhamentos TEXT,
    anexos TEXT, responsavel TEXT, criado TEXT);

  -- 3.6 distribuição de benefícios
  CREATE TABLE IF NOT EXISTS beneficios (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, cpf TEXT, item TEXT, data TEXT, foto TEXT, local TEXT, responsavel TEXT, criado TEXT);

  -- 3.7 eventos comunitários
  CREATE TABLE IF NOT EXISTS eventos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    tipo TEXT, titulo TEXT NOT NULL, tema TEXT, local TEXT, data TEXT, hora TEXT,
    publico_alvo TEXT, participantes INTEGER, responsavel TEXT, avaliacao TEXT,
    fotos TEXT, criado TEXT);

  -- 3.8 documentos por paciente
  CREATE TABLE IF NOT EXISTS documentos_gestao (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, tipo TEXT, titulo TEXT, arquivo TEXT, data TEXT, criado TEXT);

  CREATE INDEX IF NOT EXISTS idx_atend_data ON atendimentos(data);
  CREATE INDEX IF NOT EXISTS idx_atend_pac ON atendimentos(paciente_id);
  CREATE INDEX IF NOT EXISTS idx_pront_pac ON prontuario(paciente_id);
`);

/* ------------------------- senha (scrypt) e config ------------------------ */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
function confereSenha(senha, guardado) {
  if (!guardado || !guardado.startsWith("scrypt$")) return false;
  const [, N, r, p, saltHex, dkHex] = guardado.split("$");
  const dk = crypto.scryptSync(String(senha), Buffer.from(saltHex, "hex"), dkHex.length / 2, { N: +N, r: +r, p: +p });
  return iguais(Buffer.from(dkHex, "hex"), dk);
}
const getC = (k) => db.prepare("SELECT value FROM g_config WHERE key=?").get(k)?.value;
const setC = (k, v) => db.prepare("INSERT INTO g_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

/* Semente: um usuário admin inicial. Senha padrão trocável na primeira entrada.
   Sem data/hora reais no seed (usa marcador fixo) — o importante é existir. */
if (db.prepare("SELECT COUNT(*) c FROM g_usuarios").get().c === 0) {
  db.prepare("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)")
    .run("Administrador", "admin", hashSenha("kenosis-gestao"), "admin", new Date().toISOString());
  console.log("  · /restrito: sistema de gestão criado. Login: admin · senha: kenosis-gestao");
}

/* ------------------------------- sessões --------------------------------- */
const SESSAO_HORAS = 8;
const sessoes = new Map();   // rid -> { userId, perfil, nome, ts }
function novaSessao(u) {
  const rid = crypto.randomBytes(24).toString("hex");
  sessoes.set(rid, { userId: u.id, perfil: u.perfil, nome: u.nome, ts: Date.now() });
  return rid;
}
function sessao(req) {
  const m = /(?:^|;\s*)rid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessoes.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.ts > SESSAO_HORAS * 3600_000) { sessoes.delete(m[1]); return null; }
  s.ts = Date.now();
  return { rid: m[1], ...s };
}
setInterval(() => {
  const lim = Date.now() - SESSAO_HORAS * 3600_000;
  for (const [k, v] of sessoes) if (v.ts < lim) sessoes.delete(k);
}, 30 * 60_000).unref();

/* Trava de força bruta por IP (igual filosofia do admin) */
const TENT_MAX = 5, BLOQ_MIN = 15;
const tentativas = new Map();
function bloqueado(ip) {
  const t = tentativas.get(ip);
  if (!t) return false;
  if (Date.now() - t.ts > BLOQ_MIN * 60_000) { tentativas.delete(ip); return false; }
  return t.n >= TENT_MAX;
}
function erroLogin(ip) {
  const t = tentativas.get(ip) || { n: 0, ts: Date.now() };
  t.n++; t.ts = Date.now(); tentativas.set(ip, t);
}

/* -------------------------------- utilidades ----------------------------- */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "";
const agora = () => new Date().toISOString();
function readBody(req) {
  return new Promise((ok, err) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 8e6) req.destroy(); });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } });
    req.on("error", err);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  res.end(JSON.stringify(obj));
}

/* Tabelas expostas via CRUD genérico e suas colunas graváveis */
const TAB = {
  pacientes:  ["nome", "foto", "nascimento", "cpf", "rg", "endereco", "telefone", "email", "nis", "cartao_sus", "escolaridade", "vulneravel", "vulnerabilidade", "primeiro_atendimento", "consentimento", "observacoes"],
  associados: ["nome", "cpf", "contato", "endereco", "foto", "vinculo", "adesao", "mensalidade", "status"],
  profissionais: ["nome", "especialidade", "registro", "contato", "ativo"],
  atendimentos: ["paciente_id", "profissional_id", "especialidade", "data", "hora", "local", "status", "observacoes"],
  prontuario: ["paciente_id", "atendimento_id", "profissional", "especialidade", "data", "avaliacao", "evolucao", "plano", "encaminhamentos", "anexos", "responsavel"],
  beneficios: ["nome", "cpf", "item", "data", "foto", "local", "responsavel"],
  eventos: ["tipo", "titulo", "tema", "local", "data", "hora", "publico_alvo", "participantes", "responsavel", "avaliacao", "fotos"],
  documentos_gestao: ["paciente_id", "tipo", "titulo", "arquivo", "data"],
};

const UPLOAD_DIR = path.join(ROOT, "restrito", "arquivos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Colunas reais de cada tabela (do próprio banco). Serve para o CRUD só gravar
// o que existe — e para saber se a tabela tem "criado" antes de carimbá-lo.
const COLS = {};
for (const t of Object.keys(TAB)) COLS[t] = new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));

/* ==========================================================================
   Handler — o server.js chama isto para tudo que casa /restrito
   Retorna true se tratou a requisição.
   ========================================================================== */
function handleRestrito(req, res, pathname) {
  if (pathname !== "/restrito" && !pathname.startsWith("/restrito/")) return false;

  // normaliza /restrito -> /restrito/
  if (pathname === "/restrito") { res.writeHead(302, { Location: "/restrito/" }); res.end(); return true; }

  const rota = pathname.slice("/restrito".length) || "/";   // ex.: "/", "/api/pacientes"

  /* --------------------------- API (JSON) ------------------------------- */
  if (rota.startsWith("/api/")) { rotaApi(req, res, rota.slice(5)).catch((e) => {
    console.error("  ✖ /restrito/api:", e.message); json(res, 500, { error: "Erro interno" });
  }); return true; }

  /* ------------------------- arquivos enviados -------------------------- */
  if (rota.startsWith("/arquivos/")) {
    if (!sessao(req)) { res.writeHead(403); res.end("403"); return true; }
    const nome = path.basename(decodeURIComponent(rota.slice("/arquivos/".length)));
    const arq = path.join(UPLOAD_DIR, nome);
    if (!arq.startsWith(UPLOAD_DIR) || !fs.existsSync(arq)) { res.writeHead(404); res.end("404"); return true; }
    const ext = path.extname(arq).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
    fs.createReadStream(arq).pipe(res);
    return true;
  }

  /* ------------------------------ app HTML ------------------------------ */
  if (rota === "/" || rota === "/index.html") {
    const arq = path.join(APP_DIR, "app.html");
    const html = fs.readFileSync(arq, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
    res.end(html);
    return true;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404");
  return true;
}

/* ------------------------------- API ------------------------------------- */
async function rotaApi(req, res, p) {
  const ip = clientIp(req);

  // login
  if (p === "login" && req.method === "POST") {
    if (bloqueado(ip)) return json(res, 429, { error: "Muitas tentativas. Aguarde 15 minutos." });
    const { usuario, senha } = await readBody(req);
    const u = db.prepare("SELECT * FROM g_usuarios WHERE email=? AND ativo=1").get(String(usuario || "").trim());
    if (!u || !confereSenha(senha, u.senha_hash)) { erroLogin(ip); return json(res, 401, { error: "Usuário ou senha incorretos." }); }
    tentativas.delete(ip);
    const rid = novaSessao(u);
    res.setHeader("Set-Cookie", `rid=${rid}; HttpOnly; SameSite=Lax; Path=/restrito; Max-Age=${SESSAO_HORAS * 3600}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
    return json(res, 200, { ok: true, nome: u.nome, perfil: u.perfil });
  }

  // daqui para baixo exige sessão
  const s = sessao(req);
  if (!s) return json(res, 401, { error: "Não autenticado" });

  if (p === "me") return json(res, 200, { nome: s.nome, perfil: s.perfil });

  if (p === "logout" && req.method === "POST") {
    sessoes.delete(s.rid);
    res.setHeader("Set-Cookie", "rid=; HttpOnly; Path=/restrito; Max-Age=0");
    return json(res, 200, { ok: true });
  }

  if (p === "senha" && req.method === "POST") {
    const { atual, nova } = await readBody(req);
    const u = db.prepare("SELECT * FROM g_usuarios WHERE id=?").get(s.userId);
    if (!confereSenha(atual, u.senha_hash)) return json(res, 400, { error: "Senha atual incorreta." });
    if (String(nova || "").length < 8) return json(res, 400, { error: "A nova senha precisa de ao menos 8 caracteres." });
    db.prepare("UPDATE g_usuarios SET senha_hash=? WHERE id=?").run(hashSenha(nova), s.userId);
    for (const [k, v] of sessoes) if (v.userId === s.userId && k !== s.rid) sessoes.delete(k);
    return json(res, 200, { ok: true });
  }

  // painel: números para a home do sistema
  if (p === "painel") {
    const n = (sql) => db.prepare(sql).get().c;
    return json(res, 200, {
      pacientes: n("SELECT COUNT(*) c FROM pacientes"),
      associados: n("SELECT COUNT(*) c FROM associados"),
      atendimentosHoje: db.prepare("SELECT COUNT(*) c FROM atendimentos WHERE data=?").get(new Date().toISOString().slice(0, 10)).c,
      eventos: n("SELECT COUNT(*) c FROM eventos"),
      beneficios: n("SELECT COUNT(*) c FROM beneficios"),
    });
  }

  // relatórios (3.5): agregações para a tela de indicadores
  if (p === "relatorios") {
    const grupo = (sql) => db.prepare(sql).all();
    const n = (sql) => db.prepare(sql).get().c;
    return json(res, 200, {
      totais: {
        pacientes: n("SELECT COUNT(*) c FROM pacientes"),
        associados: n("SELECT COUNT(*) c FROM associados"),
        atendimentos: n("SELECT COUNT(*) c FROM atendimentos"),
        faltas: n("SELECT COUNT(*) c FROM atendimentos WHERE status='Faltou'"),
        eventos: n("SELECT COUNT(*) c FROM eventos"),
        beneficios: n("SELECT COUNT(*) c FROM beneficios"),
      },
      porEspecialidade: grupo("SELECT COALESCE(NULLIF(especialidade,''),'(sem especialidade)') rotulo, COUNT(*) total FROM atendimentos GROUP BY rotulo ORDER BY total DESC"),
      porStatus: grupo("SELECT COALESCE(NULLIF(status,''),'(sem status)') rotulo, COUNT(*) total FROM atendimentos GROUP BY rotulo ORDER BY total DESC"),
      porMes: grupo("SELECT substr(data,1,7) rotulo, COUNT(*) total FROM atendimentos WHERE data<>'' GROUP BY rotulo ORDER BY rotulo DESC LIMIT 12"),
    });
  }

  // upload de arquivo/foto (fica no diretório privado do /restrito)
  if (p === "upload" && req.method === "POST") {
    const { name, dataUrl } = await readBody(req);
    const m = /^data:(image\/(?:png|jpe?g|webp)|application\/pdf);base64,(.+)$/.exec(dataUrl || "");
    if (!m) return json(res, 400, { error: "Envie imagem (png/jpg/webp) ou PDF." });
    const ext = m[1] === "application/pdf" ? ".pdf" : "." + m[1].split("/")[1].replace("jpeg", "jpg");
    const safe = String(name || "arq").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "arq";
    const file = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${safe}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], "base64"));
    return json(res, 200, { ok: true, path: `/restrito/arquivos/${file}` });
  }

  // CRUD genérico: /api/<tabela>[/<id>]
  const m = p.match(/^([a-z_]+)(?:\/(\d+))?$/);
  if (m && TAB[m[1]]) {
    const tabela = m[1], id = m[2], cols = TAB[tabela];
    if (req.method === "GET" && !id) {
      const q = new URL(req.url, "http://x").searchParams;
      const busca = (q.get("q") || "").trim();
      let sql = `SELECT * FROM ${tabela}`;
      const args = [];
      if (busca && (tabela === "pacientes" || tabela === "associados")) {
        sql += " WHERE nome LIKE ? OR cpf LIKE ?"; args.push("%" + busca + "%", "%" + busca + "%");
      }
      sql += ` ORDER BY id DESC`;
      return json(res, 200, db.prepare(sql).all(...args));
    }
    if (req.method === "GET" && id) return json(res, 200, db.prepare(`SELECT * FROM ${tabela} WHERE id=?`).get(id) || {});
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      const temCriado = COLS[tabela].has("criado");
      const campos = temCriado ? use.concat("criado") : use;
      const valores = temCriado ? use.map((c) => b[c]).concat(agora()) : use.map((c) => b[c]);
      const info = db.prepare(`INSERT INTO ${tabela}(${campos.join(",")}) VALUES(${campos.map(() => "?").join(",")})`).run(...valores);
      return json(res, 200, { ok: true, id: Number(info.lastInsertRowid) });
    }
    if (req.method === "PUT" && id) {
      const b = await readBody(req);
      const use = cols.filter((c) => c in b);
      if (use.length) db.prepare(`UPDATE ${tabela} SET ${use.map((c) => c + "=?").join(",")} WHERE id=?`).run(...use.map((c) => b[c]), id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      db.prepare(`DELETE FROM ${tabela} WHERE id=?`).run(id);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
}

module.exports = { handleRestrito };
