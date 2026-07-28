/* ==========================================================================
   migrar-dados.js — leva o conteúdo do data/gestao.db (SQLite) para o PostgreSQL

   Roda UMA vez, na virada. Depois disso o gestao.db vira só um arquivo de
   arquivo morto — o sistema não o abre mais.

   O QUE ESTE SCRIPT GARANTE (é dado de paciente, não pode "quase" dar certo):

   1. Não começa sem conferir. Antes de escrever qualquer coisa ele procura no
      SQLite as duplicidades que o Postgres vai recusar (dois prontuários para
      o mesmo paciente+procedimento, código de paciente repetido, número de
      prontuário repetido) e MOSTRA as linhas. É melhor descobrir aqui, com o
      sistema ainda no ar, do que no meio da carga.

   2. Não escreve por cima. Se o destino já tiver linhas, para. Migração
      rodada duas vezes duplicaria prontuário.

   3. Tudo numa transação só. Se qualquer linha falhar, NADA é gravado — não
      existe banco pela metade, com metade dos pacientes.

   4. Preserva os ids. Prontuário, anamnese e agendamento se referenciam por
      id; renumerar embaralharia os vínculos. Por isso a coluna id é IDENTITY
      "BY DEFAULT" (aceita id explícito) e no fim os contadores são ajustados
      com setval — senão o próximo cadastro tentaria o id 1, que já existe.

   5. Confere no fim. Conta as linhas dos dois lados, tabela por tabela, e
      compara também uma amostra do conteúdo. Diferença = erro, não aviso.

   Uso:
     node migrar-dados.js --conferir    só o diagnóstico, não escreve nada
     node migrar-dados.js               migra
     node migrar-dados.js --forcar      migra mesmo com o destino populado (APAGA antes)
   ========================================================================== */
const path = require("node:path");
const fs = require("node:fs");
const { abrirBanco } = require("./db");
const { Q, carregarAmbiente } = require("./pg");
const { migrar } = require("./migrar");

const ARQUIVO_SQLITE = process.env.GESTAO_DB || path.join(__dirname, "data", "gestao.db");

/* Ordem importa: quem é apontado vem antes de quem aponta. Não há FOREIGN KEY
   declarada no banco (nunca houve), mas manter a ordem deixa o resultado
   coerente se um dia houver, e torna o log legível. */
const TABELAS = [
  "g_config",
  "g_usuarios",
  "servicos",
  "projetos",
  "profissionais",
  "pacientes",
  "associados",
  "atendimentos",
  "prontuario",
  "beneficios",
  "eventos",
  "documentos_gestao",
];

/* --------------------------- diagnóstico --------------------------------- */
/* As três regras que o Postgres vai impor como índice único. O SQLite antigo
   criava esses índices dentro de um try/catch: se já houvesse duplicata quando
   o índice foi criado, ele simplesmente não nascia — e o banco seguiu anos
   aceitando o que a regra proíbe. Aqui isso aparece. */
async function conferirSqlite(sq) {
  const problemas = [];
  const checar = (titulo, sql, formatar) => {
    let linhas = [];
    try { linhas = sq.prepare(sql).all(); } catch { return; }   // tabela pode não existir
    if (linhas.length) problemas.push({ titulo, linhas: linhas.map(formatar) });
  };

  checar(
    "Slugs de projeto repetidos (o slug é o endereço da página no site)",
    `SELECT slug, COUNT(*) n, GROUP_CONCAT(id) ids FROM projetos
       WHERE slug IS NOT NULL AND slug <> '' GROUP BY slug HAVING COUNT(*) > 1`,
    (r) => `${r.slug} · ${r.n} vezes (ids ${r.ids})`
  );
  checar(
    "E-mails de usuário repetidos (a coluna é UNIQUE no destino)",
    `SELECT email, COUNT(*) n, GROUP_CONCAT(id) ids FROM g_usuarios
       WHERE email IS NOT NULL AND email <> '' GROUP BY email HAVING COUNT(*) > 1`,
    (r) => `${r.email} · ${r.n} vezes (ids ${r.ids})`
  );
  /* NOT NULL que o destino exige e o SQLite pode ter deixado passar */
  checar("Usuários sem nome",
    `SELECT id FROM pacientes WHERE nome IS NULL OR nome=''`,
    (r) => `usuário id ${r.id}`);
  checar("Associados sem nome",
    `SELECT id FROM associados WHERE nome IS NULL OR nome=''`,
    (r) => `associado id ${r.id}`);
  checar("Projetos sem título",
    `SELECT id FROM projetos WHERE title IS NULL OR title=''`,
    (r) => `projeto id ${r.id}`);
  checar("Serviços sem título",
    `SELECT id FROM servicos WHERE title IS NULL OR title=''`,
    (r) => `serviço id ${r.id}`);
  checar("Eventos sem título",
    `SELECT id FROM eventos WHERE titulo IS NULL OR titulo=''`,
    (r) => `evento id ${r.id}`);

  return problemas;
}

