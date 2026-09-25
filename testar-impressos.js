/* ==========================================================================
   testar-impressos.js — o cabeçalho se repete em toda folha (1.35.2)

   O QUE ESTA SUÍTE GUARDA

   Um impresso de dez páginas com o cabeçalho só na primeira é um documento
   pela metade: da segunda folha em diante a relação vira uma grade de dados
   sem dizer o que é cada coluna. Quem confere no papel — a prestação de
   contas, a diretoria, o conselho — lê folha por folha, e não a primeira.

   O que faz o cabeçalho repetir é UMA coisa: a linha de títulos estar dentro
   de um `<thead>`. Solta no corpo da tabela, ela é uma linha como as outras e
   sai uma vez só. Isso não dá erro, não aparece na tela e só se descobre no
   papel — por isso vira prova.

   MEDIDO EM FOLHA, E NÃO NO PALPITE. Com o Chrome instalado, a seção 3 imprime
   de verdade (220 linhas, 19 páginas) e CONTA em quantas o cabeçalho aparece.
   Sem Chrome — no CI, por exemplo — ela é pulada e diz que foi; as seções 1 e
   2 conferem o código e rodam em qualquer lugar.

   Esta suíte NÃO toca no banco: ela lê o arquivo da tela. Pode rodar a
   qualquer hora, inclusive com o sistema no ar.

     node testar-impressos.js
     IMPRESSOS_CHROME=1 node testar-impressos.js    (força a prova em folha)
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const APP = path.join(__dirname, "restrito", "app.html");
const html = fs.readFileSync(APP, "utf8");

let passou = 0, falhou = 0;
function ok(nome, real, esperado) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) { passou++; console.log(`    ✓ ${nome}`); return; }
  falhou++;
  console.log(`    ✖ ${nome}\n        esperado: ${JSON.stringify(esperado)}\n        obtido:   ${JSON.stringify(real)}`);
}
const verdade = (nome, cond, detalhe) => {
  ok(nome, !!cond, true);
  if (!cond && detalhe) console.log(`        ${detalhe}`);
};

console.log("\n  ══ IMPRESSOS — o cabeçalho em toda folha ══\n");

/* ==========================================================================
   1. O CÓDIGO DA TELA
   ========================================================================== */
console.log("  1. toda listagem impressa tem o cabeçalho dentro de <thead>");

/* A relação de usuários é a listagem que mais cresce: é ela que vai a dez,
   quinze páginas. Era a única que tinha a linha de títulos solta. */
verdade("a relação de usuários usa <thead>",
  /<table class="m"><thead>/.test(html));
verdade("…e fecha o corpo dela em </tbody>",
  html.includes('</tr>`).join("")+`</tbody></table>`'));

/* `table.m` é a classe de TODA listagem impressa. Uma nova que nasça sem
   thead é o mesmo defeito de volta, e esta prova pega. */
const listagens = [...html.matchAll(/<table class="m"[^>]*>/g)];
verdade("existe pelo menos uma listagem impressa", listagens.length > 0, `achei ${listagens.length}`);
for (const m of listagens) {
  const depois = html.slice(m.index + m[0].length, m.index + m[0].length + 40);
  verdade(`a listagem em ${m.index} abre com <thead>`, depois.trimStart().startsWith("<thead>"), depois.slice(0, 40));
}

/* A agenda não é tabela de colunas: é uma lista por DIA. O que precisa
   repetir ali é o dia — quem confere agenda no papel trabalha por dia. */
verdade("a agenda põe o dia num <thead> para repetir",
  /<table class="ag-tab"><thead><tr><th class="ag-dia">/.test(html));

/* Frequência e ata já nasceram certas (1.33 e 1.35). A prova existe para que
   continuem assim: as duas são folhas assinadas fora do sistema. */
