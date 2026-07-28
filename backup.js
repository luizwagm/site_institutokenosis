/* ==========================================================================
   backup.js — cópia de segurança automática dos bancos

   Por que existe: até aqui só havia backup quando alguém rodava o deploy. Se o
   servidor falhasse um mês depois da última publicação, perderíamos um mês de
   prontuários. Backup é o que de fato protege contra perda — não o motor do
   banco.

   Como faz: usa `VACUUM INTO`, o backup ONLINE do próprio SQLite. Ele gera uma
   cópia consistente mesmo com o sistema em uso e com escritas acontecendo — ao
   contrário de copiar o arquivo com `cp`, que pode capturar um estado partido
   (o WAL fica em outro arquivo). Depois de gerar, a cópia é ABERTA e submetida
   ao `integrity_check`: um backup que ninguém testa não é um backup.

   Roda dentro do processo Node, sem depender de cron/agendador do sistema —
   assim funciona igual em qualquer servidor. A cada hora ele pergunta "já
   passou o intervalo desde a última cópia?"; se sim, copia. Isso sobrevive a
   reinícios: se a máquina ficou desligada na hora marcada, o backup sai no
   próximo boot em vez de ser pulado.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const { abrirBanco } = require("./db");

const CARIMBO = () => new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "");

/* Uma cópia verificada de um banco. Devolve {ok, arquivo, bytes, erro}. */
function copiarBanco(origem, destinoDir) {
  const nome = path.basename(origem, ".db");
  let arquivo = "";
  let db = null, copia = null;
  try {
    if (!fs.existsSync(origem)) return { ok: false, erro: "banco ainda não existe" };
    fs.mkdirSync(destinoDir, { recursive: true });
    // O carimbo tem precisão de segundo. Duas cópias no mesmo segundo (backup
    // manual logo após o automático) cairiam no mesmo nome, e o VACUUM INTO se
    // recusa a sobrescrever — então desempata com um sufixo.
    const base = `${nome}.${CARIMBO()}`;
    arquivo = path.join(destinoDir, `${base}.db`);
    for (let i = 2; fs.existsSync(arquivo) && i < 100; i++) arquivo = path.join(destinoDir, `${base}-${i}.db`);
    db = abrirBanco(origem);
    // VACUUM INTO exige o caminho com barras normais, inclusive no Windows
    db.exec(`VACUUM INTO '${arquivo.split(path.sep).join("/").replace(/'/g, "''")}'`);
    db.close();
    db = null;

    // a cópia presta? abre e checa a integridade antes de considerá-la válida
    copia = abrirBanco(arquivo);
    const r = copia.prepare("PRAGMA integrity_check").get();
    const veredito = r ? (r.integrity_check || Object.values(r)[0]) : "";
    copia.close();
    copia = null;
    if (String(veredito).toLowerCase() !== "ok") {
      fs.unlinkSync(arquivo);
      return { ok: false, erro: "cópia corrompida (" + veredito + ")" };
    }
    return { ok: true, arquivo, bytes: fs.statSync(arquivo).size };
  } catch (e) {
    try { if (db) db.close(); } catch {}
    try { if (copia) copia.close(); } catch {}
    try { if (arquivo && fs.existsSync(arquivo)) fs.unlinkSync(arquivo); } catch {}
    return { ok: false, erro: e.message };
  }
}

