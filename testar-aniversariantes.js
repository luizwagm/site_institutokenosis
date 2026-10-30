/* ==========================================================================
   testar-aniversariantes.js — Usuários em ordem alfabética, aniversariantes
   do mês (restrito 1.39.0) e o motivo da recusa do envio de vídeo (2.17.2)

   Esta suíte NÃO toca no banco: lê os arquivos da tela e exercita as funções
   PURAS tiradas de dentro deles. Pode rodar a qualquer hora, inclusive com o
   sistema no ar.

     node testar-aniversariantes.js
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const APP = fs.readFileSync(path.join(__dirname, "restrito", "app.html"), "utf8");
const ADMIN = fs.readFileSync(path.join(__dirname, "admin", "index.html"), "utf8");
const NGINX_NOVO = fs.readFileSync(path.join(__dirname, "nginx", "liberar-envios.sh"), "utf8");
const NGINX_CRIAR = fs.readFileSync(path.join(__dirname, "nginx", "criar-site.sh"), "utf8");

let passou = 0, falhou = 0;
function ok(nome, real, esperado) {
  if (JSON.stringify(real) === JSON.stringify(esperado)) { passou++; console.log(`    ✓ ${nome}`); return; }
  falhou++;
  console.log(`    ✖ ${nome}\n        esperado: ${JSON.stringify(esperado)}\n        obtido:   ${JSON.stringify(real)}`);
}
const verdade = (nome, cond) => ok(nome, !!cond, true);

/* O corpo de `function nome(...){ ... }` como está no arquivo: do cabeçalho
   até a primeira chave que fecha na coluna 0. */
function fonteDe(texto, nome) {
  const i = texto.indexOf(`function ${nome}(`);
  if (i < 0) return null;
  const f = texto.indexOf("\n}", i);
  return f < 0 ? null : texto.slice(i, f + 2);
}

console.log("\n  ══ USUÁRIOS — ordem alfabética e aniversariantes ══\n");

/* ==========================================================================
   1. A lista de Usuários em ordem alfabética
   ========================================================================== */
console.log("  1. a lista de Usuários sai em ordem alfabética");

