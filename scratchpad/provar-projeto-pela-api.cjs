/* Prova o defeito e a correção PELO CAMINHO REAL: HTTP, sessão, formulário.

   O teste anterior falava direto com o banco; este entra no /restrito como
   entra a secretaria, edita o título de um projeto deixando a Ordem em branco
   — o caso exato que devolveu 500 em produção — e confere que salvou.

   Cria um operador SÓ DELE (`zz_qa_*`) e o apaga no fim. A senha do cliente,
   tanto do /admin quanto do /restrito, não é lida nem trocada.
   Ver [[dados-de-teste-em-banco-do-cliente]]. */
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const RAIZ = path.join(__dirname, "..");
const { carregarAmbiente, Q } = require(path.join(RAIZ, "pg.js"));
carregarAmbiente(RAIZ);

const PORTA = Number(process.env.PORT_QA) || 5199;
const LOGIN = "zz_qa_" + crypto.randomBytes(3).toString("hex");
const SENHA = crypto.randomBytes(12).toString("hex");

const pedir = (metodo, caminho, { corpo, cookie } = {}) => new Promise((ok, bad) => {
  const d = corpo === undefined ? null : JSON.stringify(corpo);
  const r = http.request({ hostname: "127.0.0.1", port: PORTA, method: metodo, path: caminho, headers: {
    ...(d ? { "content-type": "application/json", "content-length": Buffer.byteLength(d) } : {}),
    ...(cookie ? { cookie } : {}) } }, (res) => {
    let b = ""; res.on("data", (c) => (b += c));
    res.on("end", () => ok({ status: res.statusCode, headers: res.headers, corpo: b,
      json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
  });
  r.on("error", bad); if (d) r.write(d); r.end();
});

let ok = 0; const falhas = [];
const certo = (r, c, det = "") => { if (c) { ok++; console.log(`  ok    ${r}`); }
  else { falhas.push(r); console.log(`  FALHA ${r}${det ? "  -> " + det : ""}`); } };

/* O MESMO formato do restrito.js — em HEX, não base64. Reproduzir o hash à mão
   já custou um 401 sem explicação; os parâmetros saem de lá para não divergirem
   se alguém ajustar o custo do scrypt. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hash(senha) {
  const sal = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), sal, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${sal.toString("hex")}$${dk.toString("hex")}`;
}

(async () => {
  let meuId = null, projeto = null, antes = null;
  try {
    meuId = await Q.inserir(
      "INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?) RETURNING id",
      "ZZ QA temporário", LOGIN, hash(SENHA), "admin", new Date().toISOString());

    const entrar = await pedir("POST", "/restrito/api/login", { corpo: { usuario: LOGIN, senha: SENHA } });
    certo("entrou no /restrito com o operador de teste", entrar.status === 200,
      `status ${entrar.status} ${entrar.corpo.slice(0, 120)}`);
    const ck = (/rid=[a-f0-9]+/.exec(String(entrar.headers["set-cookie"] || "")) || [])[0];
    if (!ck) throw new Error("sem cookie de sessão — o resto do teste não faz sentido");

    projeto = await Q.get("SELECT * FROM projetos ORDER BY id LIMIT 1");
    antes = { ...projeto };
    certo("achou um projeto para editar", !!projeto);

    /* Exatamente o corpo que a tela manda: todos os campos do formulário, com
       a Ordem em branco porque ninguém digitou nada nela. */
    const corpo = { title: projeto.title + " (zz)", slug: projeto.slug, sigla: projeto.sigla ?? "",
      status: projeto.status ?? "", resumo: projeto.resumo ?? "", publico: projeto.publico ?? "",
      content: projeto.content ?? "", sort: "" };

    const salvar = await pedir("PUT", `/restrito/api/projetos/${projeto.id}`, { cookie: ck, corpo });
    certo("salvar o projeto com a Ordem em branco responde 200", salvar.status === 200,
      `status ${salvar.status} ${salvar.corpo.slice(0, 160)}`);

    const depois = await Q.get("SELECT title,sort FROM projetos WHERE id=?", projeto.id);
    certo("o título novo foi gravado", depois && depois.title.endsWith("(zz)"), JSON.stringify(depois));
    certo("a ordem em branco virou nulo, não quebrou", depois && depois.sort === null,
      `sort=${JSON.stringify(depois && depois.sort)}`);

    /* Com valor de verdade continua funcionando — a correção não pode ter
       transformado todo número em nulo. */
    const comNumero = await pedir("PUT", `/restrito/api/projetos/${projeto.id}`,
      { cookie: ck, corpo: { ...corpo, sort: "7" } });
    const d2 = await Q.get("SELECT sort FROM projetos WHERE id=?", projeto.id);
    certo("ordem preenchida continua sendo gravada", comNumero.status === 200 && Number(d2.sort) === 7,
      `status ${comNumero.status} sort=${d2 && d2.sort}`);
  } finally {
    if (projeto && antes) {
      await Q.run("UPDATE projetos SET title=?,slug=?,sigla=?,status=?,resumo=?,publico=?,content=?,sort=? WHERE id=?",
        antes.title, antes.slug, antes.sigla, antes.status, antes.resumo, antes.publico, antes.content, antes.sort, antes.id);
      const fim = await Q.get("SELECT title,sort FROM projetos WHERE id=?", antes.id);
      certo("o projeto do cliente voltou exatamente como estava",
        fim.title === antes.title && fim.sort === antes.sort, `${fim.title} / sort=${fim.sort}`);
    }
    if (meuId) await Q.run("DELETE FROM g_usuarios WHERE id=?", meuId);
    const sobrou = await Q.get("SELECT COUNT(*) c FROM g_usuarios WHERE email LIKE 'zz_qa_%'");
    certo("o operador de teste foi removido", Number(sobrou.c) === 0, `${sobrou.c} sobrando`);
  }

  console.log(`\n=== ${ok}/${ok + falhas.length} ===`);
  if (falhas.length) { console.log("\nFalhou:\n" + falhas.map((f) => "  · " + f).join("\n")); process.exit(1); }
  console.log("Tudo certo.\n");
  process.exit(0);
})().catch((e) => { console.error("ERRO:", e); process.exit(1); });