/* Mantém só as N cópias mais recentes de cada banco. */
function limparAntigos(destinoDir, nomeBanco, manter, ext = ".db") {
  try {
    const arquivos = fs.readdirSync(destinoDir)
      .filter((f) => f.startsWith(nomeBanco + ".") && f.endsWith(ext))
      .map((f) => ({ f, t: fs.statSync(path.join(destinoDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    let removidos = 0;
    for (const velho of arquivos.slice(manter)) { fs.unlinkSync(path.join(destinoDir, velho.f)); removidos++; }
    return removidos;
  } catch { return 0; }
}

/* Quando foi a última cópia de um banco (ms) — 0 se nunca houve. */
function ultimaCopia(destinoDir, nomeBanco, ext = ".db") {
  try {
    return fs.readdirSync(destinoDir)
      .filter((f) => f.startsWith(nomeBanco + ".") && f.endsWith(ext))
      .reduce((max, f) => Math.max(max, fs.statSync(path.join(destinoDir, f)).mtimeMs), 0);
  } catch { return 0; }
}

/* ==========================================================================
   DUMP DO POSTGRES (sistema de gestão)

   O site continua em SQLite e é copiado com VACUUM INTO (função acima). A
   gestão foi para o PostgreSQL, que não é um arquivo — a cópia certa é o
   pg_dump, que produz um .sql restaurável em qualquer servidor.

   Feito com spawnSync porque a rotina de backup é sequencial e roda fora do
   caminho de qualquer requisição: ninguém está esperando por ela.

   Se o pg_dump não estiver instalado, o backup do Postgres falha mas o do site
   continua — e o erro aparece no log. Uma máquina sem postgresql-client não
   pode fazer o backup ficar em silêncio.
   ========================================================================== */
function dumparPostgres(cfg, destinoDir) {
  const { spawnSync } = require("node:child_process");
  const pg = cfg.postgres;
  if (!pg || !pg.database) return { ok: false, erro: "postgres não configurado" };
  /* Sem senha no ambiente o pg_dump abriria um prompt e ficaria PENDURADO —
     travando o deploy inteiro sem dizer por quê. Melhor recusar na hora, com
     um recado que aponta o arquivo que falta. */
  if (!pg.password) return { ok: false, erro: "sem PGPASSWORD no ambiente (confira /etc/kenosis.env)" };

  fs.mkdirSync(destinoDir, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  let arquivo = path.join(destinoDir, `${pg.database}.${carimbo}.sql`);
  // mesmo cuidado do backup do SQLite: duas cópias no mesmo segundo não se pisam
  for (let i = 2; fs.existsSync(arquivo) && i < 100; i++)
    arquivo = path.join(destinoDir, `${pg.database}.${carimbo}-${i}.sql`);

  const r = spawnSync(process.env.PG_DUMP || "pg_dump",
    ["--no-owner", "--no-privileges", "--clean", "--if-exists",
     "-h", pg.host || "127.0.0.1", "-p", String(pg.port || 5432),
     "-U", pg.user, "-d", pg.database, "-f", arquivo],
    { env: { ...process.env, PGPASSWORD: pg.password || "" }, windowsHide: true, encoding: "utf8" });

  if (r.error) return { ok: false, erro: r.error.code === "ENOENT" ? "pg_dump não instalado (pacote postgresql-client)" : r.error.message };
  if (r.status !== 0) {
    try { fs.unlinkSync(arquivo); } catch {}   // dump pela metade não fica no disco
    return { ok: false, erro: (r.stderr || "").trim().slice(0, 300) || `pg_dump saiu com código ${r.status}` };
  }
  /* Um dump de 0 byte é o pior resultado possível: existe, tem nome de backup e
     não tem nada dentro. Melhor apagar e gritar. */
  const bytes = fs.statSync(arquivo).size;
  if (bytes < 100) { try { fs.unlinkSync(arquivo); } catch {} return { ok: false, erro: "dump saiu vazio" }; }
  return { ok: true, arquivo, bytes };
}

/* Executa a rodada de backup de todos os bancos configurados. */
function rodarBackup(cfg, motivo) {
  const feitos = [];

  // 1) o banco da GESTÃO (PostgreSQL) — prontuários, o que mais importa
  if (cfg.postgres && cfg.postgres.database) {
    const r = dumparPostgres(cfg, cfg.destino);
    if (r.ok) {
      const removidos = limparAntigos(cfg.destino, cfg.postgres.database, cfg.manter, ".sql");
      const kb = Math.max(1, Math.round(r.bytes / 1024));
      console.log(`  · backup ${motivo}: ${path.basename(r.arquivo)} (${kb} KB)${removidos ? ` · ${removidos} antigo(s) removido(s)` : ""}`);
      feitos.push({ banco: cfg.postgres.database, arquivo: r.arquivo, bytes: r.bytes });
    } else {
      console.error(`  ✖ backup do PostgreSQL FALHOU: ${r.erro}`);
    }
  }

  // 2) o banco do SITE (SQLite)
  for (const origem of cfg.bancos) {
    const nome = path.basename(origem, ".db");
    const r = copiarBanco(origem, cfg.destino);
    if (r.ok) {
      const removidos = limparAntigos(cfg.destino, nome, cfg.manter);
      const kb = Math.max(1, Math.round(r.bytes / 1024));
      console.log(`  · backup ${motivo}: ${path.basename(r.arquivo)} (${kb} KB)${removidos ? ` · ${removidos} antigo(s) removido(s)` : ""}`);
      feitos.push({ banco: nome, arquivo: r.arquivo, bytes: r.bytes });
    } else if (r.erro !== "banco ainda não existe") {
      console.error(`  ✖ backup de ${nome} FALHOU: ${r.erro}`);
    }
  }
  return feitos;
}

/* Situação atual, para o painel e o verificar.sh mostrarem. */
function statusBackup(cfg) {
  const olhar = (nome, ext) => {
    const t = ultimaCopia(cfg.destino, nome, ext);
    let copias = 0;
    try { copias = fs.readdirSync(cfg.destino).filter((f) => f.startsWith(nome + ".") && f.endsWith(ext)).length; } catch {}
    return { banco: nome, motor: ext === ".sql" ? "PostgreSQL" : "SQLite",
      ultimo: t ? new Date(t).toISOString() : null, horasAtras: t ? (Date.now() - t) / 3600e3 : null, copias };
  };
  const bancos = cfg.bancos.map((origem) => olhar(path.basename(origem, ".db"), ".db"));
  if (cfg.postgres && cfg.postgres.database) bancos.unshift(olhar(cfg.postgres.database, ".sql"));
  return { destino: cfg.destino, intervaloHoras: cfg.intervaloHoras, manter: cfg.manter, bancos };
}

/* Liga a rotina. Chamado uma vez no boot do server.js. */
function agendarBackups(opcoes) {
  const cfg = {
    destino: opcoes.destino,
    bancos: opcoes.bancos.filter(Boolean),
    postgres: opcoes.postgres || null,
    manter: opcoes.manter || 30,
    intervaloHoras: opcoes.intervaloHoras || 24,
  };
  fs.mkdirSync(cfg.destino, { recursive: true });

  const venceu = (nome, ext) => {
    const t = ultimaCopia(cfg.destino, nome, ext);
    return !t || (Date.now() - t) > cfg.intervaloHoras * 3600e3;
  };
  const vencido = () =>
    cfg.bancos.some((origem) => venceu(path.basename(origem, ".db"), ".db")) ||
    (cfg.postgres && cfg.postgres.database ? venceu(cfg.postgres.database, ".sql") : false);

  // no boot: se está vencido, copia — mas depois de 20s, para não atrasar a subida
  setTimeout(() => { if (vencido()) rodarBackup(cfg, "de boot"); }, 20_000).unref();
  // a cada hora, verifica se venceu. Sobrevive a reinícios e a máquina desligada.
  setInterval(() => { if (vencido()) rodarBackup(cfg, "diário"); }, 3600e3).unref();

  console.log(`  · backup automático: a cada ${cfg.intervaloHoras}h em ${path.relative(process.cwd(), cfg.destino) || cfg.destino} (mantém ${cfg.manter})`);
  return { cfg, rodarAgora: (motivo) => rodarBackup(cfg, motivo || "manual"), status: () => statusBackup(cfg) };
}

module.exports = { agendarBackups, rodarBackup, statusBackup, copiarBanco, dumparPostgres };