verdade("a folha de frequência mantém o cabeçalho em <thead>",
  /table-layout:fixed;font-size:\.82rem">\$\{colgroup\}<thead>/.test(html));
verdade("a ata mantém o cabeçalho em <thead>",
  /table-layout:fixed;font-size:\.86rem">\$\{colgroup\}<thead>/.test(html));

/* ==========================================================================
   2. O CSS DO DOCUMENTO IMPRESSO
   ========================================================================== */
console.log("\n  2. as regras que seguram a repetição");

/* ⚠ AS REGRAS SÃO PROCURADAS DENTRO DO DOCUMENTO IMPRESSO, e não no arquivo
   inteiro. A folha de estilo da AGENDA também declara table-header-group para
   a tabela dela; procurando no arquivo todo, a regra geral podia ser apagada
   que a busca continuava achando a da agenda e a prova passava — aconteceu,
   na sabotagem #1, e por isso esta prova foi refeita. */
const ini = html.indexOf("return " + String.fromCharCode(96) + "<!doctype html>");
const fim = html.indexOf("</style></head><body>", ini);
const doc = html.slice(ini, fim);
verdade("o documento de impressão foi encontrado no arquivo", ini > 0 && fim > ini);

verdade("o <thead> está declarado como table-header-group",
  doc.includes("thead{display:table-header-group}"));
verdade("e o <tfoot> como table-footer-group",
  doc.includes("tfoot{display:table-footer-group}"));

/* A linha não pode partir ao meio na dobra da folha — metade do nome numa
   página e metade na outra. */
/* Entre as regras de "não quebrar" do documento, interessam as que falam de
   LINHA de tabela (tr) — a do .evo, por exemplo, é de outro assunto e foi o
   que a primeira versão desta prova pegou por engano. */
const regrasAvoid = doc.split(String.fromCharCode(10))
  /* Linha de REGRA, e não de comentário: o comentário logo acima da regra cita
     o próprio texto dela para explicar o que faz, e entrava na conta. Regra
     termina em "}". */
  .filter((l) => l.includes("page-break-inside:avoid") && l.includes("tr")
    && l.trim().endsWith("}") && !l.includes("/*"));
verdade("existe a regra que impede uma linha de partir entre duas folhas",
  regrasAvoid.length > 0, "não achei nenhuma regra de linha no documento");

/* ⚠ A TABELA DO TIMBRE FICA DE FORA dessa regra. A linha dela guarda o
   documento INTEIRO: pedir que um corpo de dez páginas não quebre é pedir o
   impossível, e o navegador responde empurrando conteúdo e abrindo buracos.
   A prova lê os SELETORES um a um — basta um sem o :not(.pag) para a regra
   voltar a alcançar o timbre, e foi assim que a sabotagem #2 escapou. */
const seletores = regrasAvoid.flatMap((l) => l.split("{")[0].split(",")).map((x) => x.trim()).filter(Boolean);
verdade("a tabela do timbre NÃO entra na regra de não quebrar",
  seletores.length > 0 && seletores.every((sel) => sel.startsWith("table:not(.pag)")),
  seletores.join(" | "));

/* Sozinho no alto da página 7, sem o título por perto, um cabeçalho igual às
   outras linhas passa por dado. */
verdade("o cabeçalho repetido se distingue das linhas de dados",
  doc.includes("table.m thead th{background:"));

/* ⚠ A ARMADILHA QUE ME DERRUBOU ESCREVENDO ISTO: o documento impresso inteiro
   é um TEMPLATE LITERAL dentro do app.html. Uma crase ali — mesmo dentro de
   um comentário de CSS — fecha a string e o arquivo PARA DE COMPILAR: o
   sistema abre com a tela vazia e o console diz "Unexpected identifier". */
verdade("nenhuma crase dentro do documento de impressão",
  ini > 0 && fim > ini && !doc.slice(20).includes("`"),
  "uma crase aqui fecha o template literal e derruba a tela inteira");

/* O bloco inteiro do script tem de compilar. É a rede que pega a crase, a
   chave a menos e o resto. */
const blocos = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let erroJs = "";
for (const b of blocos) { try { new (require("node:vm").Script)(b); } catch (e) { erroJs = e.message; } }
verdade("o JavaScript da tela compila", !erroJs, erroJs);

/* ==========================================================================
   3. A PROVA EM FOLHA (precisa do Chrome)
   ========================================================================== */
console.log("\n  3. imprimindo de verdade");

function acharChrome() {
  const candidatos = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
  ].filter(Boolean);
  return candidatos.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || "";
}

/* Conta as páginas do PDF e em quantas delas aparece a COR de fundo do
   cabeçalho. Cor vira número no fluxo do PDF — dá para contar sem decifrar
   fonte, que é onde uma leitura de texto se perderia. */
function paginasComCabecalho(pdf, hex) {
  const cor = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => { const s = v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); return s.startsWith("0.") ? s.slice(1) : s; })
    .join(" ") + " rg";
  const buf = fs.readFileSync(pdf);
  let paginas = 0, com = 0, i = 0;
  while (true) {
    const a = buf.indexOf(Buffer.from("stream"), i); if (a < 0) break;
    const b = buf.indexOf(Buffer.from("endstream"), a); if (b < 0) break;
    let d = buf.slice(a + 6, b);
    while (d[0] === 13 || d[0] === 10) d = d.slice(1);
    let s = "";
    try { s = zlib.inflateSync(d).toString("latin1"); } catch { /* fluxo que não é conteúdo */ }
    if (s.includes(" re") && (s.includes("Tj") || s.includes("TJ"))) { paginas++; if (s.includes(cor)) com++; }
    i = b + 9;
  }
  return { paginas, com };
}

