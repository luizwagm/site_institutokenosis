/* ==========================================================================
   testar-frequencia.js — o título e o local da folha de frequência

   O que esta suíte guarda:

   1. O TÍTULO deixou de ser texto fixo no JavaScript e virou campo da folha —
      porque é ele que sai no cabeçalho da folha IMPRESSA, o documento que
      circula assinado fora do sistema. Uma folha antiga (título vazio) tem de
      continuar imprimindo o texto padrão da hidroginástica: se isso se perder,
      centenas de folhas passam a sair sem cabeçalho e ninguém percebe até a
      próxima prestação de contas.

   2. O LOCAL é o que permite duas folhas da MESMA turma, no MESMO mês, em
      lugares diferentes — e é o que distingue as duas na lista. Sem ele, a
      equipe via duas linhas idênticas e escolhia qual abrir no palpite.

   3. Os dois têm TETO no servidor, no POST e no PUT. Um limite que só existe
      na criação é um limite que se contorna editando.

   ATENÇÃO AO BANCO. O /restrito é PostgreSQL, e não há banco descartável para
   ele: a suíte roda contra o banco configurado. Por isso ela só cria registros
   PRÓPRIOS, marcados "ZZ QA", e os apaga PELO ID no `finally` — nunca por
   LIKE, nunca por turma, nunca escrevendo sobre registro do Instituto. Se ela
   for interrompida no meio, o que sobra são folhas com "ZZ QA" no título, e
   o id delas sai impresso na tela.

     node testar-frequencia.js
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PORTA = Number(process.env.PORTA_TESTE_FREQ) || 5298;
const BANCO = path.join(os.tmpdir(), `kenosis-frequencia-${process.pid}.db`);
const MARCA = `ZZ QA freq ${process.pid}`;

const { Q, carregarAmbiente } = require("./pg.js");
carregarAmbiente();

/* O mesmo scrypt do restrito.js. Copiado, e não importado, porque o módulo não
   exporta a função — e exportá-la só para o teste alargaria a superfície de
   quem pode gerar hash de senha. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

let passou = 0, falhou = 0;
function ok(nome, real, esperado) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) { passou++; console.log(`    ✓ ${nome}`); return; }
  falhou++;
  console.log(`    ✖ ${nome}\n        esperado: ${JSON.stringify(esperado)}\n        obtido:   ${JSON.stringify(real)}`);
}
function verdade(nome, cond) { ok(nome, !!cond, true); }

function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = require("node:net").createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(porta, "127.0.0.1");
  });
}

let COOKIE = "";
function pedir(caminho, metodo = "GET", corpo = null) {
  return new Promise((resolve, reject) => {
    const dados = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
    const req = http.request({
      host: "127.0.0.1", port: PORTA, path: caminho, method: metodo,
      headers: Object.assign(
        { accept: "application/json" },
        COOKIE ? { cookie: COOKIE } : {},
        dados ? { "content-type": "application/json", "content-length": dados.length } : {}),
    }, (r) => {
      let txt = "";
      r.setEncoding("utf8");
      r.on("data", (d) => { txt += d; });
      r.on("end", () => {
        const sc = r.headers["set-cookie"];
        if (sc) COOKIE = sc.map((c) => c.split(";")[0]).join("; ");
        let json = null;
        try { json = JSON.parse(txt); } catch { /* HTML, tudo bem */ }
        resolve({ status: r.statusCode, json, texto: txt });
      });
    });
    req.on("error", reject);
    if (dados) req.write(dados);
    req.end();
  });
}

