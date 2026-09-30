/* ==========================================================================
   testar-tabelas.js — no computador, a tabela cabe no cartão (1.36.0)

   O QUE ESTA SUÍTE GUARDA

   O pedido do Instituto: a tabela "ajustada perfeitamente às colunas", sem
   barra horizontal, em toda tabela vista em computador — a da ATA primeiro.

   Barra lateral não dá erro, não aparece no teste de API e só se vê com a
   janela num tamanho específico (notebook com zoom de 125–150%, lateral
   aberta). Por isso a prova é MEDIDA num navegador de verdade, e não lida
   no código: o Chrome abre uma página de ensaio montada com o CSS e o código
   de ajuste TIRADOS DO app.html (nada de cópia que envelhece), com as três
   tabelas que mais apertam —

     · a lista de presença da ATA (nome, CPF, nº, assinatura);
     · a folha de FREQUÊNCIA (dez colunas de dia);
     · uma linha de AUDITORIA com uma "palavra" de 200 letras (e-mail, link
       ou código colado fazem o mesmo) e uma coluna de data;
     · uma LISTA comum com um link colado no título e a data sem proteção —
       a data tem de continuar inteira (a sabotagem que só ela pega);

   em três larguras de cartão: 1015px (tela de 1366), 711px (1024) e 550px
   (janela logo acima de 860px com a lateral aberta — o pior caso).

   E confere que o ajuste não estraga o que já estava certo: CPF e data numa
   linha só, e o dia da frequência ainda cabendo no campo.

   Sem Chrome a seção 2 é pulada e diz que foi.

     node testar-tabelas.js
     TABELAS_APP=<outro app.html> node testar-tabelas.js   (sabotagem)
   ========================================================================== */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP = process.env.TABELAS_APP || path.join(__dirname, "restrito", "app.html");
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

console.log("\n  ══ TABELAS — no computador, sem barra lateral ══\n");

/* ==========================================================================
   1. O CÓDIGO
   ========================================================================== */
console.log("  1. o que a medição sozinha não explicaria");

/* Estilo inline vence qualquer folha: com a largura mínima no `style=` da
   célula, a regra do computador não conseguiria soltá-la. */
verdade("o Nome da ata e da frequência não tem largura mínima inline",
  !/<th style="[^"]*min-width:220px[^"]*">Nome/.test(html));
verdade("a Assinatura da ata não tem largura mínima inline",
  !/<th style="[^"]*min-width:240px[^"]*">Assinatura/.test(html));

/* Regra de @media no meio do <style> perde por ORDEM para o que vem depois —
   sem aviso. O bloco do computador tem de ser o último. */
const estilo = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1];
const ultimaMedia = estilo.lastIndexOf("@media");
verdade("o bloco do computador é o último @media do <style>",
  ultimaMedia >= 0 && /^@media \(hover:hover\) and \(pointer:fine\)/.test(estilo.slice(ultimaMedia)));

/* O celular continua rolando de lado: ali espremer coluna deixa ilegível. */
verdade("o celular mantém a tabela na largura do conteúdo",
  /table\{min-width:max-content\}/.test(estilo));

const iniJs = html.indexOf("const TELA_PC");
const fimJs = html.indexOf("function navEstreito");
verdade("o ajuste de tabelas existe no script", iniJs > 0 && fimJs > iniJs);
const codigoAjuste = iniJs > 0 && fimJs > iniJs ? html.slice(iniJs, fimJs) : "";

/* ==========================================================================
   2. MEDIDO NO NAVEGADOR
   ========================================================================== */
console.log("\n  2. medido no navegador");

function acharChrome() {
  const candidatos = [
    process.env.CHROME,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
  ].filter(Boolean);
  return candidatos.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || "";
}

const LARGURAS = [1015, 711, 550];
const NOMES = ["ZZ QA Maria Aparecida dos Santos Albuquerque de Oliveira", "ZZ QA João",
  "ZZ QA Convidado com nome bem comprido para testar a quebra", "ZZ QA Francisco"];

/* A marcação é a MESMA que pintarAta() e pintarFrequencia() produzem. */
function tabelaAta() {
  return `<table class="freq-tab"><thead><tr><th class="col-nome" style="text-align:left">Nome</th><th>CPF</th><th>Nº</th>`
    + `<th class="col-assinatura">Assinatura</th><th style="width:2.4rem"></th></tr></thead><tbody>`
    + NOMES.map((n, i) => `<tr><td>${n}</td><td class="c-inteiro">123.456.789-00</td>`
      + `<td class="freq-num">0${i + 1}</td><td class="freq-cel"></td>`
      + `<td style="text-align:center"><input type="checkbox" class="freq-sel"></td></tr>`).join("")
    + `</tbody></table>`;
}
function tabelaFreq() {
  const dias = ["01", "03", "08", "10", "15", "17", "22", "24", "29", "30"]
    .map((d) => `<th class="freq-dia"><input maxlength="2" value="${d}"></th>`).join("");
  return `<table class="freq-tab"><thead><tr><th class="col-nome" style="text-align:left">Nome</th><th>CPF</th><th>Nº</th>`
    + `${dias}<th style="width:2.4rem"></th></tr></thead><tbody>`
    + NOMES.map((n, i) => `<tr><td>${n}</td><td class="c-inteiro">123.456.789-00</td><td class="freq-num">0${i + 1}</td>`
      + `<td class="freq-cel"></td>`.repeat(10) + `<td><input type="checkbox" class="freq-sel"></td></tr>`).join("")
    + `</tbody></table>`;
}
function tabelaAuditoria() {
  return `<table id="au-tabela"><thead><tr><th>Data / hora</th><th>Usuário</th><th>Ação</th><th>O que foi feito</th></tr></thead><tbody>`
    + `<tr><td class="au-quando c-data">29/09/2026 14:30</td><td>ZZ QA</td><td>editar</td><td class="au-resumo">${"T".repeat(200)}</td></tr>`
    + `<tr><td class="au-quando c-data">28/09/2026 09:05</td><td>ZZ QA</td><td>criar</td><td class="au-resumo">criou a ata de reunião</td></tr>`
    + `</tbody></table>`;
}
/* Uma lista comum (como Documentos), com a data SEM proteção nenhuma e um
   link colado no título. É o caso que prova o degrau 2 cirúrgico: se a
   quebra no meio da palavra valesse para a tabela INTEIRA, o algoritmo de
   tabela encolheria também a coluna da data, e "29/09/2026" sairia partido. */
