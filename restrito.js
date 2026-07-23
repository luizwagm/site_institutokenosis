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
// Versão única do sistema de gestão (/restrito) e do portal do associado
// (/externo). Mudou um dos dois → sobe aqui; os dois exibem o mesmo número.
const SISTEMA_VERSION = "1.5.0";
// CSP das telas do sistema de gestão e do portal — bloqueia script/objeto
// externos; só libera as fontes do Google. 'unsafe-inline' é preciso porque as
// telas usam script/estilo inline. A janela de impressão (about:blank via
// document.write) herda esta política — por isso o print usa <script> inline
// e imagem de mesma origem, ambos permitidos aqui.
const CSP_GESTAO = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'";
const db = new DatabaseSync(path.join(ROOT, "data", "gestao.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- operadores do sistema (login). perfil: admin | profissional | secretaria.
  -- profissional_id liga um usuário-profissional ao seu registro na tabela
  -- profissionais — é assim que ele enxerga "a SUA agenda".
  CREATE TABLE IF NOT EXISTS g_usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, email TEXT UNIQUE, senha_hash TEXT NOT NULL,
    perfil TEXT NOT NULL DEFAULT 'admin', ativo INTEGER DEFAULT 1,
    profissional_id INTEGER, criado TEXT);

  -- configurações internas do sistema (chave/valor)
  CREATE TABLE IF NOT EXISTS g_config (key TEXT PRIMARY KEY, value TEXT);

  -- 3.1 pacientes (chamados "usuários" na interface — usuário do serviço social)
  CREATE TABLE IF NOT EXISTS pacientes (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, foto TEXT, nascimento TEXT, cpf TEXT, rg TEXT,
    pai TEXT, mae TEXT, endereco TEXT, telefone TEXT, email TEXT, nis TEXT, cartao_sus TEXT,
    escolaridade TEXT, vulneravel INTEGER DEFAULT 0, vulnerabilidade TEXT,
    primeiro_atendimento TEXT, consentimento INTEGER DEFAULT 0,
    projeto_id INTEGER, observacoes TEXT, criado TEXT);

  -- Projetos socioassistenciais — cadastrados AQUI (no sistema de gestão); o
  -- painel do site apenas lê e publica. Campos iguais aos que o site espera.
  CREATE TABLE IF NOT EXISTS projetos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, slug TEXT, sigla TEXT, status TEXT, resumo TEXT,
    publico TEXT, content TEXT, sort INTEGER DEFAULT 0, criado TEXT);

  -- 3.2 associados (não pacientes). senha_externo = código de 8 dígitos com que
  -- o associado entra no portal /externo para ver a própria ficha.
  CREATE TABLE IF NOT EXISTS associados (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, cpf TEXT, contato TEXT, endereco TEXT, foto TEXT,
    vinculo TEXT, adesao TEXT, mensalidade TEXT, status TEXT DEFAULT 'Ativo',
    senha_externo TEXT, criado TEXT);

  -- profissionais e especialidades atendidas
  CREATE TABLE IF NOT EXISTS profissionais (id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, especialidade TEXT, registro TEXT, contato TEXT, ativo INTEGER DEFAULT 1);

  -- 3.3 agenda de atendimentos
  CREATE TABLE IF NOT EXISTS atendimentos (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, profissional_id INTEGER, especialidade TEXT,
    data TEXT, hora TEXT, local TEXT, status TEXT DEFAULT 'Agendado',
    observacoes TEXT, criado TEXT);

  -- 3.4 prontuário eletrônico (evolução por sessão). usuario_id = operador que
  -- criou o registro; o perfil "profissional" só enxerga os seus.
  CREATE TABLE IF NOT EXISTS prontuario (id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER, atendimento_id INTEGER, profissional TEXT, especialidade TEXT,
    data TEXT, avaliacao TEXT, evolucao TEXT, plano TEXT, encaminhamentos TEXT,
    anexos TEXT, responsavel TEXT, usuario_id INTEGER, criado TEXT);

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

