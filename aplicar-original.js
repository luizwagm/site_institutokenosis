/* ==========================================================================
   aplicar-original.js — grava no banco o texto ORIGINAL do site atual.
   Uso: node aplicar-original.js

   Rode UMA VEZ, logo depois do primeiro boot. Ele APAGA e regrava serviços e
   documentos e sobrescreve os textos — se rodar depois que o cliente editou
   algo pelo painel, o trabalho dele se perde. Por isso, com o conteúdo já
   aplicado, o script se recusa a rodar sem --forcar.

   Por que derivar do JSON em vez de digitar: na primeira tentativa eu
   transcrevi à mão e acabei parafraseando. Aqui o texto sai literalmente de
   conteudo-original.json, capturado do HTML. Se o original mudar, roda de novo.
   ========================================================================== */
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

/* Quem cria as tabelas é o primeiro boot do server.js. Rodar este script antes
   disso não dá um erro compreensível: o DatabaseSync cria um site.db VAZIO sem
   avisar e a primeira consulta estoura com "no such table". */
const BANCO = "data/site.db";
const existia = fs.existsSync(BANCO);
const db = new DatabaseSync(BANCO);
const tabelas = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
if (!tabelas.has("documentos") || !tabelas.has("settings")) {
  db.close();
  if (!existia) fs.unlinkSync(BANCO);   // não deixa para trás o arquivo vazio que acabei de criar
  console.error("\n  O banco ainda não tem as tabelas — o site nunca subiu neste servidor.");
  console.error("  Quem as cria é o primeiro boot do server.js. Faça nesta ordem:\n");
  console.error("    sudo systemctl start kenosis.service");
  console.error("    systemctl status kenosis.service      # precisa estar 'active (running)'");
  console.error("    node aplicar-original.js\n");
  console.error("  Se o serviço não sobe, veja o motivo em:  journalctl -u kenosis.service -n 50\n");
  process.exit(1);
}

