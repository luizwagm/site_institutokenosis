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

/* 5288, e nao 5298: a secao 7 sobe um SEGUNDO servidor em PORTA+1, e 5299 e a
   porta do testar-cabecalhos.js. Duas suites do mesmo projeto disputando a
   mesma porta so quebram quando alguem as roda em paralelo — que e o pior
   momento para descobrir. */
const PORTA = Number(process.env.PORTA_TESTE_FREQ) || 5288;
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
    /* ====================================================================
       8. O TÍTULO VEM DA LISTA DE PROJETOS

       O campo era texto livre; virou escolha entre os projetos cadastrados,
       porque a folha impressa é o documento que circula assinado e duas
       grafias do mesmo projeto viram duas coisas diferentes na prestação de
       contas.

       `freqTituloOpcoes` é função PURA: dá para exercitá-la extraindo do
       app.html, sem subir o sistema e sem login — o mesmo caminho do
       `timbreHTML`.
       ==================================================================== */
    {
      const fs = require("node:fs");
      const html = fs.readFileSync(path.join(__dirname, "restrito", "app.html"), "utf8");
      const corpo = /function freqTituloOpcoes\(atual\)\{([\s\S]*?)\n\}/.exec(html);
      verdade("a montagem das opções existe no app", !!corpo);

      /* O ambiente mínimo de que ela precisa: o CACHE e o escape. */
      const montar = new Function("CACHE", "escA", "atual",
        "function freqTituloOpcoes(atual){" + corpo[1] + "\n}\nreturn freqTituloOpcoes(atual);");
      const escA = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const COM = { projetos: [{ title: "Movimento para a Vida" },
                               { title: "Serviço de Assistência Social à Família" }] };

      const lista = montar(COM, escA, "");
      verdade("os projetos entram na lista", lista.includes("Movimento para a Vida"));
      verdade("todos eles", lista.includes("Serviço de Assistência Social à Família"));
      /* Ordem alfabética: a lista é para achar, não para lembrar em que ordem
         foi cadastrado. */
      verdade("em ordem alfabética",
        lista.indexOf("Movimento") < lista.indexOf("Serviço de Assistência"));

      /* ---- O QUE MAIS IMPORTA: a folha antiga não perde o título ---- */
      const antigo = 'Projeto Socioassistencial "Movimento para a Vida Ativa" — Frequência Aula de Hidroginástica';
      const comAntigo = montar(COM, escA, antigo);
      verdade("o título de uma folha antiga continua na lista",
        comAntigo.includes(escA(antigo)));
      verdade("e vem marcado como o escolhido",
        new RegExp('value="' + escA(antigo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '" selected')
          .test(comAntigo));

      /* Um projeto escolhido também vem marcado — senão o select abre no
         primeiro e a folha muda de nome ao salvar. */
      const escolhido = montar(COM, escA, "Movimento para a Vida");
      verdade("o projeto já escolhido vem marcado",
        /value="Movimento para a Vida" selected/.test(escolhido));
      ok("e ele não é duplicado na lista",
         (escolhido.match(/Movimento para a Vida<\/option>/g) || []).length, 1);

      /* Sem projeto cadastrado a lista fica vazia e ninguém entende por quê. */
      const vazio = montar({ projetos: [] }, escA, "");
      verdade("sem projeto, a lista explica em vez de ficar vazia",
        /nenhum projeto cadastrado/i.test(vazio));

      /* Aspas no nome do projeto quebrariam o atributo `value` e comeriam o
         resto da lista. */
      const aspas = montar({ projetos: [{ title: 'Projeto "Vida" & Cia' }] }, escA, "");
      ok("aspas no nome do projeto não quebram a lista",
         /value="Projeto "Vida"/.test(aspas), false);
      verdade("e o nome continua legível", aspas.includes("&quot;Vida&quot;"));
    }

    /* ====================================================================
       9. A DATA MARCADA (1.37.0) — cor na coluna e observação no fim

       Feriado, data programada: a coluna do dia pintada e, embaixo da
       tabela, o que aquele dia tem de diferente. O servidor é quem garante
       o que é gravado — a tela qualquer um contorna.
       ==================================================================== */
    console.log("\n  9. a data marcada: cor e observação");
    {
      const cols9 = (await Q.all(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='frequencias'`)).map((c) => c.column_name);
      verdade("a coluna `marcas` existe", cols9.includes("marcas"));

      const base9 = { turma: "09h às 10h", mes: "2099-09", titulo: `${MARCA} — Marcas`, local: "ZZ QA",
                      datas: "[\"02\",\"07\",\"09\"]", participantes: "[]" };
      const marcasDe = async (id) => {
        const l = (await pedir("/restrito/api/frequencias")).json || [];
        const f = l.find((x) => x.id === id);
        try { return JSON.parse(f.marcas); } catch { return null; }
      };

      const c = await pedir("/restrito/api/frequencias", "POST", Object.assign({}, base9, {
        marcas: JSON.stringify([{ dia: "07", cor: "amarelo", obs: "Feriado — Independência" }]) }));
      ok("a folha com data marcada grava", c.status, 200);
      const idM = c.json && c.json.id;
      if (idM) folhas.push(idM);
      ok("a marca voltou inteira: dia, cor e observação", await marcasDe(idM),
        [{ dia: "07", cor: "amarelo", obs: "Feriado — Independência" }]);

      /* Folha sem marca nenhuma — como TODAS as que já existiam — continua
         valendo: a coluna nasce com a lista vazia. */
      const semMarca = await pedir("/restrito/api/frequencias", "POST", base9);
      if (semMarca.json && semMarca.json.id) folhas.push(semMarca.json.id);
      ok("folha sem marca nenhuma grava", semMarca.status, 200);
      ok("…e volta com a lista vazia", await marcasDe(semMarca.json.id), []);

      /* O que a tela não deixaria passar, mandado direto à rota. */
      await pedir(`/restrito/api/frequencias/${idM}`, "PUT", { marcas: JSON.stringify([
        { dia: "9", cor: "verde", obs: "  data   programada  " },          // dia sem zero, espaços sobrando
        { dia: "07", cor: "#ff0000", obs: "cor inventada" },                // cor fora da paleta
        { dia: "40", cor: "rosa", obs: "dia que não existe" },              // dia impossível
        { dia: "02", cor: "", obs: "" },                                    // marca vazia
        { dia: "02", cor: "javascript:alert(1)", obs: "" },                 // vazia de novo, com lixo
        "texto solto", null, [1, 2],                                        // o que nem objeto é
      ]) });
      ok("o servidor limpa: dia normalizado, cor desconhecida vira sem cor, o resto some", await marcasDe(idM), [
        { dia: "07", cor: "", obs: "cor inventada" },
        { dia: "09", cor: "verde", obs: "data programada" },
      ]);

      /* Um dia, uma marca: mandar duas para o mesmo dia não cria duas linhas
         de observação na folha — vale a última. */
      await pedir(`/restrito/api/frequencias/${idM}`, "PUT", { marcas: JSON.stringify([
        { dia: "07", cor: "rosa", obs: "primeira" }, { dia: "07", cor: "ciano", obs: "segunda" }]) });
      ok("duas marcas no mesmo dia: fica a última", await marcasDe(idM),
        [{ dia: "07", cor: "ciano", obs: "segunda" }]);

      /* A observação vai para o papel, embaixo da tabela: tem teto, e ele
         vale também na EDIÇÃO — limite só na criação se contorna editando. */
      await pedir(`/restrito/api/frequencias/${idM}`, "PUT", { marcas: JSON.stringify([
        { dia: "07", cor: "laranja", obs: "x".repeat(900) }]) });
      ok("a observação é aparada em 300 caracteres", ((await marcasDe(idM))[0] || {}).obs.length, 300);

      /* JSON quebrado não derruba a rota nem apaga a folha. */
      const torto = await pedir(`/restrito/api/frequencias/${idM}`, "PUT", { marcas: "{isto não é json" });
      ok("JSON torto não dá erro", torto.status, 200);
      ok("…e vira lista vazia", await marcasDe(idM), []);

      /* Editar outra coisa NÃO apaga as marcas: o PUT parcial só mexe no que veio. */
      await pedir(`/restrito/api/frequencias/${idM}`, "PUT", { marcas: JSON.stringify([
        { dia: "02", cor: "lilas", obs: "Aula de reposição" }]) });
      await pedir(`/restrito/api/frequencias/${idM}`, "PUT", { local: "ZZ QA Outro" });
      ok("mudar só o local preserva as marcas", await marcasDe(idM),
        [{ dia: "02", cor: "lilas", obs: "Aula de reposição" }]);

      /* ---------------- a tela: a paleta é a do servidor, e o papel diz o dia */
      const fs = require("node:fs");
      const html = fs.readFileSync(path.join(__dirname, "restrito", "app.html"), "utf8");
      const servidor = fs.readFileSync(path.join(__dirname, "restrito.js"), "utf8");
      const nomesTela = (/const FREQ_PALETA = \[([\s\S]*?)\];/.exec(html) || [, ""])[1]
        .match(/\["([a-z]+)"/g).map((x) => x.slice(2, -1));
      const nomesServidor = JSON.parse((/const FREQ_CORES = (\[[^\]]*\]);/.exec(servidor) || [, "[]"])[1]);
      ok("as cores da tela são exatamente as que o servidor aceita", nomesTela, nomesServidor);
      ok("são seis", nomesTela.length, 6);

      /* `observacoesImpressas` é função pura: extraída do app.html e exercitada
         aqui, como o `freqTituloOpcoes` acima. */
      const fonte = /function observacoesImpressas\(marcas, nCols, mes\)\{([\s\S]*?)\n\}/.exec(html);
      verdade("a montagem das observações impressas existe", !!fonte);
      const paleta = /const FREQ_PALETA = \[[\s\S]*?\];/.exec(html)[0];
      const tinta = /const freqTinta = [^\n]*/.exec(html)[0];
      const escA = (x) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const imprimir = new Function("escA", "marcas", "nCols", "mes",
        paleta + "\n" + tinta + "\nfunction observacoesImpressas(marcas, nCols, mes){" + fonte[1] + "\n}\nreturn observacoesImpressas(marcas, nCols, mes);");
      const papel = imprimir(escA, [
        { dia: "07", cor: "amarelo", obs: "Feriado <b>nacional</b>" },
        { dia: "09", cor: "verde", obs: "" },                       // só cor: não tem o que dizer embaixo
      ], 6, "2099-09");
      verdade("a observação sai no papel com o dia por extenso", /Dia 07\/09<\/b> — Feriado/.test(papel));
      verdade("ocupa a largura toda da tabela", papel.includes('colspan="6"'));
      verdade("a pastilha repete a cor da coluna", papel.includes("#F7FF3C"));
      /* Na PASTILHA, e não em qualquer lugar da folha: a faixa "Observações"
         também traz a regra, e uma prova frouxa passaria só por causa dela.
         Sem isto o navegador imprime a pastilha em branco ("gráficos de
         plano de fundo" vem desligado). */
      verdade("e é obrigada a sair colorida na impressora",
        /<span[^>]*background:#F7FF3C[^>]*print-color-adjust:exact/.test(papel));
      /* A COLUNA pintada no papel é montada dentro de `imprimirFrequencia`,
         que abre janela — confere-se o código: fundo + a regra, juntos. */
      verdade("a coluna do dia marcado também é obrigada a sair colorida",
        html.includes("`;background:${t};-webkit-print-color-adjust:exact;print-color-adjust:exact`"));
      verdade("…no cabeçalho e em cada linha da coluna",
        html.includes('width:${diaW}%${fundo(d)}"') && html.includes('height:1rem${fundo(d)}"'));
      verdade("o texto digitado não vira HTML no papel", papel.includes("&lt;b>nacional&lt;/b>") && !papel.includes("<b>nacional"));
      ok("marca só de cor não gera linha de observação", (papel.match(/<tr>/g) || []).length, 2);
      ok("sem observação nenhuma, a tabela termina no último nome",
        imprimir(escA, [{ dia: "09", cor: "verde", obs: "" }], 6, "2099-09"), "");
    }

    /* ====================================================================
       10. PÔR E TIRAR COLUNAS DE DATA (1.38.0)

       Eram dez colunas fixas no código. Agora o número é DA FOLHA: um mês com
       ações a mais ganha colunas, e as que sobram saem. 1 a 31.
       ==================================================================== */
    console.log("\n  10. a folha com o número de colunas dela");
    {
      const cols10 = (await Q.all(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='frequencias'`)).map((c) => c.column_name);
      verdade("a coluna `colunas` existe", cols10.includes("colunas"));

      const base10 = { turma: "10h às 11h", mes: "2099-10", titulo: `${MARCA} — Colunas`, local: "ZZ QA",
                       datas: "[\"02\",\"07\"]", participantes: "[]" };
      const colunasDe = async (id) => {
        const l = (await pedir("/restrito/api/frequencias")).json || [];
        return Number((l.find((x) => x.id === id) || {}).colunas);
      };
      const nova = await pedir("/restrito/api/frequencias", "POST", base10);
      if (nova.json && nova.json.id) folhas.push(nova.json.id);
      ok("folha sem o número de colunas nasce com 10 (o de sempre)", await colunasDe(nova.json.id), 10);

      const doze = await pedir("/restrito/api/frequencias", "POST", Object.assign({}, base10, { colunas: 14 }));
      if (doze.json && doze.json.id) folhas.push(doze.json.id);
      ok("folha com 14 colunas guarda as 14", await colunasDe(doze.json.id), 14);

      await pedir(`/restrito/api/frequencias/${doze.json.id}`, "PUT", { colunas: 6 });
      ok("tirar colunas depois de salva: 6", await colunasDe(doze.json.id), 6);
      await pedir(`/restrito/api/frequencias/${doze.json.id}`, "PUT", { local: "ZZ QA Outro" });
      ok("mudar outra coisa não mexe no número de colunas", await colunasDe(doze.json.id), 6);

      /* O que a tela não mandaria, mandado direto à rota. */
      await pedir(`/restrito/api/frequencias/${doze.json.id}`, "PUT", { colunas: 99 });
      ok("mais que 31 (os dias do mês) é cortado em 31", await colunasDe(doze.json.id), 31);
      await pedir(`/restrito/api/frequencias/${doze.json.id}`, "PUT", { colunas: 0 });
      ok("zero vira 1 — a folha precisa de uma coluna de data", await colunasDe(doze.json.id), 1);
      await pedir(`/restrito/api/frequencias/${doze.json.id}`, "PUT", { colunas: "abc" });
      ok("lixo vira 10", await colunasDe(doze.json.id), 10);
      await pedir(`/restrito/api/frequencias/${doze.json.id}`, "PUT",
        { colunas: 3, datas: JSON.stringify(["01", "02", "03", "04", "05"]) });
      ok("nunca menos colunas que as datas que vieram junto (5 datas, \"3 colunas\" → 5)", await colunasDe(doze.json.id), 5);

      /* --------------- a folha impressa: as larguras com 10, 20 e 31 dias */
      const fs = require("node:fs");
      const html = fs.readFileSync(path.join(__dirname, "restrito", "app.html"), "utf8");
      const fonte = /function larguraColunasFreq\(n\)\{([\s\S]*?)\n\}/.exec(html);
      verdade("a conta das larguras da folha impressa existe", !!fonte);
      const larguras = new Function("n", fonte[1]);
      for (const n of [1, 10, 14, 20, 31]) {
        const w = larguras(n);
        const soma = w.nomeW + w.cpfW + w.numW + w.diaW * n;
        verdade(`${n} dia(s): as colunas somam 100% da folha`, Math.abs(soma - 100) < 0.2, String(soma));
        verdade(`${n} dia(s): o Nome fica com pelo menos um quarto da folha`, w.nomeW >= 24.9, String(w.nomeW));
      }
      ok("com dez dias, a folha sai igual a antes (4,5% por dia, letra .82rem)",
        [larguras(10).diaW, larguras(10).fonte], [4.5, ".82rem"]);
      verdade("com 31 dias, a letra diminui", larguras(31).fonte === ".72rem");
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
