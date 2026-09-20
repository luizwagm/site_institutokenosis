/* ==========================================================================
   testar-ata.js — a ata de reunião: o que o servidor aceita gravar

   A ata é irmã da folha de frequência: o sistema monta, o PAPEL recebe as
   assinaturas. O que esta suíte guarda é o que, se quebrar, só aparece depois
   da reunião — com a folha já impressa e circulando:

   1. A DATA é obrigatória e tem de ser uma data DE VERDADE. "2026-02-31" passa
      em qualquer expressão regular de quatro-dois-dois, e o Date "conserta"
      para 3 de março: a ata sairia impressa com um dia que ninguém marcou.

   2. OS TETOS valem no POST **e** no PUT. Um limite que só existe na criação é
      um limite que se contorna editando — a mesma lição que o título da folha
      de frequência ensinou.

   3. A LISTA DE PRESENTES é reconstruída no servidor. Ela mistura id do
      cadastro com convidado ({"nome":"…"}), e é a única lista do sistema que
      aceita duas formas. Um objeto estranho gravado aí voltaria para a folha
      impressa como "[object Object]" — defeito que só se descobre no papel.

   4. O CONVIDADO guarda NOME e só. CPF de convidado ficaria fora da cifragem
      que protege o cadastro, e a ata viraria um segundo lugar com dado
      sensível — exatamente o que a migration 008 evitou na frequência.

   ATENÇÃO AO BANCO. O /restrito é PostgreSQL e não há banco descartável para
   ele: a suíte roda contra o banco configurado. Por isso ela só cria registros
   PRÓPRIOS, marcados "ZZ QA", e os apaga PELO ID no `finally` — nunca por
   LIKE, nunca por data, nunca escrevendo sobre registro do Instituto. Se for
   interrompida no meio, o id do que sobrou sai impresso na tela.

     node testar-ata.js
   ========================================================================== */
"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

/* 5286: vizinha da suíte da frequência (5288) e longe da 5299 do
   testar-cabecalhos. Duas suítes do mesmo projeto disputando porta só quebram
   quando alguém as roda em paralelo — o pior momento para descobrir. */