// documento cadastrado = conteúdo original já aplicado (o seed não cria nenhum)
const jaAplicado = db.prepare("SELECT COUNT(*) c FROM documentos").get().c > 0;
if (jaAplicado && !process.argv.includes("--forcar")) {
  console.error("\n  O conteúdo original JÁ foi aplicado neste banco.");
  console.error("  Rodar de novo apaga serviços e documentos e sobrescreve os textos —");
  console.error("  inclusive o que tiver sido editado pelo painel.");
  console.error("\n  Se é isso mesmo que você quer:  node aplicar-original.js --forcar\n");
  process.exit(1);
}
const orig = JSON.parse(fs.readFileSync("conteudo-original.json", "utf8"));
const setS = (k, v) => db.prepare(
  "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));

const L = (chave) => orig[chave].linhas;
const semMarca = (l) => l.replace(/^#{1,6}\s*/, "").trim();
/* o Google Sites deixa espaço antes da pontuação por causa das tags de negrito */
const PALAVRAS_DE_UMA_LETRA = new Set(["a", "e", "o", "à", "é", "ó", "y", "u", "A", "E", "O", "À", "É"]);
const limpar = (s) => semMarca(s)
  // o importador marca com @@H2@@ os títulos que o Google Sites deixou vazios;
  // são separadores visuais sem texto, não entram no conteúdo
  .replace(/@@[A-Z0-9]+@@/g, " ")
  .replace(/\s+([,.;:!?])/g, "$1")
  // o Google Sites parte palavras quando abre <b> no meio delas: "R elatório",
  // "o s resultados". Junta a letra solta que não é palavra de verdade.
  .replace(/(^|[\s\-–])([A-Za-zÀ-ÿ]) ([a-zà-ÿ]{2,})/g,
    (m, antes, letra, resto) => PALAVRAS_DE_UMA_LETRA.has(letra) ? m : `${antes}${letra}${resto}`)
  .replace(/\s{2,}/g, " ").trim();

/* Pega o trecho entre dois marcos, exclusivo nas pontas */
function entre(linhas, de, ate) {
  const i = linhas.findIndex((l) => new RegExp(de, "i").test(semMarca(l)));
  const j = ate ? linhas.findIndex((l, k) => k > i && new RegExp(ate, "i").test(semMarca(l))) : linhas.length;
  return linhas.slice(i + 1, j < 0 ? linhas.length : j).map(limpar).filter(Boolean);
}

/* ------------------------------ APRESENTAÇÃO ----------------------------- */
const ap = L("apresentacao");
const quemSomos = ap.slice(1, 4).map(limpar);                       // 3 parágrafos de abertura
const missao = entre(ap, "^MISSÃO$", "^VISÃO$").join(" ");
const visao = entre(ap, "^VISÃO$", "^VALORES$").join(" ");
const valores = entre(ap, "^VALORES$", "^NOSSA ATUAÇÃO$").map((l) => l.replace(/^•\s*/, ""));
const atuacao = entre(ap, "^NOSSA ATUAÇÃO$", "^NOSSO COMPROMISSO$");
const compromisso = entre(ap, "^NOSSO COMPROMISSO$", "^Mensagem do Presidente$");
const fundador = entre(ap, "^Conheça o Fundador e Presidente\\.$", "^\"Servir é transformar");
const fraseFinal = ap.find((l) => /^"Servir é transformar/.test(semMarca(l)));
const fraseMsg = ap.find((l) => /^"Cuidar das pessoas/.test(semMarca(l)));

setS("sec_inst_texto", quemSomos.join("\n\n"));
setS("mvv_missao", missao);
setS("mvv_visao", visao);
setS("mvv_valores", valores.join(" · ") + ".");
setS("inst_valores", JSON.stringify(atuacao.filter((l) => /^✅/.test(l)).map((l) => l.replace(/^✅\s*/, ""))));
setS("rodape_frase", limpar(fraseMsg || "").replace(/^"|"$/g, ""));
setS("hero_titulo", "Servir é <em>transformar vidas</em>.");
setS("hero_texto", quemSomos[0]);

/* texto integral da página institucional */
setS("pg_inst_conteudo", [
  "## Quem somos", ...quemSomos,
  "## Nossa atuação", ...atuacao,
  "## Nosso compromisso", ...compromisso,
  "## Mensagem do Presidente",
  `> ${limpar(fraseMsg || "")}`,
  "Dr. Prof. Ronalldo J. Menezes — Fundador e Presidente do Instituto Kenósis Fonte das Graças Conceição & Menezes",
  "## Conheça o Fundador e Presidente", ...fundador,
  `> ${limpar(fraseFinal || "")}`,
].join("\n\n"));

/* --------------------------------- SERVIÇOS ------------------------------ */
const sv = L("servicos");
const introServ = sv.slice(1, 4).map(limpar).filter((l) => !/^Serviços Oferecidos/.test(l));
setS("pg_serv_texto", introServ[0] || "");
setS("pg_serv_intro", introServ.join("\n\n"));
setS("sec_serv_sub", introServ[0] || "");
const obsServ = sv.find((l) => /^Observação:/.test(semMarca(l)));
setS("pg_serv_observacao", limpar(obsServ || ""));

/* a lista original é categorizada — reproduz exatamente assim */
const CATS = ["Assistência Social", "Saúde Integrativa", "Serviços e Projetos em Implantação"];
db.exec("DELETE FROM services");
let ordem = 0;
for (let c = 0; c < CATS.length; c++) {
  const itens = entre(sv, `^${CATS[c]}$`, CATS[c + 1] ? `^${CATS[c + 1]}$` : "^Observação:")
    .filter((l) => /^•/.test(l))
    .map((l) => l.replace(/^•\s*/, "").replace(/[;.]$/, ""));
  for (const it of itens) {
    db.prepare("INSERT INTO services(title,slug,text,content,categoria,sort) VALUES(?,?,'','',?,?)")
      .run(it, "", CATS[c], ordem++);
  }
  console.log(`  ${CATS[c]}: ${itens.length} itens`);
}

/* ------------------------------ TRANSPARÊNCIA ---------------------------- */
const rel = L("relatorios");
setS("pg_transp_texto", limpar(rel[1] || ""));
setS("pg_transp_intro", [limpar(rel[1] || ""), limpar(rel[2] || "")].filter(Boolean).join("\n\n"));
const obsRel = rel.slice(rel.findIndex((l) => /^Observação$/i.test(semMarca(l))) + 1).map(limpar).filter(Boolean);
setS("pg_transp_observacao", obsRel.join("\n\n"));
setS("sec_transp_sub", limpar(rel[2] || ""));

/* documentos: título numerado + descrição + link do Drive */
db.exec("DELETE FROM documentos");
let atual = null, docs = 0;
for (const bruto of rel) {
  const l = limpar(bruto);
  const tit = /^(\d+)\s*-\s*(.+)$/.exec(l);
  if (tit) { atual = { title: tit[2].replace(/\s+/g, " ").trim(), desc: [], url: "" }; continue; }
  if (!atual) continue;
  const link = /\]\((https?:\/\/[^)]+)\)/.exec(bruto);
  if (link) {
    atual.url = link[1];
    const ano = /(\d{4})(?:\D|$)/.exec(atual.title);
    db.prepare("INSERT INTO documentos(title,tipo,ano,url,sort) VALUES(?,?,?,?,?)")
      .run(atual.title, atual.desc.join(" ").slice(0, 300), ano ? ano[1] : "", atual.url, docs);
    docs++; atual = null;
    continue;
  }
  if (!/^Clique abaixo/i.test(l)) atual.desc.push(l);
}
console.log(`  documentos com link: ${docs}`);

/* -------------------------------- PROJETOS ------------------------------- */
const pj = L("projetos");
/* Cada projeto abre com "Projeto Socioassistencial ..." — esse é o marco real.
   Buscar pelo nome solto não funciona: ele reaparece dentro do próprio texto. */
const marcos = pj.map((l, i) => ({ i, t: semMarca(l) }))
  .filter((x) => /^Projeto Socioassistencial/i.test(x.t));

const intro = pj.slice(1, marcos[0]?.i ?? 1).map(limpar).filter(Boolean);
setS("pg_proj_texto", intro[0] || "");
setS("pg_proj_intro", intro.join("\n\n"));
setS("sec_proj_sub", intro[0] || "");

marcos.forEach((m, k) => {
  const fim = marcos[k + 1]?.i ?? pj.length;
  const corpo = pj.slice(m.i + 1, fim).map(limpar).filter(Boolean);

  /* separa os campos estruturados do corpo livre, para o layout usar cada um */
  const acha = (re) => {
    const a = corpo.findIndex((l) => re.test(l));
    if (a < 0) return { texto: "", de: -1, ate: -1 };
    const b = corpo.findIndex((l, z) => z > a && /^(Objetivos|Público (Previsto|Atendido|-Alvo)|Formas de Atendimento|Resultados Esperados)$/i.test(l));
    return { texto: corpo.slice(a + 1, b < 0 ? corpo.length : b).join("\n\n"), de: a, ate: b };
  };
  const publico = acha(/^Público (Previsto|Atendido|-Alvo)$/i).texto;

  const alvo = db.prepare("SELECT id, title FROM projetos WHERE ? LIKE '%' || title || '%'").get(m.t)
    || db.prepare("SELECT id, title FROM projetos WHERE instr(?, sigla) > 0").get(m.t);
  if (!alvo) { console.log(`  sem correspondência no banco: ${m.t.slice(0, 50)}`); return; }

  db.prepare("UPDATE projetos SET content=?, publico=COALESCE(NULLIF(?,''), publico) WHERE id=?")
    .run(corpo.join("\n\n"), publico, alvo.id);
  console.log(`  ${alvo.title}: ${corpo.join("").length} chars · público ${publico ? "ok" : "mantido"}`);
});

/* ---------------------- páginas de texto (íntegra) ----------------------- */
const pagina = (chave, pularAte) => {
  const l = L(chave).map(limpar).filter(Boolean);
  const i = pularAte ? l.findIndex((x) => new RegExp(pularAte, "i").test(x)) : -1;
  return l.slice(i + 1).join("\n\n");
};
setS("pg_vol_conteudo", pagina("voluntariado"));
setS("pg_talentos_conteudo", pagina("talentos"));
setS("pg_editais_conteudo", pagina("editais"));
setS("pg_parceiros_conteudo", pagina("parceiros"));
setS("pg_estatuto_conteudo", pagina("estatuto"));
setS("pg_organograma_conteudo", pagina("organograma"));

console.log("\n  conteúdo original aplicado ao banco.");

/* ------------- títulos/textos das novas seções editáveis ----------------- */
const padrao = {
  pg_organograma_titulo: "Como o Instituto <em>se organiza</em>",
  pg_organograma_texto: "A estrutura de governança que sustenta as decisões e a execução das ações.",
  pg_estatuto_titulo: "Estatuto social e <em>ata de eleição</em>",
  pg_estatuto_texto: "Os documentos que dão existência jurídica ao Instituto e definem sua finalidade estatutária.",
  pg_parceiros_titulo: "Quem <em>caminha junto</em>",
  pg_parceiros_texto: "Instituições que mantêm Termo de Cessão Gratuita de Espaço, disponibilizando suas instalações para projetos, atividades socioeducativas, ações comunitárias, palestras, oficinas, capacitações e atendimentos. Essas parcerias ampliam o acesso da população às nossas ações.",
  pg_dir_titulo: "Diretoria e <em>conselho fiscal</em>",
  pg_dir_texto: "A composição formal do Instituto, eleita em assembleia e registrada em ata.",
  pg_transp_titulo_lista: "Relatórios e <em>documentos</em>",
  sec_dir_sub: "A composição formal do Instituto, eleita em assembleia e registrada em ata.",
  btn_ver_projetos: "Ver todos os projetos",
  pg_vol_cta: "Ficou com dúvida ou quer conversar antes de decidir? Estamos por aqui.",
  pg_vol_cta_botao: "Falar conosco",
  pg_talentos_cta: "Prefere conversar antes de enviar o currículo? Chame no WhatsApp.",
  pg_talentos_cta_botao: "Falar no WhatsApp",
};
for (const [k, v] of Object.entries(padrao)) {
  const tem = db.prepare("SELECT value FROM settings WHERE key=?").get(k);
  if (!tem || !tem.value) setS(k, v);
}
console.log("  títulos das novas seções preenchidos");
