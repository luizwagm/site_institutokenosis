/* ==========================================================================
   cifrar-dados.js — cifra os dados sensíveis que já estão no banco

   Roda uma vez, na virada. Depois disso o sistema já grava cifrado sozinho.

   É SEGURO RODAR DE NOVO: cada valor é conferido antes: o que já está cifrado
   é pulado. Uma execução interrompida pela metade continua de onde parou.

   O que ele NÃO faz: nada de reversível sem a chave. Depois desta migração, a
   chave em DADOS_CHAVE é o que separa o instituto de um banco ilegível. Guarde-a
   fora do servidor também — um backup do banco sem a chave não serve para
   restaurar.

   Uso:
     node cifrar-dados.js --conferir   mostra o que falta cifrar, não escreve
     node cifrar-dados.js              cifra
   ========================================================================== */
const path = require("node:path");
const { Q, carregarAmbiente } = require("./pg");
const { cifrar, jaCifrado, chaveConfigurada, erroChave } = require("./cripto");
const { CAMPOS_PROTEGIDOS } = require("./restrito");

async function colunasReais(tabela) {
  const r = await Q.all(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=?", tabela);
  return new Set(r.map((x) => x.column_name));
}

/* Conta quanto falta, sem escrever. Lê com Q.bruto para enxergar o que está
   REALMENTE gravado — pelo caminho normal tudo voltaria decifrado e pareceria
   que nada está protegido. */
async function levantar() {
  const relatorio = [];
  for (const [tabela, campos] of Object.entries(CAMPOS_PROTEGIDOS)) {
    const reais = await colunasReais(tabela);
    const usar = campos.filter((c) => reais.has(c));
    if (!usar.length) continue;
    const linhas = await Q.bruto(`SELECT id, ${usar.join(",")} FROM ${tabela}`);
    let emClaro = 0, cifrados = 0, vazios = 0;
    for (const l of linhas) for (const c of usar) {
      const v = l[c];
      if (v === null || v === undefined || v === "") vazios++;
      else if (jaCifrado(v)) cifrados++;
      else emClaro++;
    }
    relatorio.push({ tabela, linhas: linhas.length, campos: usar.length, emClaro, cifrados, vazios });
  }
  return relatorio;
}

async function cifrarTudo() {
  let total = 0;
  for (const [tabela, campos] of Object.entries(CAMPOS_PROTEGIDOS)) {
    const reais = await colunasReais(tabela);
    const usar = campos.filter((c) => reais.has(c));
    if (!usar.length) continue;

    const linhas = await Q.bruto(`SELECT id, ${usar.join(",")} FROM ${tabela}`);
    let mexidas = 0;

    /* Uma transação por TABELA, e não uma só para tudo: se algo der errado no
       meio, o que já foi convertido continua convertido e o script retoma daí.
       Uma transação única sobre o instituto inteira seria mais elegante e muito
       pior de recuperar. */
    await Q.tx(async () => {
      for (const l of linhas) {
        const trocar = usar.filter((c) => {
          const v = l[c];
          return v !== null && v !== undefined && v !== "" && !jaCifrado(v);
        });
        if (!trocar.length) continue;
        const valores = trocar.map((c) => cifrar(l[c]));
        await Q.run(
          `UPDATE ${tabela} SET ${trocar.map((c) => c + "=?").join(",")} WHERE id=?`,
          ...valores, l.id);
        mexidas++; total += trocar.length;
      }
    });
    if (mexidas) console.log(`   · ${tabela.padEnd(22)} ${mexidas} registro(s) protegido(s)`);
  }
  return total;
}

/* Prova, lendo pelos dois caminhos, que o banco guarda cifrado E que o sistema
   lê certo. É a conferência que responde à pergunta do cliente: "continua
   protegido no backup, mas funciona na tela?" */
async function conferir() {
  const problemas = [];
  for (const [tabela, campos] of Object.entries(CAMPOS_PROTEGIDOS)) {
    const reais = await colunasReais(tabela);
    const usar = campos.filter((c) => reais.has(c));
    if (!usar.length) continue;

    const cru = await Q.bruto(`SELECT id, ${usar.join(",")} FROM ${tabela} ORDER BY id LIMIT 200`);
    const lido = await Q.all(`SELECT id, ${usar.join(",")} FROM ${tabela} ORDER BY id LIMIT 200`);

    for (let i = 0; i < cru.length; i++) {
      for (const c of usar) {
        const bruto = cru[i][c], claro = lido[i][c];
        if (bruto === null || bruto === undefined || bruto === "") continue;
        if (!jaCifrado(bruto)) { problemas.push(`${tabela}.${c} id=${cru[i].id}: ainda em texto puro no banco`); continue; }
        if (claro === "[protegido]") problemas.push(`${tabela}.${c} id=${cru[i].id}: não abriu com a chave atual`);
      }
    }
  }
  return problemas;
}

async function principal() {
  carregarAmbiente(__dirname);
  console.log("\n========== PROTEÇÃO DOS DADOS SENSÍVEIS ==========\n");

  if (!chaveConfigurada()) {
    console.error("  ✖ " + erroChave());
    console.error("\n    Gere a chave:  openssl rand -base64 32");
    console.error("    E grave como DADOS_CHAVE em /etc/kenosis.env (ou no .env, em desenvolvimento).\n");
    process.exit(1);
  }

  const antes = await levantar();
  console.log("  SITUAÇÃO ATUAL");
  console.log("  " + "tabela".padEnd(22) + "registros  em claro  protegidos  vazios");
  let faltando = 0;
  for (const r of antes) {
    faltando += r.emClaro;
    console.log("  " + r.tabela.padEnd(22) + String(r.linhas).padStart(9) + String(r.emClaro).padStart(10)
      + String(r.cifrados).padStart(12) + String(r.vazios).padStart(8));
  }
  console.log("");

  if (process.argv.includes("--conferir")) {
    console.log(faltando ? `  ${faltando} valor(es) ainda em texto puro. Rode sem --conferir para proteger.\n`
                         : "  ✓ tudo já está protegido.\n");
    await Q.fechar(); return;
  }

  if (faltando) {
    console.log("  PROTEGENDO");
    const n = await cifrarTudo();
    console.log(`\n  ${n} valor(es) cifrado(s).\n`);
  } else {
    console.log("  Nada a fazer — tudo já estava protegido.\n");
  }

  const problemas = await conferir();
  if (problemas.length) {
    console.error("  ✖ CONFERÊNCIA ENCONTROU PROBLEMAS:");
    for (const p of problemas.slice(0, 20)) console.error("    " + p);
    if (problemas.length > 20) console.error(`    … e mais ${problemas.length - 20}`);
    console.error("");
    process.exit(1);
  }
  console.log("  ✓ conferido: o banco guarda cifrado e o sistema lê corretamente.");
  console.log("    GUARDE A CHAVE (DADOS_CHAVE) fora do servidor. Sem ela, nem o");
  console.log("    backup nem o banco podem ser lidos — nem por você.\n");
  await Q.fechar();
}

if (require.main === module) {
  principal().catch(async (e) => {
    console.error("\n  ✖ falhou:", e.message, "\n");
    await Q.fechar().catch(() => {});
    process.exit(1);
  });
}