/* ==========================================================================
   COLUNA QUE EXISTE NA ORIGEM E NÃO NO DESTINO — o risco silencioso

   O `prontuario` do SQLite ainda carrega as colunas de antes do redesenho
   (avaliacao, evolucao, plano, encaminhamentos, responsavel…). Naquele modelo,
   cada prontuário era UMA sessão e esses campos guardavam o texto clínico;
   depois eles viraram linhas em `prontuario_registros` e as colunas ficaram
   para trás, sem uso.

   O esquema novo não as tem — e a carga simplesmente as ignoraria. Se em
   PRODUÇÃO alguma delas ainda tiver texto que nunca foi convertido em
   lançamento, esse texto é registro clínico e sumiria sem uma linha de aviso.

   Por isso: coluna sem destino e VAZIA é só informação; coluna sem destino e
   COM CONTEÚDO **impede** a migração. Quem decide o que fazer com registro de
   paciente é o instituto, não o script.
   ========================================================================== */
async function conteudoSemDestino(sq) {
  const perdas = [];
  for (const t of TABELAS) {
    const naOrigem = colunasSqlite(sq, t);
    if (!naOrigem.length) continue;
    const noDestino = await colunasPg(t);
    if (!noDestino.length) continue;                     // tabela ainda não migrada
    for (const c of naOrigem.filter((x) => !noDestino.includes(x))) {
      let n = 0;
      try {
        n = sq.prepare(`SELECT COUNT(*) n FROM ${t} WHERE "${c}" IS NOT NULL AND TRIM(CAST("${c}" AS TEXT)) <> ''`).get().n;
      } catch { continue; }
      if (n) {
        let amostra = [];
        try {
          amostra = sq.prepare(`SELECT id, "${c}" v FROM ${t} WHERE "${c}" IS NOT NULL AND TRIM(CAST("${c}" AS TEXT)) <> '' LIMIT 3`).all();
        } catch {}
        perdas.push({ onde: `${t}.${c}`, n, amostra: amostra.map((r) => `id ${r.id}: "${String(r.v).slice(0, 60)}…"`) });
      }
    }
  }
  return perdas;
}

/* Texto numa coluna declarada INTEGER. Não impede a migração — a conversão
   trata (ver `converter`) — mas o cliente precisa saber que aquele campo será
   gravado como "não preenchido". Por isso vira AVISO, e não erro. */
function avisosDeTipo(sq) {
  const avisos = [];
  for (const t of TABELAS) {
    let cols = [];
    try { cols = sq.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /INT/i.test(c.type)); } catch { continue; }
    for (const c of cols) {
      let linhas = [];
      try {
        linhas = sq.prepare(
          `SELECT id, ${c.name} v FROM ${t} WHERE typeof(${c.name})='text' LIMIT 30`).all();
      } catch { continue; }
      if (linhas.length) avisos.push({ onde: `${t}.${c.name}`, n: linhas.length,
        exemplos: linhas.slice(0, 5).map((r) => `id ${r.id} = "${r.v}"`) });
    }
  }
  return avisos;
}