const linhaAlfa = /const ALFA = (new Intl\.Collator\([^;]+\)\.compare);/.exec(APP);
verdade("existe o comparador ALFA (Intl.Collator pt-BR)", linhaAlfa && /"pt-BR"/.test(linhaAlfa[1]));
const ALFA = linhaAlfa ? eval(linhaAlfa[1]) : (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const carregar = fonteDe(APP, "carregarLista") || "";
verdade("carregarLista ordena quando o módulo é pacientes",
  /if\(MOD==="pacientes"\) LISTA\.sort\(\(a,b\)=>ALFA\(a\.nome,b\.nome\)/.test(carregar));
/* A ordem que a equipe espera: acento e caixa NÃO mudam a posição. A colação
   comum do banco (e o sort() cru do JS) põe "Álvaro" depois de "Zeca". */
const nomes = ["Zeca", "álvaro", "Bruno", "Ana", "Élida", "ana Clara", "Ângela"];
ok("acento e caixa não mudam a posição",
  nomes.slice().sort(ALFA), ["álvaro", "Ana", "ana Clara", "Ângela", "Bruno", "Élida", "Zeca"]);
verdade("…ao contrário do sort() comum (a prova distingue)",
  JSON.stringify(nomes.slice().sort()) !== JSON.stringify(nomes.slice().sort(ALFA)));

/* ==========================================================================
   2. O botão e a tela
   ========================================================================== */
console.log("\n  2. o botão 🎂 na tela de Usuários e a tela própria");

verdade("o botão Aniversariantes existe no topo da lista",
  /<button[^>]*id="mod-aniv"[^>]*onclick="abrirAniversariantes\(\)"[^>]*hidden>/.test(APP));
verdade("…e só aparece no módulo Usuários (pacientes)",
  /\$\("#mod-aniv"\)\.hidden = MOD !== "pacientes";/.test(fonteDe(APP, "mostrarModulo") || ""));
verdade("a tela #pane-aniv existe, com filtro, números e tabela",
  /<section class="panel" id="pane-aniv">[\s\S]*?id="aniv-filtro"[\s\S]*?id="aniv-stats"[\s\S]*?id="aniv-tabela"[\s\S]*?<\/section>/.test(APP));
verdade("a tela tem Voltar para Usuários e Imprimir relação",
  /id="pane-aniv">[\s\S]*?voltarDosAniversariantes\(\)[\s\S]*?imprimirAniversariantes\(\)[\s\S]*?<\/section>/.test(APP));
verdade("ao abrir, a tela lê a lista de usuários do servidor",
  /api\("pacientes"\)/.test(fonteDe(APP, "abrirAniversariantes") || ""));

/* ==========================================================================
   3. Quem entra na relação (função pura)
   ========================================================================== */
console.log("\n  3. quem entra na relação do mês");

const src = fonteDe(APP, "aniversariantesDoMes");
verdade("a função aniversariantesDoMes existe", src);
const doMes = src ? new Function("ALFA", src + "\nreturn aniversariantesDoMes;")(ALFA) : () => [];

const pessoas = [
  { id: 1, nome: "Zeca", nascimento: "1990-10-05" },
  { id: 2, nome: "Ana", nascimento: "1985-10-05" },
  { id: 3, nome: "Bruno", nascimento: "2000-10-31" },
  { id: 4, nome: "Carla", nascimento: "1970-11-01" },     // outro mês
  { id: 5, nome: "Davi", nascimento: "" },                // sem data
  { id: 6, nome: "Élida", nascimento: "2010-10-01" },
  { id: 7, nome: "Fábio", nascimento: "05/10/1990" },     // texto torto: não entra
  { id: 8, nome: "Gil", nascimento: null },
];
const out = doMes(pessoas, 10, 2026);
ok("só quem nasceu no mês, por DIA e depois por nome",
  out.map((x) => x.nome), ["Élida", "Ana", "Zeca", "Bruno"]);
ok("o dia sai como número", out.map((x) => x.dia), [1, 5, 5, 31]);
ok("a idade é a que COMPLETA no ano pedido", out.map((x) => x.completa), [16, 41, 36, 26]);
ok("o mês vem também como texto (\"10\" do <select>)", doMes(pessoas, "10", 2026).length, 4);
ok("novembro tem só a Carla", doMes(pessoas, 11, 2026).map((x) => x.nome), ["Carla"]);
ok("29/02 entra em fevereiro mesmo em ano que não é bissexto",
  doMes([{ id: 9, nome: "Hugo", nascimento: "2004-02-29" }], 2, 2027).map((x) => [x.dia, x.completa]), [[29, 23]]);
ok("lista vazia ou ausente não quebra", [doMes([], 1, 2026).length, doMes(undefined, 1, 2026).length], [0, 0]);
ok("não altera a lista de quem chamou", pessoas.map((x) => x.dia), pessoas.map(() => undefined));

const idade = /const anivIdade = ([^\n]+);/.exec(APP);
const anivIdade = idade ? eval(idade[1]) : () => "";
ok("idade escrita: 1 ano, 36 anos, e nada para quem nasceu este ano",
  [anivIdade({ completa: 1 }), anivIdade({ completa: 36 }), anivIdade({ completa: 0 })], ["1 ano", "36 anos", "—"]);

verdade("a situação começa em ATIVOS", /let ANIV = \{ lista: \[\], mes: 0, situacao: "1" \};/.test(APP));
verdade("tela e impressão leem a MESMA seleção (anivVisiveis)",
  /anivVisiveis\(\)/.test(fonteDe(APP, "pintarAniversariantes") || "") &&
  /anivVisiveis\(\)/.test(fonteDe(APP, "imprimirAniversariantes") || ""));
verdade("Ativos filtra pelo mesmo estaAtivo da lista de Usuários",
  /ANIV\.situacao==="1" \? ANIV\.lista\.filter\(estaAtivo\)/.test(fonteDe(APP, "anivVisiveis") || ""));
const trocar = fonteDe(APP, "trocarMesAniv") || "";
const virar = new Function("ANIV", "pintarAniversariantes", trocar + "\nreturn trocarMesAniv;");
const est = { mes: 1 };
const tm = virar(est, () => {});
tm(0); const antes = est.mes; tm(13); const depois = est.mes;
ok("‹ de janeiro vai a dezembro, › de dezembro volta a janeiro", [antes, depois], [12, 1]);

/* ==========================================================================
   4. A impressão segue as regras do sistema
   ========================================================================== */
console.log("\n  4. a impressão segue as regras das outras");

const imp = fonteDe(APP, "imprimirAniversariantes") || "";
verdade("usa o timbre do sistema (abrirImpressao)", /abrirImpressao\(/.test(imp));
verdade("o cabeçalho das colunas está dentro de <thead> (repete em toda folha)",
  /<table class="m"><thead><tr>[\s\S]*?<\/tr><\/thead><tbody>/.test(imp));
const larg = [...(/<thead>([\s\S]*?)<\/thead>/.exec(imp) || ["", ""])[1].matchAll(/width:(\d+)%/g)].map((m) => Number(m[1]));
ok("são 5 colunas com largura declarada", larg.length, 5);
ok("…que somam 100 (table-layout fixo)", larg.reduce((a, b) => a + b, 0), 100);
verdade("nada para imprimir avisa em vez de abrir folha em branco", /if\(!d\.length\) return toast\(/.test(imp));
verdade("o texto que vem do cadastro passa por escA", /escA\(x\.nome\)/.test(imp) && /escA\(x\.telefone/.test(imp));

/* ==========================================================================
   5. Envio de vídeo: o motivo da recusa (site 2.17.2)
   ========================================================================== */
console.log("\n  5. envio de vídeo — o painel diz o motivo, e o nginx deixa passar");

const mot = fonteDe(ADMIN, "motivoDaRecusa");
verdade("o painel tem motivoDaRecusa", mot);
const motivo = mot ? new Function(mot + "\nreturn motivoDaRecusa;")() : () => "";
ok("o JSON da aplicação vem primeiro", motivo({ status: 400 }, { error: "Formato não aceito." }, "x"), "Formato não aceito.");
verdade("413 do nginx (HTML, sem JSON) vira aviso de TAMANHO", /maior do que o servidor aceita/.test(motivo({ status: 413 }, {}, "x")));
verdade("401 vira aviso de sessão", /sessão terminou/i.test(motivo({ status: 401 }, {}, "x")));
verdade("502/504 vira servidor reiniciando", /reiniciando/.test(motivo({ status: 504 }, {}, "x")));
ok("outro código diz qual foi", motivo({ status: 500 }, {}, "Não consegui enviar o vídeo"), "Não consegui enviar o vídeo (código 500).");
const pick = fonteDe(ADMIN, "pickVideo") || "";
verdade("o envio do vídeo da capa usa o motivo", /motivoDaRecusa\(xhr, r, "Não consegui enviar o vídeo"\)/.test(pick));
verdade("…e barra antes de enviar o que passa do limite", /file\.size > VIDEO_MAX_MB \* 1048576/.test(pick));
verdade("o envio do carrossel/anexos também usa o motivo",
  /motivoDaRecusa\(xhr, r,/.test(fonteDe(ADMIN, "enviarBinario") || ""));
const vmax = /const VIDEO_MAX = Number\(process\.env\.VIDEO_MAX_MB \|\| (\d+)\)/.exec(fs.readFileSync(path.join(__dirname, "server.js"), "utf8"));
const vpainel = /const VIDEO_MAX_MB = (\d+);/.exec(ADMIN);
ok("o limite do painel é o mesmo do servidor", vpainel && vpainel[1], vmax && vmax[1]);
/* 2.17.3: o cliente tem vídeo de 68 MB e pediu "acima de 100 MB". */
ok("o limite do vídeo é de 300 MB (o de 120 já não bastava)", Number(vmax && vmax[1]), 300);
verdade("nenhum teto de 120 MB esquecido no painel", !/120 \* 1024 \* 1024|até 120 MB|limite é 120 MB/.test(ADMIN));
/* O Node corta pedido que dure mais de 5 min (requestTimeout padrão): um
   vídeo grande em upload lento seria cortado no meio, depois do nginx liberar. */
const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const rt = /servidor\.requestTimeout = (\d+) \* 60 \* 1000;/.exec(SERVER);
verdade("o prazo do Node para um pedido passa de 5 min (vídeo grande em upload lento)", rt && Number(rt[1]) >= 20);

const tetoNovo = /^TETO="(\d+)m"$/m.exec(NGINX_NOVO);
const prazoNovo = /^PRAZO="(\d+)s"$/m.exec(NGINX_NOVO);
for (const [nome, txt] of [["liberar-envios.sh", NGINX_NOVO], ["criar-site.sh", NGINX_CRIAR]]) {
  const bloco = /location ~ \^\/api\/upload-\(video\|pdf\)\\?\$ \{([\s\S]*?)\n    \}/.exec(txt);
  verdade(`${nome}: tem o location das duas rotas de envio`, bloco);
  const corpo = bloco ? bloco[1] : "";
  const mb = /client_max_body_size\s+(\d+)m;/.exec(corpo) || (/__TETO__/.test(corpo) && tetoNovo);
  verdade(`${nome}: o teto do bloco passa do limite do vídeo`, mb && Number(mb[1]) > Number(vmax && vmax[1]));
  const prazo = /proxy_read_timeout\s+(\d+)s;/.exec(corpo) || (/__PRAZO__/.test(corpo) && prazoNovo);
  verdade(`${nome}: prazo de pelo menos 20 min no envio`, prazo && Number(prazo[1]) >= 1200);
  verdade(`${nome}: o bloco termina na marca de fim`, /\n    \}\n    (# kenosis: fim dos envios grandes|__FIM_BLOCO__)\n/.test(txt));
  verdade(`${nome}: corpo em fluxo (proxy_request_buffering off)`, /proxy_request_buffering off;/.test(corpo));
  verdade(`${nome}: repassa X-Forwarded-Proto e X-Forwarded-For`,
    /X-Forwarded-Proto/.test(corpo) && /X-Forwarded-For/.test(corpo));
}
verdade("liberar-envios.sh devolve a cópia quando o nginx -t recusa",
  /if ! nginx -t[\s\S]*?cp "\$COPIA" "\$ARQ"/.test(NGINX_NOVO));
verdade("liberar-envios.sh usa heredoc entre aspas (nada expandido pelo shell)", /<<'FIM'/.test(NGINX_NOVO));
/* A 2.17.2 parava em "já está lá" e deixava o teto antigo: rodar de novo
   tem de TROCAR o bloco, não sair. */
verdade("liberar-envios.sh troca um bloco anterior em vez de sair", !/nada a fazer/.test(NGINX_NOVO) &&
  /index\(\$0, ini\) \{ pulando = 1; next \}/.test(NGINX_NOVO));
verdade("liberar-envios.sh acha o vhost pelo server_name quando o arquivo tem outro nome",
  /grep -lE "server_name[^"]*\$DOMINIO/.test(NGINX_NOVO));
const provaMb = /head -c \$\(\((\d+) \* 1024 \* 1024\)\)/.exec(NGINX_NOVO);
verdade("a prova do script envia mais de 100 MB", provaMb && Number(provaMb[1]) > 100);
verdade("liberar-envios.sh está com fim de linha LF", !NGINX_NOVO.includes("\r"));

console.log(`\n  ${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