// Migração leve para bancos criados antes destas colunas (o CREATE IF NOT EXISTS
// não altera tabela existente). Ignora o erro se a coluna já existir.
for (const alt of [
  "ALTER TABLE associados ADD COLUMN senha_externo TEXT",
  "ALTER TABLE prontuario ADD COLUMN usuario_id INTEGER",
  "ALTER TABLE g_usuarios ADD COLUMN profissional_id INTEGER",
  "ALTER TABLE pacientes ADD COLUMN pai TEXT",
  "ALTER TABLE pacientes ADD COLUMN mae TEXT",
  "ALTER TABLE pacientes ADD COLUMN projeto_id INTEGER",
]) { try { db.exec(alt); } catch { /* já existe */ } }

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
  sessoes.set(rid, { userId: u.id, perfil: u.perfil, nome: u.nome, profissionalId: u.profissional_id || null, ts: Date.now() });
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
const slugify = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/* Regras de agenda: expediente 07h–12h e 14h–18h (intervalo 12h–14h), cada
   atendimento ocupa um bloco de 40 min, e o mesmo profissional não pode ter
   dois blocos que se sobreponham. Devolve a mensagem de erro ou null se ok. */
function validarAgenda(profissionalId, data, hora, excluirId) {
  if (!hora) return null;                        // sem horário definido, sem regra a aplicar
  const [h, mm] = String(hora).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(mm)) return "Horário inválido.";
  const ini = h * 60 + mm, fim = ini + 40;
  const manha = ini >= 7 * 60 && fim <= 12 * 60;
  const tarde = ini >= 14 * 60 && fim <= 18 * 60;
  if (!manha && !tarde)
    return "Horário fora do expediente. Os atendimentos vão das 07h às 12h e das 14h às 18h, em blocos de 40 minutos (o último começa 11h20 pela manhã e 17h20 à tarde).";
  if (!data || !profissionalId) return null;     // sem data e profissional não há como conferir choque
  const outros = excluirId
    ? db.prepare("SELECT hora FROM atendimentos WHERE profissional_id=? AND data=? AND hora<>'' AND id<>?").all(profissionalId, data, excluirId)
    : db.prepare("SELECT hora FROM atendimentos WHERE profissional_id=? AND data=? AND hora<>''").all(profissionalId, data);
  for (const o of outros) {
    const [oh, om] = String(o.hora).split(":").map(Number);
    if (Number.isNaN(oh)) continue;
    const oi = oh * 60 + om, of = oi + 40;
    if (ini < of && oi < fim) return `Choque de horário: este profissional já tem um atendimento às ${o.hora} (cada atendimento ocupa 40 minutos).`;
  }
  return null;
}
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
  pacientes:  ["nome", "foto", "nascimento", "cpf", "rg", "pai", "mae", "endereco", "telefone", "email", "nis", "cartao_sus", "escolaridade", "vulneravel", "vulnerabilidade", "primeiro_atendimento", "consentimento", "projeto_id", "observacoes"],
  projetos:   ["title", "slug", "sigla", "status", "resumo", "publico", "content", "sort"],
  associados: ["nome", "cpf", "contato", "endereco", "foto", "vinculo", "adesao", "mensalidade", "status", "senha_externo"],
  profissionais: ["nome", "especialidade", "registro", "contato", "ativo"],
  atendimentos: ["paciente_id", "profissional_id", "especialidade", "data", "hora", "local", "status", "observacoes"],
  prontuario: ["paciente_id", "atendimento_id", "profissional", "especialidade", "data", "avaliacao", "evolucao", "plano", "encaminhamentos", "anexos", "responsavel", "usuario_id"],
  beneficios: ["nome", "cpf", "item", "data", "foto", "local", "responsavel"],
  eventos: ["tipo", "titulo", "tema", "local", "data", "hora", "publico_alvo", "participantes", "responsavel", "avaliacao", "fotos"],
  documentos_gestao: ["paciente_id", "tipo", "titulo", "arquivo", "data"],
};