(async () => {
  console.log("\n  ══ FREQUÊNCIA: título e local — Instituto Kenósis ══\n");

  if (!(await portaLivre(PORTA))) {
    console.error(`  ✖ a porta ${PORTA} já está ocupada por outro processo.`);
    console.error("    Feche o que está usando, ou rode com PORTA_TESTE_FREQ=<outra>.\n");
    process.exit(1);
  }

  /* A conta de ensaio nasce aqui e morre no finally. Nome e e-mail marcados,
     para que uma interrupção deixe rastro legível em vez de mistério. */
  const email = `zz_qa_freq_${process.pid}`;
  const senha = crypto.randomBytes(12).toString("hex");
  let contaId = 0;
  const folhas = [];

  const filho = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
      PORT: String(PORTA), SITE_DB: BANCO, CHAT_URL: "", CHAT_SEGREDO_PASSE: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  filho.stdout.on("data", (d) => { saida += d; });
  filho.stderr.on("data", (d) => { saida += d; });

  let vivo = false;
  for (let i = 0; i < 60; i++) {
    try { await pedir("/"); vivo = true; break; }
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
       0. o esquema
       ==================================================================== */
    console.log("  0. a migration chegou ao banco");
    const cols = (await Q.all(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='frequencias'`)).map((c) => c.column_name);
    verdade("a coluna `titulo` existe", cols.includes("titulo"));
    verdade("a coluna `local` existe", cols.includes("local"));

    contaId = await Q.inserir(
      "INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)",
      MARCA, email, hashSenha(senha), "admin", new Date().toISOString());

    const entrada = await pedir("/restrito/api/login", "POST", { usuario: email, senha });
    ok("a conta de ensaio entra no sistema", entrada.status, 200);

    /* ====================================================================
       1. criar com título e local
       ==================================================================== */
    console.log("\n  1. a folha nasce com título e local próprios");
    const base = { turma: "08h às 09h", mes: "2099-01", datas: "[\"03\",\"05\"]", participantes: "[]" };
    const a = await pedir("/restrito/api/frequencias", "POST",
      Object.assign({}, base, { titulo: `${MARCA} — Oficina de Musculação`, local: "ZZ QA Sede" }));
    ok("gravou", a.status, 200);
    if (a.json && a.json.id) folhas.push(a.json.id);

    let lista = (await pedir("/restrito/api/frequencias")).json || [];
    const f1 = lista.find((f) => f.id === folhas[0]);
    ok("o título voltou inteiro", f1 && f1.titulo, `${MARCA} — Oficina de Musculação`);
    ok("o local voltou inteiro", f1 && f1.local, "ZZ QA Sede");

    /* ====================================================================
       2. duas folhas iguais em lugares diferentes
       ==================================================================== */
    console.log("\n  2. mesma turma, mesmo mês, LUGARES diferentes");
    const b = await pedir("/restrito/api/frequencias", "POST",
      Object.assign({}, base, { titulo: `${MARCA} — Oficina de Musculação`, local: "ZZ QA Anexo" }));
    ok("a segunda folha também grava", b.status, 200);
    if (b.json && b.json.id) folhas.push(b.json.id);
    verdade("são duas folhas distintas", folhas.length === 2 && folhas[0] !== folhas[1]);
    lista = (await pedir("/restrito/api/frequencias")).json || [];
    const irmas = lista.filter((f) => folhas.includes(f.id));
    ok("e o que as separa é o local", irmas.map((f) => f.local).sort(), ["ZZ QA Anexo", "ZZ QA Sede"]);

    /* ====================================================================
       3. dá para corrigir depois
       ==================================================================== */
    console.log("\n  3. o título e o local mudam depois de salvos");
    await pedir(`/restrito/api/frequencias/${folhas[0]}`, "PUT",
      Object.assign({}, base, { titulo: `${MARCA} — TÍTULO NOVO`, local: "ZZ QA Sede II" }));
    lista = (await pedir("/restrito/api/frequencias")).json || [];
    const dep = lista.find((f) => f.id === folhas[0]);
    ok("o título mudou", dep && dep.titulo, `${MARCA} — TÍTULO NOVO`);
    ok("o local mudou", dep && dep.local, "ZZ QA Sede II");

    /* ====================================================================
       4. a folha ANTIGA continua válida
       ==================================================================== */
    console.log("\n  4. folha sem título — como são todas as que já existem");
    const c = await pedir("/restrito/api/frequencias", "POST",
      Object.assign({}, base, { local: "ZZ QA Sem Titulo" }));
    ok("grava sem reclamar", c.status, 200);
    if (c.json && c.json.id) folhas.push(c.json.id);
    lista = (await pedir("/restrito/api/frequencias")).json || [];
    const velha = lista.find((f) => f.id === folhas[2]);
    /* Vazio, e não nulo: é o vazio que a tela lê para cair no texto padrão da
       hidroginástica. `null` quebraria o `String(f.titulo||"").trim()` em
       nada — mas quebraria a coluna NOT NULL, e o INSERT falharia inteiro. */
    ok("e o título fica vazio, não nulo", velha && velha.titulo, "");

    /* ====================================================================
       5. o teto, nos DOIS caminhos
       ==================================================================== */
    console.log("\n  5. texto gigante é cortado — na criação e na edição");
    const d = await pedir("/restrito/api/frequencias", "POST",
      Object.assign({}, base, { titulo: "T".repeat(500), local: "L".repeat(500) }));
    if (d.json && d.json.id) folhas.push(d.json.id);
    lista = (await pedir("/restrito/api/frequencias")).json || [];
    const cortada = lista.find((f) => f.id === folhas[3]);
    ok("título cortado em 200 no POST", cortada && cortada.titulo.length, 200);
    ok("local cortado em 120 no POST", cortada && cortada.local.length, 120);

    await pedir(`/restrito/api/frequencias/${folhas[3]}`, "PUT",
      Object.assign({}, base, { titulo: "X".repeat(500), local: "Y".repeat(500) }));
    lista = (await pedir("/restrito/api/frequencias")).json || [];
    const cortada2 = lista.find((f) => f.id === folhas[3]);
    ok("título cortado em 200 no PUT também", cortada2 && cortada2.titulo.length, 200);
    ok("local cortado em 120 no PUT também", cortada2 && cortada2.local.length, 120);

    /* ====================================================================
       6. o espaço em branco não vira título
       ==================================================================== */
    console.log("\n  6. só espaços é o mesmo que nada");
    /* Nos DOIS caminhos. Um `trim` que so existe na edicao deixa passar a
       folha nascida com o campo cheio de espaco — e ela imprime um cabecalho
       em branco, que e pior do que imprimir o padrao. */
    const e6 = await pedir("/restrito/api/frequencias", "POST",
      Object.assign({}, base, { titulo: "   ", local: "  	  " }));
    if (e6.json && e6.json.id) folhas.push(e6.json.id);
    lista = (await pedir("/restrito/api/frequencias")).json || [];
    const nascida = lista.find((f) => f.id === folhas[4]);
    ok("nasce vazia quando so vieram espacos", nascida && [nascida.titulo, nascida.local], ["", ""]);

    await pedir(`/restrito/api/frequencias/${folhas[2]}`, "PUT",
      Object.assign({}, base, { titulo: "     ", local: "   " }));
    lista = (await pedir("/restrito/api/frequencias")).json || [];
    const limpa = lista.find((f) => f.id === folhas[2]);
    ok("o título fica vazio", limpa && limpa.titulo, "");
    ok("o local fica vazio", limpa && limpa.local, "");

    /* ====================================================================
       7. A JANELA ENTRE ABRIR A PORTA E A GESTAO FICAR PRONTA

       O servidor chama `listen` de imediato — de proposito: o site do
       instituto nao pode ficar refem do PostgreSQL. Mas a gestao inicializa
       EM PARALELO, e nesse intervalo nada falhou e nada esta pronto. A guarda
       antiga so olhava `ERRO_GESTAO`, entao o pedido passava e estourava la
       dentro: "Erro interno", 500, sem explicacao — exatamente o que quem
       estava salvando um prontuario via no instante do deploy.

       A prova prende a janela aberta: um servidor apontado para uma porta de
       banco morta fica tentando subir a gestao. Nesse estado, o POST tem de
       receber 503 com recado — e nao 500.
       ==================================================================== */
    console.log("\n  7. com a gestao ainda subindo, o recado e 503 (nunca 500)");
    const PORTA2 = PORTA + 1;
    const filho2 = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: Object.assign({}, process.env, {
        PORT: String(PORTA2), SITE_DB: BANCO + ".2", CHAT_URL: "", CHAT_SEGREDO_PASSE: "",
        /* A porta 1 nao tem banco nenhum, e e isso que segura a subida da
           gestao pelo tempo necessario para a prova acontecer. */
        PGHOST: "127.0.0.1", PGPORT: "1", DATABASE_URL: "",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const pedir2 = (caminho, metodo, corpo) => new Promise((resolve, reject) => {
        const d = corpo == null ? null : Buffer.from(JSON.stringify(corpo));
        const rq = http.request({ host: "127.0.0.1", port: PORTA2, path: caminho, method: metodo,
          headers: d ? { "content-type": "application/json", "content-length": d.length } : {} },
          (r) => { let t = ""; r.setEncoding("utf8"); r.on("data", (x) => { t += x; });
                   r.on("end", () => resolve({ status: r.statusCode, texto: t })); });
        rq.on("error", reject); if (d) rq.write(d); rq.end();
      });
      let deuPe = false;
      for (let i = 0; i < 60; i++) {
        try { await pedir2("/", "GET", null); deuPe = true; break; }
        catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      verdade("o site sobe mesmo com o banco fora", deuPe);
      const r7 = await pedir2("/restrito/api/frequencias", "POST", { turma: "08h as 09h", mes: "2099-01" });
      ok("o /restrito responde 503, e nao 500", r7.status, 503);
      verdade("com recado em vez de \"Erro interno\"", !/Erro interno/.test(r7.texto));
    } finally {
      filho2.kill();
      try { require("node:fs").rmSync(BANCO + ".2", { force: true }); } catch {}
    }
  } catch (e) {
    falhou++;
    console.log(`\n    ✖ a suíte parou: ${e.message}`);
  } finally {
    /* ====================================================================
       A LIMPEZA — pelo ID, nunca por LIKE.

       Uma varredura por "ZZ QA" alcançaria registro de outra rodada, ou de
       outra pessoa, ou (no dia em que alguém chamar uma turma real assim) do
       próprio Instituto. Os ids são os que ESTA execução criou.
       ==================================================================== */
    let sobrou = [];
    for (const id of folhas) {
      try { await Q.run("DELETE FROM frequencias WHERE id=?", id); }
      catch { sobrou.push(id); }
    }
    if (contaId) {
      try { await Q.run("DELETE FROM g_usuarios WHERE id=?", contaId); }
      catch { sobrou.push(`conta ${contaId}`); }
    }
    filho.kill();
    try { require("node:fs").rmSync(BANCO, { force: true }); } catch {}
    if (sobrou.length) console.log(`\n  ⚠ não consegui apagar: ${sobrou.join(", ")} — apague à mão.`);

    console.log(`\n  ${falhou === 0 ? "✓" : "✖"} ${passou} passaram, ${falhou} falharam\n`);
    process.exit(falhou === 0 ? 0 : 1);
  }
})();