function tabelaLista() {
  const link = "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  return `<table><thead><tr><th>Data</th><th>Título</th><th>Usuário</th><th>Situação</th></tr></thead><tbody>`
    + `<tr><td class="c-data">29/09/2026</td><td>Prestação de contas ${link}</td><td>ZZ QA Maria Aparecida dos Santos</td><td>Ativo</td></tr>`
    + `<tr><td class="c-data">28/09/2026</td><td>Ofício à prefeitura</td><td>ZZ QA João</td><td>Ativo</td></tr>`
    + `</tbody></table>`;
}

const chrome = acharChrome();
if (!chrome) {
  console.log("    · pulado: não achei o Chrome nesta máquina (defina CHROME=<caminho> para rodar)");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kenosis-tabelas-"));
  try {
    const blocos = [];
    for (const w of LARGURAS) {
      for (const [nome, tab] of [["ata", tabelaAta()], ["frequência", tabelaFreq()], ["auditoria", tabelaAuditoria()], ["lista", tabelaLista()]]) {
        blocos.push(`<div class="card" data-caso="${nome} em ${w}px" style="width:${w}px;padding:0;overflow:auto">${tab}</div>`);
      }
    }
    /* A página abre em 1400px: acima dos 860px do celular, para o que se
       mede ser o CARTÃO estreito, e não a regra de celular. */
    const pagina = `<!doctype html><html><head><meta charset="utf-8"><style>${estilo}
      body{display:block}</style></head><body>
      ${blocos.join("\n")}
      <pre id="resultado"></pre>
      <script>${codigoAjuste}
      ajustarTabelas();
      const linhas = (el) => { const r = document.createRange(); r.selectNodeContents(el);
        return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; };
      document.getElementById("resultado").textContent = JSON.stringify({
        pc: typeof TELA_PC !== "undefined" && TELA_PC.matches,
        casos: [...document.querySelectorAll(".card[data-caso]")].map((c) => {
          const t = c.querySelector("table");
          return {
            caso: c.dataset.caso,
            sobra: c.scrollWidth - c.clientWidth,
            cpf: Math.max(0, ...[...c.querySelectorAll("td.c-inteiro")].map(linhas)),
            data: Math.max(0, ...[...c.querySelectorAll("td.c-data")].map(linhas)),
            diaCortado: [...c.querySelectorAll(".freq-dia input")].some((i) => i.scrollWidth > i.clientWidth + 1),
            degrau: t.classList.contains("tab-minima") ? 4 : t.classList.contains("tab-compacta") ? 3
              : t.classList.contains("tab-aperta") ? 2 : 1,
          };
        }),
      });
      </script></body></html>`;
    const arq = path.join(tmp, "tabelas.html");
    fs.writeFileSync(arq, pagina);
    const r = spawnSync(chrome, ["--headless", "--disable-gpu", "--window-size=1400,900",
      "--virtual-time-budget=4000", "--dump-dom", arq], { timeout: 120000, encoding: "utf8" });
    const m = /<pre id="resultado">([\s\S]*?)<\/pre>/.exec(r.stdout || "");
    let res = null;
    try { res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")); } catch { /* abaixo */ }
    verdade("o navegador devolveu a medição", res, (r.stderr || "").slice(-400));
    if (res) {
      verdade("o navegador conta como COMPUTADOR (mouse)", res.pc);
      for (const c of res.casos) {
        verdade(`${c.caso}: cabe no cartão, sem barra lateral`, c.sobra <= 1, `passa ${c.sobra}px (degrau ${c.degrau})`);
        if (c.cpf) verdade(`${c.caso}: o CPF numa linha só`, c.cpf === 1, `${c.cpf} linhas`);
        if (c.data) verdade(`${c.caso}: a data numa linha só`, c.data === 1, `${c.data} linhas`);
        if (/frequência/.test(c.caso)) verdade(`${c.caso}: o dia ainda cabe no campo`, !c.diaCortado);
      }
      /* Contraprova: no cartão largo, a ata não precisa de ajuste nenhum. Se
         passasse a subir degrau ali, o ajuste estaria mexendo em tabela que
         já cabia. */
      const larga = res.casos.find((c) => c.caso === "ata em 1015px");
      ok("a ata no cartão largo fica natural (nenhum degrau)", larga && larga.degrau, 1);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* pasta temporária */ }
  }
}

console.log(`\n  ${falhou ? "✖" : "✓"} ${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