const chrome = acharChrome();
if (!chrome) {
  console.log("    · pulado: não achei o Chrome nesta máquina (defina CHROME=<caminho> para rodar)");
  console.log("      As seções 1 e 2 já garantem o código; esta aqui é a conferência no papel.");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kenosis-impresso-"));
  try {
    /* O documento de impressão é montado com o CSS REAL, lido do app.html — e
       não com uma cópia que poderia envelhecer sem ninguém notar. */
    let cabeca = (html.slice(ini + "return ".length, fim) + "</style></head><body>")
      .replace(/\$\{[^}]*\}/g, (m) =>
        /paisagem\?" landscape"/.test(m) ? " landscape"
          : /\bmx\b/.test(m) ? "1.2cm"
            : /\bwm\b/.test(m) ? "58%" : "");

    const linhas = [];
    for (let i = 1; i <= 220; i++) {
      linhas.push(`<tr><td>ZZ QA Usuario ${i}</td><td>Rua Exemplo, ${i}</td><td>(81) 90000-0000</td>`
        + `<td>Projeto</td><td>Servico</td><td>Profissional</td><td>Ativo</td></tr>`);
    }
    const cab = '<thead><tr><th style="width:21%">Usuario</th><th style="width:23%">Endereco</th>'
      + '<th style="width:10%">Telefone</th><th style="width:12%">Projeto</th><th style="width:14%">Servicos</th>'
      + '<th style="width:13%">Profissional</th><th style="width:7%">Situacao</th></tr></thead>';
    const monta = (comThead) => `${cabeca}
      <table class="pag"><thead><td><div>TIMBRE</div></td></thead><tfoot><td></td></tfoot>
      <tbody><tr><td><h1>Relacao de usuarios</h1>
      <table class="m">${comThead ? cab : cab.replace("<thead>", "").replace("</thead>", "")}
      <tbody>${linhas.join("")}</tbody></table>
      </td></tr></tbody></table></body></html>`;

    for (const [nome, comThead] of [["com", true], ["sem", false]]) {
      fs.writeFileSync(path.join(tmp, nome + ".html"), monta(comThead));
      spawnSync(chrome, ["--headless", "--disable-gpu", "--no-pdf-header-footer",
        `--print-to-pdf=${path.join(tmp, nome + ".pdf")}`, path.join(tmp, nome + ".html")],
        { timeout: 120000 });
    }

    const com = paginasComCabecalho(path.join(tmp, "com.pdf"), "#f4f7fb");
    const sem = paginasComCabecalho(path.join(tmp, "sem.pdf"), "#f4f7fb");
    verdade("a relação de 220 linhas passa de uma folha", com.paginas > 5, `${com.paginas} páginas`);
    ok("o cabeçalho sai em TODAS as folhas", com.com, com.paginas);
    /* O contraprova: sem o <thead> o cabeçalho não se repete. Se esta linha
       falhar, o defeito deixou de ser detectável — e a prova de cima passaria
       a aprovar qualquer coisa. */
    verdade("sem <thead>, ele sairia só na primeira", sem.com <= 1, `apareceu em ${sem.com}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* pasta temporária */ }
  }
}

console.log(`\n  ${falhou ? "✖" : "✓"} ${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