const UPLOAD_DIR = path.join(ROOT, "restrito", "arquivos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Perfis de acesso (seção 2 da especificação). Cada perfil enxerga só os
   módulos abaixo; "usuarios" é sempre exclusivo do admin. O front esconde o que
   não pode, mas quem MANDA é esta checagem no servidor.
   - admin: acesso total.
   - secretaria/atendente: cadastros, agendamento e relatórios (não vê prontuário clínico).
   - profissional de saúde/terapias: sua agenda e os prontuários. */
const PERFIS = ["admin", "secretaria", "profissional"];
const PERM = {
  admin: "*",
  secretaria: new Set(["pacientes", "associados", "profissionais", "atendimentos", "documentos_gestao", "beneficios", "eventos", "projetos", "relatorios"]),
  // profissional vê SOMENTE a sua agenda e os seus prontuários. Nada mais.
  // Lê pacientes/profissionais só como apoio (nomes nas telas e seletores),
  // sem menu próprio — ver PERM_LEITURA.
  profissional: new Set(["atendimentos", "prontuario"]),
};
const PERM_LEITURA = { profissional: new Set(["pacientes", "profissionais"]) };
const pode = (perfil, modulo) => perfil === "admin" || (PERM[perfil] ? PERM[perfil].has(modulo) : false);
const podeLer = (perfil, modulo) => pode(perfil, modulo) || (PERM_LEITURA[perfil] && PERM_LEITURA[perfil].has(modulo));
const adminsAtivos = () => db.prepare("SELECT COUNT(*) c FROM g_usuarios WHERE perfil='admin' AND ativo=1").get().c;

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
    const html = fs.readFileSync(arq, "utf8").replace(/\{\{VERSAO\}\}/g, SISTEMA_VERSION);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": CSP_GESTAO });
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

  // painel: números para a home do sistema. O profissional não vê números
  // globais (só a sua agenda e prontuários) — devolve os dele.
  if (p === "painel") {
    const n = (sql) => db.prepare(sql).get().c;
    const hoje = new Date().toISOString().slice(0, 10);
    if (s.perfil === "profissional") {
      return json(res, 200, { profissional: true,
        agendaHoje: db.prepare("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=? AND data=?").get(s.profissionalId, hoje).c,
        agendaTotal: db.prepare("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=?").get(s.profissionalId).c,
        prontuarios: db.prepare("SELECT COUNT(*) c FROM prontuario WHERE usuario_id=?").get(s.userId).c });
    }
    return json(res, 200, {
      pacientes: n("SELECT COUNT(*) c FROM pacientes"),
      associados: n("SELECT COUNT(*) c FROM associados"),
      atendimentosHoje: db.prepare("SELECT COUNT(*) c FROM atendimentos WHERE data=?").get(hoje).c,
      eventos: n("SELECT COUNT(*) c FROM eventos"),
      beneficios: n("SELECT COUNT(*) c FROM beneficios"),
    });
  }

  // relatórios (3.5): agregações para a tela de indicadores
  if (p === "relatorios") {
    if (!pode(s.perfil, "relatorios")) return json(res, 403, { error: "Sem permissão." });
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

  /* ------- Usuários do sistema (perfis de acesso) — só o admin ---------- */
  if (p === "usuarios" || /^usuarios\/\d+$/.test(p)) {
    if (s.perfil !== "admin") return json(res, 403, { error: "Apenas o administrador gerencia usuários." });
    const idm = p.match(/^usuarios\/(\d+)$/);
    const id = idm ? idm[1] : null;
    // nunca devolvemos o hash da senha
    if (req.method === "GET" && !id) return json(res, 200, db.prepare("SELECT id,nome,email,perfil,ativo,profissional_id FROM g_usuarios ORDER BY id").all());
    if (req.method === "GET" && id) return json(res, 200, db.prepare("SELECT id,nome,email,perfil,ativo,profissional_id FROM g_usuarios WHERE id=?").get(id) || {});
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      const nome = String(b.nome || "").trim(), email = String(b.email || "").trim(), perfil = String(b.perfil || "secretaria").trim();
      if (!nome || !email) return json(res, 400, { error: "Nome e usuário (login) são obrigatórios." });
      if (!PERFIS.includes(perfil)) return json(res, 400, { error: "Perfil inválido." });
      if (String(b.senha || "").length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." });
      const profId = perfil === "profissional" && b.profissional_id ? Number(b.profissional_id) : null;
      try {
        db.prepare("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,profissional_id,criado) VALUES(?,?,?,?,?,?,?)")
          .run(nome, email, hashSenha(b.senha), perfil, b.ativo === undefined ? 1 : (Number(b.ativo) ? 1 : 0), profId, agora());
      } catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao criar usuário." }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === "PUT" && id) {
      const b = await readBody(req);
      const alvo = db.prepare("SELECT perfil,ativo FROM g_usuarios WHERE id=?").get(id);
      if (!alvo) return json(res, 404, { error: "Usuário não encontrado." });
      // não deixar o único admin ativo se rebaixar a si mesmo ou desativar
      const viraNaoAdmin = b.perfil !== undefined && b.perfil !== "admin";
      const viraInativo = b.ativo !== undefined && !Number(b.ativo);
      if (alvo.perfil === "admin" && alvo.ativo && (viraNaoAdmin || viraInativo) && adminsAtivos() <= 1)
        return json(res, 400, { error: "Não é possível rebaixar ou desativar o único administrador." });
      const sets = [], args = [];
      if (b.nome !== undefined) { sets.push("nome=?"); args.push(String(b.nome).trim()); }
      if (b.email !== undefined) { sets.push("email=?"); args.push(String(b.email).trim()); }
      if (b.perfil !== undefined) { if (!PERFIS.includes(b.perfil)) return json(res, 400, { error: "Perfil inválido." }); sets.push("perfil=?"); args.push(b.perfil); }
      if (b.ativo !== undefined) { sets.push("ativo=?"); args.push(Number(b.ativo) ? 1 : 0); }
      if (b.profissional_id !== undefined) { sets.push("profissional_id=?"); args.push(b.profissional_id ? Number(b.profissional_id) : null); }
      if (b.senha) { if (String(b.senha).length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." }); sets.push("senha_hash=?"); args.push(hashSenha(b.senha)); }
      if (sets.length) {
        try { db.prepare(`UPDATE g_usuarios SET ${sets.join(",")} WHERE id=?`).run(...args, id); }
        catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao salvar." }); }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (Number(id) === s.userId) return json(res, 400, { error: "Você não pode excluir o próprio usuário." });
      const alvo = db.prepare("SELECT perfil,ativo FROM g_usuarios WHERE id=?").get(id);
      if (alvo && alvo.perfil === "admin" && alvo.ativo && adminsAtivos() <= 1) return json(res, 400, { error: "Não é possível excluir o único administrador." });
      db.prepare("DELETE FROM g_usuarios WHERE id=?").run(id);
      return json(res, 200, { ok: true });
    }
  }

  // Gerar/atualizar a senha do portal do associado — só admin e secretaria.
  const sm = p.match(/^associados\/(\d+)\/senha$/);
  if (sm && req.method === "POST") {
    if (!["admin", "secretaria"].includes(s.perfil)) return json(res, 403, { error: "Sem permissão." });
    const nova = String(crypto.randomInt(10000000, 100000000));   // 8 dígitos
    db.prepare("UPDATE associados SET senha_externo=? WHERE id=?").run(hashSenha(nova), sm[1]);   // guarda o hash
    return json(res, 200, { ok: true, senha: nova });                                           // devolve o texto uma vez
  }

  // CRUD genérico: /api/<tabela>[/<id>]
  const m = p.match(/^([a-z_]+)(?:\/(\d+))?$/);
  if (m && TAB[m[1]]) {
    const tabela = m[1], id = m[2], cols = TAB[tabela];
    // leitura precisa de podeLer (o profissional lê pacientes p/ o seletor);
    // qualquer escrita exige acesso pleno ao módulo.
    if (!podeLer(s.perfil, tabela)) return json(res, 403, { error: "Seu perfil não tem acesso a este módulo." });
    if (req.method !== "GET" && !pode(s.perfil, tabela)) return json(res, 403, { error: "Seu perfil não pode alterar este módulo." });

    /* Recorte do profissional: só os SEUS registros. No prontuário "seu" = quem
       criou (usuario_id); na agenda "seu" = para quem o atendimento é marcado
       (profissional_id, ligado ao usuário). Fora esses dois casos, sem recorte. */
    let donoCol = null, donoVal = null;
    if (s.perfil === "profissional") {
      if (tabela === "prontuario") { donoCol = "usuario_id"; donoVal = s.userId; }
      else if (tabela === "atendimentos") { donoCol = "profissional_id"; donoVal = s.profissionalId; }
    }

    if (req.method === "GET" && !id) {
      const q = new URL(req.url, "http://x").searchParams;
      const busca = (q.get("q") || "").trim();
      let sql = `SELECT * FROM ${tabela}`;
      const cond = [], args = [];
      if (busca && (tabela === "pacientes" || tabela === "associados")) { cond.push("(nome LIKE ? OR cpf LIKE ?)"); args.push("%" + busca + "%", "%" + busca + "%"); }
      if (donoCol) { cond.push(donoCol + "=?"); args.push(donoVal); }
      if (cond.length) sql += " WHERE " + cond.join(" AND ");
      sql += ` ORDER BY id DESC`;
      return json(res, 200, db.prepare(sql).all(...args));
    }
    if (req.method === "GET" && id) {
      const row = db.prepare(`SELECT * FROM ${tabela} WHERE id=?`).get(id);
      if (!row) return json(res, 404, { error: "Registro não encontrado." });
      if (donoCol && String(row[donoCol]) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." });
      return json(res, 200, row);
    }
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      if (tabela === "prontuario") b.usuario_id = s.userId;                 // carimba o dono
      if (tabela === "atendimentos" && s.perfil === "profissional") b.profissional_id = s.profissionalId; // marca na própria agenda
      // senha do portal: guarda só o HASH (scrypt); o texto puro é devolvido
      // UMA vez para a secretaria repassar, e nunca mais fica recuperável.
      let senhaGerada = null;
      if (tabela === "associados") { senhaGerada = String(crypto.randomInt(10000000, 100000000)); b.senha_externo = hashSenha(senhaGerada); }
      if (tabela === "atendimentos") { const e = validarAgenda(b.profissional_id, b.data, b.hora, null); if (e) return json(res, 400, { error: e }); }
      if (tabela === "projetos") { b.slug = slugify(b.slug || b.title); if (b.slug && db.prepare("SELECT id FROM projetos WHERE slug=?").get(b.slug)) b.slug = `${b.slug}-${Date.now().toString(36)}`; }
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      const temCriado = COLS[tabela].has("criado");
      const campos = temCriado ? use.concat("criado") : use;
      const valores = temCriado ? use.map((c) => b[c]).concat(agora()) : use.map((c) => b[c]);
      const info = db.prepare(`INSERT INTO ${tabela}(${campos.join(",")}) VALUES(${campos.map(() => "?").join(",")})`).run(...valores);
      return json(res, 200, { ok: true, id: Number(info.lastInsertRowid), senha: senhaGerada || undefined });
    }
    if (req.method === "PUT" && id) {
      if (donoCol) { const dono = db.prepare(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`).get(id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      const b = await readBody(req);
      delete b.usuario_id; delete b.senha_externo;    // não se troca dono nem senha por aqui
      if (donoCol === "profissional_id") delete b.profissional_id;   // o profissional não reatribui o atendimento
      if (tabela === "atendimentos") {
        const at = db.prepare("SELECT profissional_id,data,hora FROM atendimentos WHERE id=?").get(id) || {};
        const e = validarAgenda(b.profissional_id ?? at.profissional_id, b.data ?? at.data, b.hora ?? at.hora, id);
        if (e) return json(res, 400, { error: e });
      }
      if (tabela === "projetos" && (b.slug !== undefined || b.title !== undefined)) {
        b.slug = slugify(b.slug || b.title);
        const clash = b.slug && db.prepare("SELECT id FROM projetos WHERE slug=?").get(b.slug);
        if (clash && String(clash.id) !== String(id)) b.slug = `${b.slug}-${Date.now().toString(36)}`;
      }
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      if (use.length) db.prepare(`UPDATE ${tabela} SET ${use.map((c) => c + "=?").join(",")} WHERE id=?`).run(...use.map((c) => b[c]), id);
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (donoCol) { const dono = db.prepare(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`).get(id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      db.prepare(`DELETE FROM ${tabela} WHERE id=?`).run(id);
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
}

/* ==========================================================================
   Portal do associado — /externo
   O associado entra com CPF + a senha de 8 dígitos gerada no cadastro e vê a
   PRÓPRIA ficha, situação e novidades. Usa o MESMO banco (gestao.db); só uma
   sessão à parte (cookie "eid"). Somente leitura da própria ficha.
   ========================================================================== */
const sessoesExt = new Map();   // eid -> { associadoId, nome, ts }
const SESSAO_EXT_HORAS = 6;
function sessaoExt(req) {
  const m = /(?:^|;\s*)eid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessoesExt.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.ts > SESSAO_EXT_HORAS * 3600_000) { sessoesExt.delete(m[1]); return null; }
  s.ts = Date.now();
  return { eid: m[1], ...s };
}
setInterval(() => { const lim = Date.now() - SESSAO_EXT_HORAS * 3600_000; for (const [k, v] of sessoesExt) if (v.ts < lim) sessoesExt.delete(k); }, 30 * 60_000).unref();

function handleExterno(req, res, pathname) {
  if (pathname !== "/externo" && !pathname.startsWith("/externo/")) return false;
  if (pathname === "/externo") { res.writeHead(302, { Location: "/externo/" }); res.end(); return true; }
  const rota = pathname.slice("/externo".length) || "/";

  if (rota.startsWith("/api/")) { rotaExt(req, res, rota.slice(5)).catch((e) => {
    console.error("  ✖ /externo/api:", e.message); json(res, 500, { error: "Erro interno" });
  }); return true; }

  // foto da ficha, servida só para o próprio associado logado
  if (rota === "/foto") {
    const s = sessaoExt(req);
    const a = s && db.prepare("SELECT foto FROM associados WHERE id=?").get(s.associadoId);
    const arq = a && a.foto ? path.join(UPLOAD_DIR, path.basename(a.foto)) : null;
    if (!arq || !arq.startsWith(UPLOAD_DIR) || !fs.existsSync(arq)) { res.writeHead(404); res.end("404"); return true; }
    const ext = path.extname(arq).toLowerCase();
    res.writeHead(200, { "Content-Type": { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[ext] || "application/octet-stream", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
    fs.createReadStream(arq).pipe(res); return true;
  }

  if (rota === "/" || rota === "/index.html") {
    const html = fs.readFileSync(path.join(APP_DIR, "externo.html"), "utf8").replace(/\{\{VERSAO\}\}/g, SISTEMA_VERSION);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": CSP_GESTAO });
    res.end(html); return true;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }); res.end("404"); return true;
}

async function rotaExt(req, res, p) {
  const ip = clientIp(req);
  if (p === "login" && req.method === "POST") {
    if (bloqueado(ip)) return json(res, 429, { error: "Muitas tentativas. Aguarde 15 minutos." });
    const { cpf, senha } = await readBody(req);
    const dig = String(cpf || "").replace(/\D/g, "");
    // acha o associado pelo CPF e confere o HASH da senha (nunca comparamos texto puro)
    const cand = dig ? db.prepare("SELECT id,nome,cpf,senha_externo FROM associados WHERE senha_externo IS NOT NULL AND senha_externo<>''").all() : [];
    const a = cand.find((x) => String(x.cpf || "").replace(/\D/g, "") === dig && confereSenha(String(senha || "").trim(), x.senha_externo));
    if (!a) { erroLogin(ip); return json(res, 401, { error: "CPF ou senha incorretos." }); }
    tentativas.delete(ip);
    const eid = crypto.randomBytes(24).toString("hex");
    sessoesExt.set(eid, { associadoId: a.id, nome: a.nome, ts: Date.now() });
    res.setHeader("Set-Cookie", `eid=${eid}; HttpOnly; SameSite=Lax; Path=/externo; Max-Age=${SESSAO_EXT_HORAS * 3600}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
    return json(res, 200, { ok: true, nome: a.nome });
  }
  const s = sessaoExt(req);
  if (!s) return json(res, 401, { error: "Não autenticado" });
  if (p === "logout" && req.method === "POST") { sessoesExt.delete(s.eid); res.setHeader("Set-Cookie", "eid=; HttpOnly; Path=/externo; Max-Age=0"); return json(res, 200, { ok: true }); }
  if (p === "ficha") {
    const a = db.prepare("SELECT nome,cpf,contato,endereco,vinculo,adesao,mensalidade,status,foto FROM associados WHERE id=?").get(s.associadoId) || {};
    const eventos = db.prepare("SELECT tipo,titulo,tema,local,data FROM eventos WHERE data<>'' ORDER BY data DESC LIMIT 8").all();
    return json(res, 200, { ficha: a, temFoto: !!a.foto, novidades: eventos });
  }
  return json(res, 404, { error: "Rota não encontrada" });
}

/* ------- Ponte com o site: o painel (/admin) só LÊ os projetos daqui ------ */
const listarProjetos = () => db.prepare("SELECT * FROM projetos ORDER BY sort, id").all();
const contarProjetos = () => db.prepare("SELECT COUNT(*) c FROM projetos").get().c;
// Semeia os projetos que já existiam no site.db na primeira vez (migração única).
function importarProjetos(rows) {
  const ins = db.prepare("INSERT INTO projetos(title,slug,sigla,status,resumo,publico,content,sort,criado) VALUES(?,?,?,?,?,?,?,?,?)");
  let n = 0;
  for (const p of rows || []) { ins.run(p.title, p.slug || slugify(p.title), p.sigla || "", p.status || "", p.resumo || "", p.publico || "", p.content || "", p.sort || 0, agora()); n++; }
  return n;
}

module.exports = { handleRestrito, handleExterno, listarProjetos, contarProjetos, importarProjetos };