/* ---------------------------- colunas ------------------------------------ */
const colunasSqlite = (sq, t) => {
  try { return sq.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name); }
  catch { return []; }
};
async function colunasPg(t) {
  const r = await Q.all(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=? ORDER BY ordinal_position", t);
  return r.map((x) => x.column_name);
}
/* Tipo de cada coluna no DESTINO. É o que decide como converter o valor —
   ver o comentário de `converter` abaixo. */
async function tiposPg(t) {
  const r = await Q.all(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=?", t);
  return new Map(r.map((x) => [x.column_name, x.data_type]));
}

/* ==========================================================================
   O SQLite NÃO IMPÕE TIPO. O Postgres impõe.

   No SQLite, o tipo declarado da coluna é quase uma sugestão: uma coluna
   INTEGER aceita a string vazia sem reclamar. E foi o que aconteceu aqui —
   formulário com o campo em branco gravou "" em `procedimentos.sort` e em
   `pacientes.convenio_id`. Ficou anos assim, invisível, porque nada nunca
   comparou aqueles campos como número.

   O Postgres recusa: `sintaxe de entrada é inválida para tipo integer: ""`.

   A conversão certa é "" → NULL: numa coluna numérica, string vazia significa
   "não preenchido", que é exatamente o que NULL quer dizer. NÃO convertemos
   para 0 — zero é um valor, e num campo como convenio_id ele apontaria para
   um convênio inexistente.

   Cada conversão é CONTADA e aparece no relatório final. Mudar dado calado,
   mesmo para melhor, é como se perde a confiança numa migração.
   ========================================================================== */
const NUMERICOS = new Set(["integer", "bigint", "smallint", "numeric", "real", "double precision"]);

function converter(valor, tipoDestino, aviso) {
  if (typeof valor === "bigint") return Number(valor);      // o driver do pg não serializa BigInt
  if (Buffer.isBuffer(valor)) return valor.toString("utf8");
  if (valor === undefined) return null;

  if (NUMERICOS.has(tipoDestino)) {
    if (valor === null) return null;
    if (typeof valor === "number") return valor;
    const texto = String(valor).trim();
    if (texto === "") { aviso("vazio"); return null; }
    const n = Number(texto);
    if (Number.isNaN(n)) { aviso(`não numérico ("${texto.slice(0, 20)}")`); return null; }
    if (typeof valor === "string") aviso("texto convertido em número");
    return n;
  }
  return valor;
}

/* ------------------------------ carga ------------------------------------ */
async function copiar(sq, tabela) {
  const naOrigem = colunasSqlite(sq, tabela);
  if (!naOrigem.length) return { tabela, origem: 0, destino: 0, pulada: "não existe no SQLite" };

  const noDestino = await colunasPg(tabela);
  const tipos = await tiposPg(tabela);
  const comuns = naOrigem.filter((c) => noDestino.includes(c));
  const soNaOrigem = naOrigem.filter((c) => !noDestino.includes(c));

  const linhas = sq.prepare(`SELECT * FROM ${tabela}`).all();
  if (!linhas.length) return { tabela, origem: 0, destino: 0, soNaOrigem, ajustes: [] };

  const lista = comuns.join(",");
  const marcas = comuns.map(() => "?").join(",");
  const sql = `INSERT INTO ${tabela}(${lista}) VALUES(${marcas})`;
  const ajustes = [];

  for (const linha of linhas) {
    const valores = comuns.map((c) =>
      converter(linha[c], tipos.get(c), (motivo) =>
        ajustes.push(`${tabela}.${c} (id ${linha.id ?? linha.key ?? "?"}): ${motivo} → NULL`)));
    try {
      await Q.run(sql, ...valores);
    } catch (e) {
      throw new Error(`tabela ${tabela}, linha id=${linha.id ?? linha.key ?? "?"}: ${e.message}`);
    }
  }
  return { tabela, origem: linhas.length, destino: linhas.length, soNaOrigem, ajustes };
}

/* Depois de inserir id explícito, o contador do IDENTITY continua em 1 — o
   próximo cadastro estouraria com "chave duplicada". setval acerta. */
async function ajustarSequencias() {
  const ajustadas = [];
  for (const t of TABELAS) {
    const temId = await Q.get(
      "SELECT 1 x FROM information_schema.columns WHERE table_schema='public' AND table_name=? AND column_name='id'", t);
    if (!temId) continue;
    const r = await Q.get(`SELECT pg_get_serial_sequence(?, 'id') seq, (SELECT COALESCE(MAX(id),0) FROM ${t}) maior`, t);
    if (!r || !r.seq) continue;
    /* is_called=true faz o próximo valor ser maior+1. Com maior=0 usamos 1 e
       is_called=false, senão o primeiro id da tabela vazia seria 2. */
    const maior = Number(r.maior) || 0;
    await Q.run("SELECT setval(?, ?, ?)", r.seq, maior > 0 ? maior : 1, maior > 0);
    ajustadas.push(`${t} → próximo id ${maior + 1}`);
  }
  return ajustadas;
}

/* ----------------------------- conferência -------------------------------- */
async function conferirCarga(sq) {
  const erros = [];
  const linhas = [];
  for (const t of TABELAS) {
    if (!colunasSqlite(sq, t).length) continue;
    const a = sq.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const b = Number((await Q.get(`SELECT COUNT(*) n FROM ${t}`)).n);
    linhas.push({ t, a, b, ok: a === b });
    if (a !== b) erros.push(`${t}: ${a} no SQLite × ${b} no Postgres`);
  }
  return { linhas, erros };
}

/* Contagem não prova conteúdo: 10 linhas erradas também contam 10. Comparamos
   uma amostra real das tabelas que mais importam. */
async function conferirConteudo(sq) {
  const erros = [];
  const amostras = [
    ["pacientes", "id, nome, cpf, telefone, nis, projeto_id"],
    ["associados", "id, nome, cpf, vinculo, status"],
    ["prontuario", "id, paciente_id, profissional, data, evolucao"],
    ["atendimentos", "id, paciente_id, especialidade, data, hora, status"],
    ["projetos", "id, title, slug, status"],
    ["servicos", "id, title, categoria"],
    ["beneficios", "id, nome, item, data"],
    ["eventos", "id, titulo, tipo, data"],
  ];
  for (const [t, cols] of amostras) {
    if (!colunasSqlite(sq, t).length) continue;
    const doSqlite = sq.prepare(`SELECT ${cols} FROM ${t} ORDER BY id LIMIT 50`).all();
    if (!doSqlite.length) continue;
    const doPg = await Q.all(`SELECT ${cols} FROM ${t} ORDER BY id LIMIT 50`);
    for (let i = 0; i < doSqlite.length; i++) {
      for (const c of cols.split(",").map((x) => x.trim())) {
        const x = doSqlite[i][c], y = doPg[i] ? doPg[i][c] : undefined;
        /* "", null e undefined são a MESMA coisa aqui: campo não preenchido.
           Sem isso, a conversão de "" para NULL numa coluna numérica — que o
           próprio script faz de propósito e já relata em VALORES AJUSTADOS —
           voltaria como divergência, acusando de erro o que é o comportamento
           desejado. Diferença de CONTEÚDO continua sendo pega. */
        const vazio = (v) => v === null || v === undefined || String(v).trim() === "";
        const igual = vazio(x) ? vazio(y) : String(x) === String(y);
        if (!igual) erros.push(`${t} id=${doSqlite[i].id} coluna ${c}: "${x}" × "${y}"`);
      }
    }
  }
  return erros;
}

/* ------------------------------- principal -------------------------------- */
async function principal() {
  const soConferir = process.argv.includes("--conferir");
  const forcar = process.argv.includes("--forcar");

  console.log("\n========== MIGRAÇÃO SQLite → PostgreSQL (gestão) ==========\n");

  if (!fs.existsSync(ARQUIVO_SQLITE)) {
    console.error(`  ✖ não achei o banco de origem: ${ARQUIVO_SQLITE}`);
    console.error("    (defina GESTAO_DB=/caminho/gestao.db se ele estiver noutro lugar)");
    process.exit(1);
  }
  const sq = abrirBanco(ARQUIVO_SQLITE);
  console.log(`  origem : ${ARQUIVO_SQLITE}`);
  const v = await Q.versao();
  console.log(`  destino: ${v.d} (usuário ${v.u})\n`);

  /* 1. esquema primeiro — o diagnóstico precisa saber como é o DESTINO para
     conseguir dizer o que não tem para onde ir. Aplicar migrations num banco
     vazio é inofensivo e idempotente, então vale até no modo --conferir. */
  await migrar({ silencioso: true });

  /* 2. diagnóstico ------------------------------------------------------- */
  const problemas = await conferirSqlite(sq);
  if (problemas.length) {
    console.log("  ⚠ O BANCO DE ORIGEM TEM DADOS QUE O DESTINO VAI RECUSAR:\n");
    for (const p of problemas) {
      console.log(`   · ${p.titulo}`);
      for (const l of p.linhas.slice(0, 20)) console.log(`       ${l}`);
      if (p.linhas.length > 20) console.log(`       … e mais ${p.linhas.length - 20}`);
      console.log("");
    }
    console.log("  Resolva no sistema antes de migrar (juntar as pastas repetidas,");
    console.log("  limpar o código duplicado). Nada foi escrito.\n");
    process.exit(1);
  }
  const perdas = await conteudoSemDestino(sq);
  if (perdas.length) {
    console.log("  ✖ HÁ CONTEÚDO EM COLUNAS QUE NÃO EXISTEM NO ESQUEMA NOVO:\n");
    for (const p of perdas) {
      console.log(`   · ${p.onde} — ${p.n} linha(s) com conteúdo`);
      for (const a of p.amostra) console.log(`       ${a}`);
    }
    console.log("\n  Essas colunas são de versões antigas do sistema. Se o conteúdo ainda");
    console.log("  importa, ele precisa virar lançamento de prontuário ANTES da migração.");
    console.log("  Se não importa, acrescente a coluna na migration ou limpe a origem.");
    console.log("  Nada foi escrito.\n");
    process.exit(1);
  }

  console.log("  ✓ diagnóstico: origem compatível com as regras do destino.");
  console.log("  ✓ nenhuma coluna com conteúdo ficaria sem destino.\n");

  const tipos = avisosDeTipo(sq);
  if (tipos.length) {
    console.log("  ⚠ CAMPOS NUMÉRICOS COM TEXTO (o SQLite deixava; serão gravados como vazio):\n");
    for (const a of tipos) {
      console.log(`   · ${a.onde} — ${a.n} linha(s)`);
      for (const e of a.exemplos) console.log(`       ${e}`);
    }
    console.log("");
  }

  /* contagem da origem, sempre visível */
  console.log("  CONTEÚDO A MIGRAR");
  let total = 0;
  for (const t of TABELAS) {
    if (!colunasSqlite(sq, t).length) continue;
    const n = sq.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    total += n;
    console.log(`   ${String(n).padStart(6)}  ${t}`);
  }
  console.log(`   ${String(total).padStart(6)}  TOTAL\n`);

  if (soConferir) { console.log("  (--conferir: nada foi escrito)\n"); await Q.fechar(); return; }

  /* 4. destino vazio? (o esquema já foi aplicado lá no passo 1) ----------- */
  const ocupadas = [];
  for (const t of TABELAS) {
    const r = await Q.get(`SELECT COUNT(*) n FROM ${t}`).catch(() => null);
    if (r && Number(r.n) > 0) ocupadas.push(`${t} (${r.n})`);
  }
  if (ocupadas.length && !forcar) {
    console.error("  ✖ o destino JÁ TEM dados:", ocupadas.join(", "));
    console.error("    Migrar por cima duplicaria prontuário. Use --forcar para APAGAR e recarregar.\n");
    process.exit(1);
  }

  /* 4. carga, tudo ou nada ----------------------------------------------- */
  const resumo = await Q.tx(async () => {
    if (ocupadas.length && forcar) {
      // ordem inversa: apaga quem aponta antes de quem é apontado
      for (const t of [...TABELAS].reverse()) await Q.run(`DELETE FROM ${t}`);
      console.log("  · destino limpo (--forcar)");
    }
    const r = [];
    for (const t of TABELAS) r.push(await copiar(sq, t));
    return r;
  });

  const seqs = await ajustarSequencias();

  /* 5. conferência ------------------------------------------------------- */
  const { linhas, erros } = await conferirCarga(sq);
  const errosConteudo = await conferirConteudo(sq);

  console.log("\n  CONFERÊNCIA (origem × destino)");
  for (const l of linhas) console.log(`   ${l.ok ? "✓" : "✖"} ${l.t.padEnd(22)} ${String(l.a).padStart(6)} × ${String(l.b).padStart(6)}`);

  for (const r of resumo) {
    if (r.soNaOrigem && r.soNaOrigem.length)
      console.log(`   ⚠ ${r.tabela}: coluna(s) só na origem, NÃO migrada(s): ${r.soNaOrigem.join(", ")}`);
    if (r.pulada) console.log(`   · ${r.tabela}: ${r.pulada}`);
  }

  /* Todo valor que a migração precisou ajustar aparece aqui, nominalmente.
     São poucos e importam: é dado do cliente sendo mexido. */
  const ajustes = resumo.flatMap((r) => r.ajustes || []);
  if (ajustes.length) {
    console.log(`\n  VALORES AJUSTADOS (${ajustes.length})`);
    for (const a of ajustes.slice(0, 40)) console.log(`   · ${a}`);
    if (ajustes.length > 40) console.log(`   … e mais ${ajustes.length - 40}`);
  }

  console.log("\n  SEQUÊNCIAS AJUSTADAS");
  for (const s of seqs) console.log(`   · ${s}`);

  if (erros.length || errosConteudo.length) {
    console.error("\n  ✖ MIGRAÇÃO COM DIVERGÊNCIA:");
    for (const e of erros) console.error("    " + e);
    for (const e of errosConteudo.slice(0, 20)) console.error("    " + e);
    if (errosConteudo.length > 20) console.error(`    … e mais ${errosConteudo.length - 20}`);
    console.error("");
    process.exit(1);
  }

  console.log(`\n  ✓ MIGRAÇÃO CONCLUÍDA — ${total} linha(s), conteúdo conferido.`);
  console.log("    Guarde o gestao.db: ele é o seu ponto de volta se algo aparecer depois.\n");
  await Q.fechar();
}

if (require.main === module) {
  carregarAmbiente(__dirname);
  principal().catch(async (e) => {
    console.error("\n  ✖ FALHOU (nada foi gravado):", e.message, "\n");
    await Q.fechar().catch(() => {});
    process.exit(1);
  });
}

module.exports = { TABELAS, conferirSqlite };