const PORTA = Number(process.env.PORTA_TESTE_ATA) || 5286;
const BANCO = path.join(os.tmpdir(), `kenosis-ata-${process.pid}.db`);
const MARCA = `ZZ QA ata ${process.pid}`;

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
  console.log("\n  ══ ATA de reunião — Instituto Kenósis ══\n");

  if (!(await portaLivre(PORTA))) {
    console.error(`  ✖ a porta ${PORTA} já está ocupada por outro processo.`);
    console.error("    Feche o que está usando, ou rode com PORTA_TESTE_ATA=<outra>.\n");
    process.exit(1);
  }

  const email = `zz_qa_ata_${process.pid}`;
  const senha = crypto.randomBytes(12).toString("hex");
  let contaId = 0;
  const atas = [];

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
    console.log("  0. a migration 012 chegou ao banco");
    const cols = (await Q.all(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='atas'`)).map((c) => c.column_name);
    for (const c of ["titulo", "data", "hora", "local", "participantes"]) {
      verdade(`a coluna \`${c}\` existe`, cols.includes(c));
    }

    contaId = await Q.inserir(
      "INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)",
      MARCA, email, hashSenha(senha), "admin", new Date().toISOString());

    const entrada = await pedir("/restrito/api/login", "POST", { usuario: email, senha });
    ok("a conta de ensaio entra no sistema", entrada.status, 200);

    /* ====================================================================
       1. a ata nasce
       ==================================================================== */
    console.log("\n  1. a ata nasce com título, data, hora e local");
    const a = await pedir("/restrito/api/atas", "POST", {
      titulo: `${MARCA} — Reunião de diretoria`, data: "2099-03-10", hora: "14:30",
      local: "ZZ QA Sede", participantes: "[]",
    });
    ok("gravou", a.status, 200);
    if (a.json && a.json.id) atas.push(a.json.id);

    let lista = (await pedir("/restrito/api/atas")).json || [];
    const a1 = lista.find((x) => x.id === atas[0]);
    ok("o título voltou inteiro", a1 && a1.titulo, `${MARCA} — Reunião de diretoria`);
    ok("a data voltou inteira", a1 && a1.data, "2099-03-10");
    ok("a hora voltou inteira", a1 && a1.hora, "14:30");
    ok("o local voltou inteiro", a1 && a1.local, "ZZ QA Sede");

    /* ====================================================================
       2. a data: obrigatória e real
       ==================================================================== */
    console.log("\n  2. a data é obrigatória, e tem de existir no calendário");
    const semData = await pedir("/restrito/api/atas", "POST", { titulo: MARCA, participantes: "[]" });
    ok("sem data não grava", semData.status, 400);
    if (semData.json && semData.json.id) atas.push(semData.json.id);   // não deveria, mas limpa se gravar

    /* 31 de fevereiro passa na regex e o Date rola para 3 de março: a ata
       sairia impressa com um dia que ninguém marcou. */
    const fev31 = await pedir("/restrito/api/atas", "POST",
      { titulo: MARCA, data: "2099-02-31", participantes: "[]" });
    ok("31 de fevereiro é recusado", fev31.status, 400);
    if (fev31.json && fev31.json.id) atas.push(fev31.json.id);

    const horaRuim = await pedir("/restrito/api/atas", "POST",
      { titulo: MARCA, data: "2099-03-10", hora: "25:00", participantes: "[]" });
    ok("hora impossível é recusada", horaRuim.status, 400);
    if (horaRuim.json && horaRuim.json.id) atas.push(horaRuim.json.id);

    const semHora = await pedir("/restrito/api/atas", "POST",
      { titulo: MARCA, data: "2099-03-11", hora: "", participantes: "[]" });
    ok("mas a hora em branco é aceita (nem toda reunião tem horário)", semHora.status, 200);
    if (semHora.json && semHora.json.id) atas.push(semHora.json.id);

    /* ====================================================================
       3. os tetos — no POST e no PUT
       ==================================================================== */
    console.log("\n  3. título e local têm teto nos DOIS caminhos");
    const longo = `${MARCA} ` + "x".repeat(400);
    const gordo = await pedir("/restrito/api/atas", "POST",
      { titulo: longo, data: "2099-03-12", local: "L".repeat(300), participantes: "[]" });
    ok("grava", gordo.status, 200);
    if (gordo.json && gordo.json.id) atas.push(gordo.json.id);
    lista = (await pedir("/restrito/api/atas")).json || [];
    const g = lista.find((x) => x.id === gordo.json.id) || {};
    ok("o título foi aparado em 200", (g.titulo || "").length, 200);
    ok("o local foi aparado em 120", (g.local || "").length, 120);

    await pedir(`/restrito/api/atas/${atas[0]}`, "PUT", { titulo: longo, local: "P".repeat(300) });
    lista = (await pedir("/restrito/api/atas")).json || [];
    const dep = lista.find((x) => x.id === atas[0]) || {};
    ok("editando, o título também é aparado", (dep.titulo || "").length, 200);
    ok("editando, o local também é aparado", (dep.local || "").length, 120);

    const putFev31 = await pedir(`/restrito/api/atas/${atas[0]}`, "PUT", { data: "2099-02-31" });
    ok("editando, a data impossível é recusada", putFev31.status, 400);
    lista = (await pedir("/restrito/api/atas")).json || [];
    ok("…e a data boa continua no lugar", (lista.find((x) => x.id === atas[0]) || {}).data, "2099-03-10");

    /* ====================================================================
       4. a lista de presentes — a única lista com duas formas
       ==================================================================== */
    console.log("\n  4. presentes: id do cadastro, convidado pelo nome, e nada além disso");
    const suja = JSON.stringify([
      7, "8",                       // ids (número e texto) → viram números
      { nome: "  ZZ QA Convidada  " },  // convidado → nome aparado
      { nome: "" },                 // convidado sem nome → fora
      { cpf: "111" },               // objeto sem nome → fora
      [9],                          // array → fora (Number([9]) é 9!)
      -3, 0, 1.5, "abc",            // ids inválidos → fora
      { nome: "N".repeat(300) },    // nome gigante → aparado em 120
    ]);
    const p = await pedir("/restrito/api/atas", "POST",
      { titulo: MARCA, data: "2099-03-13", participantes: suja });
    ok("grava", p.status, 200);
    if (p.json && p.json.id) atas.push(p.json.id);
    lista = (await pedir("/restrito/api/atas")).json || [];
    const guardado = JSON.parse((lista.find((x) => x.id === p.json.id) || {}).participantes || "[]");
    ok("ficaram só os ids e os convidados com nome",
      guardado, [7, 8, { nome: "ZZ QA Convidada" }, { nome: "N".repeat(120) }]);
    verdade("o array aninhado NÃO virou presença de ninguém",
      !guardado.some((x) => typeof x === "number" && x === 9));
    verdade("nenhum convidado guardou CPF",
      guardado.every((x) => typeof x !== "object" || Object.keys(x).join() === "nome"));

    const cheia = await pedir("/restrito/api/atas", "POST", {
      titulo: MARCA, data: "2099-03-14",
      participantes: JSON.stringify(Array.from({ length: 500 }, (_, i) => i + 1)),
    });
    if (cheia.json && cheia.json.id) atas.push(cheia.json.id);
    lista = (await pedir("/restrito/api/atas")).json || [];
    const t = JSON.parse((lista.find((x) => x.id === cheia.json.id) || {}).participantes || "[]");
    ok("a folha tem teto de presentes (300)", t.length, 300);

    /* ====================================================================
       5. quem pode mexer
       ==================================================================== */
    console.log("\n  5. quem atende MONTA a ata; o profissional não entra");
    /* A SECRETARIA é quem monta a folha — provado no SERVIDOR, e não só no
       menu da tela. Uma prova que olhasse apenas o app.html passaria verde com
       a permissão apagada do restrito.js: o botão apareceria e a área
       responderia 403 na cara de quem clicasse. */
    const emailSec = `zz_qa_ata_sec_${process.pid}`;
    const senhaSec = crypto.randomBytes(12).toString("hex");
    const secId = await Q.inserir(
      "INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)",
      `${MARCA} sec`, emailSec, hashSenha(senhaSec), "secretaria", new Date().toISOString());
    const cookieDoAdmin = COOKIE;
    COOKIE = "";
    ok("a secretaria entra no sistema",
      (await pedir("/restrito/api/login", "POST", { usuario: emailSec, senha: senhaSec })).status, 200);
    ok("a secretaria LÊ as atas", (await pedir("/restrito/api/atas")).status, 200);
    const criadaSec = await pedir("/restrito/api/atas", "POST",
      { titulo: `${MARCA} — pela secretaria`, data: "2099-03-16", participantes: "[]" });
    ok("e CRIA ata", criadaSec.status, 200);
    if (criadaSec.json && criadaSec.json.id) atas.push(criadaSec.json.id);
    COOKIE = cookieDoAdmin;
    await Q.run("DELETE FROM g_usuarios WHERE id=?", secId);

    const emailProf = `zz_qa_ata_prof_${process.pid}`;
    const senhaProf = crypto.randomBytes(12).toString("hex");
    const profId = await Q.inserir(
      "INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)",
      `${MARCA} prof`, emailProf, hashSenha(senhaProf), "profissional", new Date().toISOString());
    const cookieAdmin = COOKIE;
    COOKIE = "";
    const entradaProf = await pedir("/restrito/api/login", "POST", { usuario: emailProf, senha: senhaProf });
    ok("o profissional entra no sistema", entradaProf.status, 200);
    const leitura = await pedir("/restrito/api/atas");
    ok("mas não lê as atas", leitura.status, 403);
    const escrita = await pedir("/restrito/api/atas", "POST", { titulo: MARCA, data: "2099-03-15", participantes: "[]" });
    ok("e não cria ata", escrita.status, 403);
    if (escrita.json && escrita.json.id) atas.push(escrita.json.id);
    COOKIE = cookieAdmin;
    await Q.run("DELETE FROM g_usuarios WHERE id=?", profId);

    /* ====================================================================
       6. sem sessão, nada
       ==================================================================== */
    console.log("\n  6. sem sessão o endereço não responde nada");
    const guarda = COOKIE; COOKIE = "";
    const semLogin = await pedir("/restrito/api/atas");
    ok("a lista exige sessão", semLogin.status, 401);
    COOKIE = guarda;

    /* ====================================================================
       7. a tela: a ata está no menu, na permissão e no roteamento
       ==================================================================== */
    console.log("\n  7. a tela conhece a ata");
    const html = fs.readFileSync(path.join(__dirname, "restrito", "app.html"), "utf8");
    verdade("o botão do menu existe", /data-nav="atas"/.test(html));
    verdade("o painel existe", /id="pane-ata"/.test(html));
    verdade("o menu leva ao painel", /nav==="atas"/.test(html));
    verdade("a paginação da lista sabe repintar", /chave === "ata"/.test(html));
    verdade("a secretaria enxerga a área", /"frequencia","atas"/.test(html));
    /* A coluna de assinatura sai VAZIA: é o que cada presente assina no papel.
       Uma célula preenchida aqui transformaria a folha em outra coisa. */
    verdade("a impressão tem a coluna Assinatura", /Assinatura<\/th>/.test(html));

    /* O JavaScript inteiro da tela tem de compilar. O bloco é um só, e a regex
       precisa ser NÃO-gulosa: com o include do chat no fim há dois `</script>`
       e a gulosa engoliria HTML junto. */
    const blocos = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    let erroJs = "";
    for (const b of blocos) { try { new (require("node:vm").Script)(b); } catch (e) { erroJs = e.message; } }
    ok("o JavaScript da tela compila", erroJs, "");

  } catch (e) {
    falhou++;
    console.log(`\n    ✖ a suíte parou: ${e.message}`);
  } finally {
    /* ====================================================================
       A LIMPEZA — pelo ID, nunca por LIKE.

       Uma varredura por "ZZ QA" alcançaria registro de outra rodada, de outra
       pessoa, ou (no dia em que alguém chamar uma reunião assim) do próprio
       Instituto. Os ids são os que ESTA execução criou.
       ==================================================================== */
    let sobrou = [];
    for (const id of atas) {
      try { await Q.run("DELETE FROM atas WHERE id=?", id); }
      catch { sobrou.push(id); }
    }
    if (contaId) {
      try { await Q.run("DELETE FROM g_usuarios WHERE id=?", contaId); }
      catch { sobrou.push(`conta ${contaId}`); }
    }
    filho.kill();
    try { fs.rmSync(BANCO, { force: true }); } catch {}
    if (sobrou.length) console.log(`\n  ⚠ não consegui apagar: ${sobrou.join(", ")} — apague à mão.`);

    console.log(`\n  ${falhou === 0 ? "✓" : "✖"} ${passou} passaram, ${falhou} falharam\n`);
    process.exit(falhou === 0 ? 0 : 1);
  }
})();
