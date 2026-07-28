/* ==========================================================================
   migrar.js — aplica as migrations do PostgreSQL (sistema de gestão)

   Cada arquivo .sql em migrations/ roda UMA vez, na ordem do nome, e fica
   registrado em schema_migrations. Rodar de novo não faz nada — é seguro
   chamar a cada boot e a cada deploy.

   Por que isto substituiu a lista de ALTER TABLE que existia no boot:
   aquela lista rodava cada ALTER dentro de um try/catch vazio, que funcionava
   para o caso "coluna já existe" mas engolia IGUALMENTE um erro de digitação
   no SQL. Uma migração escrita errada ficaria anos sem ser aplicada, em
   silêncio. Aqui, migração que falha PARA o boot e aparece no log.

   Cada migração roda dentro de UMA transação: ou o arquivo inteiro entra, ou
   nada dele entra. Não existe banco meio migrado.

   Uso:
     node migrar.js            aplica o que falta
     node migrar.js --status   só mostra o que já foi aplicado
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const { Q, carregarAmbiente } = require("./pg");

const DIR = path.join(__dirname, "migrations");

async function garantirTabela() {
  await Q.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    versao    TEXT PRIMARY KEY,
    aplicada  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ms        INTEGER
  )`);
}

const arquivos = () =>
  fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()
    : [];

async function aplicadas() {
  const rows = await Q.all("SELECT versao FROM schema_migrations ORDER BY versao");
  return new Set(rows.map((r) => r.versao));
}

async function migrar({ silencioso = false } = {}) {
  await garantirTabela();
  const feitas = await aplicadas();
  const pendentes = arquivos().filter((f) => !feitas.has(f));

  if (!pendentes.length) {
    if (!silencioso) console.log(`  · migrations: em dia (${feitas.size} aplicada(s)).`);
    return [];
  }

  const aplicadasAgora = [];
  for (const arq of pendentes) {
    const sql = fs.readFileSync(path.join(DIR, arq), "utf8");
    const t0 = Date.now();
    /* O SQL vai por Q.exec dentro de Q.tx: exec não traduz `?` para `$n` de
       forma perigosa aqui porque migração não usa parâmetro — mas o LIKE→ILIKE
       do adaptador também não atrapalha, pois índices e DDL não usam LIKE. */
    await Q.tx(async () => {
      await Q.exec(sql);
      await Q.run("INSERT INTO schema_migrations(versao, ms) VALUES(?,?)", arq, Date.now() - t0);
    });
    aplicadasAgora.push(arq);
    console.log(`  · migration aplicada: ${arq} (${Date.now() - t0}ms)`);
  }
  return aplicadasAgora;
}

async function status() {
  await garantirTabela();
  const feitas = await Q.all("SELECT versao, aplicada, ms FROM schema_migrations ORDER BY versao");
  const todos = arquivos();
  const setFeitas = new Set(feitas.map((f) => f.versao));
  console.log("\n  MIGRATIONS\n");
  for (const a of todos) {
    const f = feitas.find((x) => x.versao === a);
    console.log(f
      ? `   ✓ ${a}  — ${new Date(f.aplicada).toLocaleString("pt-BR")} (${f.ms}ms)`
      : `   · ${a}  — PENDENTE`);
  }
  /* Migração registrada cujo arquivo sumiu é sinal de que alguém apagou um .sql
     já aplicado — o banco tem uma alteração que o código não sabe mais descrever. */
  for (const f of feitas) if (!todos.includes(f.versao)) console.log(`   ⚠ ${f.versao} — aplicada, mas o arquivo não está mais em migrations/`);
  console.log("");
}

module.exports = { migrar, status };

/* ------------------------------- CLI ------------------------------------- */
if (require.main === module) {
  carregarAmbiente(__dirname);
  (async () => {
    try {
      if (process.argv.includes("--status")) await status();
      else await migrar();
      await Q.fechar();
      process.exit(0);
    } catch (e) {
      console.error("\n  ✖ migração falhou:", e.message, "\n");
      await Q.fechar().catch(() => {});
      process.exit(1);
    }
  })();
}
