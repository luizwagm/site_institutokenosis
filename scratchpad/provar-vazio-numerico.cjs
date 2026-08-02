/* Prova que campo numérico em branco não derruba mais o salvar.

   Cria um registro PRÓPRIO em cada tabela (nome sempre "ZZ QA …"), grava com
   TODAS as colunas inteiras vazias, edita do mesmo jeito e confere que o banco
   guardou NULL. No fim apaga só o que criou — nada do instituto é tocado.

   Ver [[dados-de-teste-em-banco-do-cliente]]: registro de teste em banco do
   cliente é sempre meu, nunca por cima do dele. */
const path = require("node:path");
const RAIZ = path.join(__dirname, "..");
const { carregarAmbiente, Q } = require(path.join(RAIZ, "pg.js"));
carregarAmbiente(RAIZ);

const TAB = {
  pacientes: ["nome"], projetos: ["title"], servicos: ["title"],
  profissionais: ["nome"], atendimentos: [], eventos: ["titulo"],
  documentos_gestao: [], prontuario_registros: ["tipo", "texto"],
};

let ok = 0; const falhas = [];
const certo = (r, c, det = "") => { if (c) { ok++; console.log(`  ok    ${r}`); }
  else { falhas.push(r); console.log(`  FALHA ${r}${det ? "  -> " + det : ""}`); } };

(async () => {
  const criados = [];
  try {
    for (const [tabela, textos] of Object.entries(TAB)) {
      const cols = await Q.all(`SELECT column_name c, data_type d, is_nullable n, column_default df
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name=? ORDER BY ordinal_position`, tabela);
      const numericas = cols.filter((c) => c.c !== "id" && /^(integer|bigint|smallint|numeric)/.test(c.d));
      if (!numericas.length) continue;

      /* A MESMA regra do prepararCampos no restrito.js. O teste tem de imitar o
         servidor, não o contrário: da primeira vez ele inseria NULL em tudo e
         acusava falha em duas colunas que o banco declara obrigatórias — a
         culpa era do teste, que passava por cima da lógica que estava provando. */
      const obrigatorias = numericas.filter((c) => c.n === "NO" && c.df == null).map((c) => c.c);
      const comPadrao   = numericas.filter((c) => c.n === "NO" && c.df != null).map((c) => c.c);
      const viramNulo   = numericas.filter((c) => c.n === "YES").map((c) => c.c);

      /* Coluna obrigatória sem padrão não é caso deste teste: em branco ali o
         servidor devolve 400 pedindo o campo, e é isso que se quer. */
      const corpo = {};
      for (const t of textos) corpo[t] = "ZZ QA " + tabela;
      for (const o of obrigatorias) corpo[o] = 1;         // preenchida, como a tela exige
      for (const n of viramNulo) corpo[n] = null;         // em branco → NULL
      // as `comPadrao` ficam FORA da instrução, para o padrão da coluna valer

      const nomes = Object.keys(corpo);
      const valores = nomes.map((n) => corpo[n]);
      if (comPadrao.length) console.log(`  ·     ${tabela}: ${comPadrao.join(", ")} fora da instrução (usa o padrão)`);
      let id = null;
      try {
        id = await Q.inserir(`INSERT INTO ${tabela}(${nomes.join(",")}) VALUES(${nomes.map(() => "?").join(",")})`, ...valores);
        criados.push([tabela, id]);
      } catch (e) { certo(`${tabela}: criar com ${viramNulo.length} número(s) em branco`, false, e.message); continue; }
      certo(`${tabela}: criar com ${viramNulo.length} número(s) em branco`, true);

      const guardado = await Q.get(`SELECT * FROM ${tabela} WHERE id=?`, id);
      certo(`${tabela}: em branco virou NULL, não zero`, viramNulo.every((n) => guardado[n] === null),
        viramNulo.map((n) => `${n}=${JSON.stringify(guardado[n])}`).join(" "));
      if (comPadrao.length)
        certo(`${tabela}: coluna com padrão recebeu o padrão, não nulo`,
          comPadrao.every((c) => guardado[c] != null),
          comPadrao.map((c) => `${c}=${JSON.stringify(guardado[c])}`).join(" "));

      try {
        await Q.run(`UPDATE ${tabela} SET ${nomes.map((n) => n + "=?").join(",")} WHERE id=?`, ...valores, id);
        certo(`${tabela}: editar mantendo os números em branco`, true);
      } catch (e) { certo(`${tabela}: editar mantendo os números em branco`, false, e.message); }
    }

    /* O caso exato do cliente: editar o título de um projeto deixando a ordem
       em branco. Feito no registro DELE, mas devolvendo tudo como estava. */
    const dele = await Q.get("SELECT * FROM projetos WHERE title NOT LIKE 'ZZ QA%' ORDER BY id LIMIT 1");
    if (dele) {
      try {
        await Q.run("UPDATE projetos SET title=?,slug=?,sigla=?,status=?,resumo=?,publico=?,content=?,sort=? WHERE id=?",
          dele.title + " (zz)", dele.slug, dele.sigla, dele.status, dele.resumo, dele.publico, dele.content, null, dele.id);
        const agora = await Q.get("SELECT title,sort FROM projetos WHERE id=?", dele.id);
        certo("o caso do cliente: trocar o título com a ordem em branco", agora.title.endsWith("(zz)"));
        await Q.run("UPDATE projetos SET title=?,sort=? WHERE id=?", dele.title, dele.sort, dele.id);
        const fim = await Q.get("SELECT title,sort FROM projetos WHERE id=?", dele.id);
        certo("o projeto do cliente voltou exatamente como estava",
          fim.title === dele.title && fim.sort === dele.sort, `${fim.title} / sort=${fim.sort}`);
      } catch (e) { certo("o caso do cliente: trocar o título com a ordem em branco", false, e.message); }
    }
  } finally {
    for (const [tabela, id] of criados) await Q.run(`DELETE FROM ${tabela} WHERE id=?`, id);
    const sobrou = await Q.get("SELECT COUNT(*) c FROM projetos WHERE title LIKE 'ZZ QA%'");
    certo("nenhum registro de teste ficou no banco", Number(sobrou.c) === 0, `${sobrou.c} sobrando`);
  }

  console.log(`\n=== ${ok}/${ok + falhas.length} ===`);
  if (falhas.length) { console.log("\nFalhou:\n" + falhas.map((f) => "  · " + f).join("\n")); process.exit(1); }
  console.log("Tudo certo.\n");
  process.exit(0);
})().catch((e) => { console.error("ERRO:", e); process.exit(1); });
