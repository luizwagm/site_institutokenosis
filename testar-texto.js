/* ==========================================================================
   testar-texto.js — o texto do painel chegando na página

   Guarda um defeito que chegou à tela do cliente: a bio da diretoria aparecia
   na home e no /institucional escrita como "<p>Professor, Terapeuta…</p>",
   com o "&nbsp;" colado do Word junto. O campo tem editor no painel — grava
   HTML — e a página imprimia esse HTML com esc(), que existe justamente para
   MOSTRAR marcação, não para aplicá-la.

   Roda sem subir servidor e sem tocar em banco: recorta de server.js o bloco
   das funções de texto (de `const esc` até o fim de `soTexto`) e avalia só
   ele. Recortar em vez de exportar é de propósito — server.js sobe o site
   quando é carregado, e um teste não pode abrir porta.

     node testar-texto.js
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");

const fonte = fs.readFileSync(path.join(__dirname, "server.js"), "utf8").split("\n");
const ini = fonte.findIndex((l) => l.startsWith("const esc = "));
const fim = fonte.findIndex((l, i) => i > ini && l === "function soTexto(valor) {");
if (ini < 0 || fim < 0) {
  console.error("✖ não achei o bloco de texto em server.js — o teste precisa ser reapontado");
  process.exit(1);
}
let fecha = fim;
while (fonte[fecha] !== "}") fecha++;

const { esc, htmlLimpo, textoRico, soTexto } =
  new Function(fonte.slice(ini, fecha + 1).join("\n") + "\nreturn { esc, htmlLimpo, textoRico, soTexto };")();

let passou = 0, falhou = 0;
function ok(nome, obtido, esperado) {
  if (obtido === esperado) { passou++; return; }
  falhou++;
  console.error(`\n  ✖ ${nome}\n     esperado: ${JSON.stringify(esperado)}\n     obtido:   ${JSON.stringify(obtido)}`);
}
function contem(nome, obtido, trecho) {
  if (String(obtido).includes(trecho)) { passou++; return; }
  falhou++;
  console.error(`\n  ✖ ${nome}\n     não contém: ${JSON.stringify(trecho)}\n     obtido:     ${JSON.stringify(obtido)}`);
}
function naoContem(nome, obtido, trecho) {
  if (!String(obtido).includes(trecho)) { passou++; return; }
  falhou++;
  console.error(`\n  ✖ ${nome}\n     não podia conter: ${JSON.stringify(trecho)}\n     obtido:           ${JSON.stringify(obtido)}`);
}

/* ------------------------------------------------------------------ o defeito */
// O valor abaixo é o formato real que o editor grava — foi assim que apareceu
// na tela do cliente.
const BIO = "<p>Professor, Terapeuta ,Psicanalista Cl&iacute;nico, Acupunturista.&nbsp; "
  + "Mestre e Doutor em Psican&aacute;lise.</p>";

naoContem("bio formatada não imprime a tag", textoRico(BIO, "cartao__texto"), "&lt;p&gt;");
contem("bio formatada mantém os parágrafos", textoRico(BIO, "cartao__texto"), "<p>Professor");
contem("bio formatada leva a classe do card", textoRico(BIO, "cartao__texto"), '<div class="cartao__texto">');

/* ---------------------------------------------------------- os dois formatos */
// O conteúdo antigo é TEXTO PURO e continua sendo até alguém reabrir o campo
// no editor. Ele não pode passar a aparecer como um bloco só.
ok("texto puro vira um parágrafo", textoRico("Educador e Terapeuta.", "cartao__texto"),
   '<p class="cartao__texto">Educador e Terapeuta.</p>');
ok("texto puro quebra linha", textoRico("Linha um\nLinha dois", "c"),
   '<p class="c">Linha um<br>Linha dois</p>');
ok("vazio não deixa parágrafo órfão", textoRico("   ", "c"), "");
ok("nulo não vira 'null' na tela", textoRico(null, "c"), "");
// Sem bloco não se cria <div>: só negrito continua sendo um parágrafo.
ok("só formatação em linha continua <p>", textoRico("<b>Nome</b> e cargo", "c"),
   '<p class="c"><b>Nome</b> e cargo</p>');
// Texto puro com "&" ou "<" solto precisa ser escapado, senão o navegador tenta ler como tag.
contem("texto puro escapa o < solto", textoRico("Menor que < 5 & maior", "c"), "&lt; 5 &amp; maior");

/* ----------------------------------------------------------------- segurança */
// textoRico devolve HTML: o que ele deixa passar entra na página do site, que
// é público. A linha antiga do banco pode nunca ter passado pelo htmlLimpo.
naoContem("script não passa", textoRico("<p>oi</p><script>alert(1)</script>", "c"), "alert(1)");
naoContem("onerror não passa", textoRico('<p onerror="x()">oi</p>', "c"), "onerror");
naoContem("iframe não passa", textoRico('<iframe src="x"></iframe><p>oi</p>', "c"), "iframe");
naoContem("link javascript: não passa", textoRico('<p><a href="javascript:x()">clique</a></p>', "c"), "javascript:");
contem("link normal continua", textoRico('<p><a href="https://x.org">site</a></p>', "c"), 'href="https://x.org"');

/* ------------------------------------------------------------------ soTexto */
// Onde tag nenhuma pode entrar: <meta description>, JSON-LD, índice da busca.
ok("tira a marcação", soTexto(BIO),
   "Professor, Terapeuta ,Psicanalista Clínico, Acupunturista. Mestre e Doutor em Psicanálise.");
// Sem isto "<p>um</p><p>dois</p>" viraria "umdois" na descrição do Google.
ok("bloco vira espaço, não emenda", soTexto("<p>um</p><p>dois</p>"), "um dois");
ok("entidade numérica decodifica", soTexto("Ac&#231;&#227;o &#x21; fim"), "Acção ! fim");
ok("entidade desconhecida fica visível", soTexto("&sect; artigo"), "&sect; artigo");
// O nome de propriedade herdada não pode virar código dentro do texto.
ok("nome herdado não vaza função", soTexto("a &constructor; b"), "a &constructor; b");
ok("conteúdo do script some junto com a tag", soTexto("<script>alert(1)</script>ok"), "ok");
ok("nulo vira string vazia", soTexto(null), "");

console.log(`\n  ${falhou ? "✖" : "✔"} texto do painel: ${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
