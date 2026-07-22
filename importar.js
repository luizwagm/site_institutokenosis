/* ==========================================================================
   importar.js — extrai o conteúdo ORIGINAL do Google Sites, com os links.
   Uso: node importar.js            → grava CONTEUDO-ORIGINAL.md
        node importar.js --json     → grava conteudo-original.json

   Diferença para a primeira versão: preserva <a href> (a página de Relatórios
   é só links de documentos — sem eles a transparência não existe) e marca os
   títulos, para dar para reconstruir a hierarquia no site novo.
   ========================================================================== */
const fs = require("node:fs");

const BASE = "https://sites.google.com/view/institutokenosis";
const PAGINAS = [
  ["apresentacao", "Apresentação", "/apresentação"],
  ["institucional", "Institucional", "/institucional"],
  ["estatuto", "Estatuto Social e Ata de Eleição", "/institucional/estatuto-social-e-ata-de-eleição"],
  ["parceiros", "Parceiros", "/institucional/estatuto-social-e-ata-de-eleição/parceiros"],
  ["organograma", "Organograma", "/institucional/estatuto-social-e-ata-de-eleição/organograma"],
  ["servicos", "Serviços", "/serviços"],
  ["relatorios", "Relatórios e Prestação de Contas", "/relatórios-e-prestação-de-contas"],
  ["projetos", "Projetos", "/projetos"],
  ["memoria", "Memória Institucional", "/memória-institucional"],
  ["acoes2026", "Ações 2026", "/memória-institucional/ações-2026"],
  ["editais", "Editais", "/editais"],
  ["talentos", "Banco de Talentos", "/banco-de-talentos"],
  ["voluntariado", "Voluntariado", "/voluntariado"],
  ["contato", "Fale Conosco", "/fale-conosco"],
];

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", ndash: "–", mdash: "—",
              rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: "…", eacute: "é", oacute: "ó" };

const RODAPE = [/^Todos os direitos reservados/i, /^Google Sites/i, /^Report abuse/i,
  /^Denunciar abuso/i, /^Page updated/i, /^Página atualizada/i, /^Fazer login/i, /^Ir para o conteúdo/i];

/* Converte o HTML preservando estrutura mínima:
   ## título   · bullet   [texto](url) para links   parágrafo solto */
function extrair(html) {
  let s = html.replace(/^[^<]*?>/, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  // links viram [texto](url) ANTES de remover as tags
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, txt) => {
    const limpo = txt.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!limpo) return " ";
    if (/^(javascript:|#)/i.test(href)) return limpo;
    return `[${limpo}](${href})`;
  });

  s = s
    .replace(/<h([1-6])[^>]*>/gi, "\n@@H$1@@ ")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|li|tr|section|article|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z#0-9]+);/gi, (m, e) => ENT[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCharCode(+e.slice(1)) : m));

  let linhas = s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean);

  const corte = linhas.findIndex((l) => RODAPE.some((re) => re.test(l)));
  if (corte > 0) linhas = linhas.slice(0, corte);

  const vistos = new Set();
  linhas = linhas.filter((l) => { const k = l.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; });

  const MENU = new Set(PAGINAS.map(([, n]) => n.toLowerCase()).concat(["instituto kenósis", "instituto kénosis"]));
  linhas = linhas.filter((l) => !MENU.has(l.replace(/^@@H\d@@ /, "").toLowerCase()));

  return linhas.map((l) => l.replace(/^@@H(\d)@@ /, (m, n) => "#".repeat(Math.min(+n + 1, 6)) + " "));
}

function principal(html) {
  const m = /role="main"([\s\S]*?)(?:<footer|role="contentinfo"|<\/body)/i.exec(html);
  return m ? m[1] : html;
}

(async () => {
  const saida = {};
  const md = [
    "# Instituto Kenósis — conteúdo ORIGINAL do site atual",
    "", `Origem: ${BASE}`, `Capturado em: ${new Date().toISOString().slice(0, 10)}`, "",
    "> Texto integral, sem resumo. Links preservados no formato [texto](url).", "",
  ];

  for (const [chave, nome, caminho] of PAGINAS) {
    const url = BASE + encodeURI(caminho);
    process.stdout.write(`  ${nome.padEnd(34)} `);
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (importador do proprio site)" } });
      if (!r.ok) { console.log(`HTTP ${r.status}`); continue; }
      const linhas = extrair(principal(await r.text()));
      saida[chave] = { nome, url, linhas };
      const links = linhas.join("\n").match(/\]\(https?:/g)?.length || 0;
      md.push(`\n---\n\n## ${nome}\n\n\`${url}\`\n\n${linhas.join("\n")}\n`);
      console.log(`${linhas.join("").length} chars · ${linhas.length} linhas · ${links} links`);
    } catch (e) { console.log("ERRO:", e.message); }
  }

  fs.writeFileSync("CONTEUDO-ORIGINAL.md", md.join("\n"));
  fs.writeFileSync("conteudo-original.json", JSON.stringify(saida, null, 2));
  console.log(`\n  → CONTEUDO-ORIGINAL.md e conteudo-original.json`);
})();
