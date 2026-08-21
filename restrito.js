/* ==========================================================================
   restrito.js — Sistema de Gestão do Instituto Kenósis (área /restrito)

   INDEPENDENTE do painel do site (/admin). Compartilha só o processo Node e a
   porta; tudo o mais é separado:
     · banco próprio  → data/gestao.db  (nunca toca em data/site.db)
     · sessão própria → cookie "rid"    (não confunde com o "sid" do admin)
     · login próprio, layout próprio, rotas próprias sob /restrito

   O server.js delega para cá tudo que começa com /restrito. Como o nginx já
   encaminha o domínio inteiro para o Node, /restrito funciona sem mexer no
   vhost. Basta o link no rodapé do site.

   ATENÇÃO — dado sensível (LGPD): este banco guarda CPF, endereço e prontuário
   de saúde. É dado pessoal sensível. Por isso: escuta só no localhost (herda do
   server.js), envia noindex, exige login, e o deploy.sh precisa proteger o
   gestao.db do mesmo jeito que protege o site.db.
   ========================================================================== */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "restrito");
// Versão única do sistema de gestão (/restrito) e do portal do associado
// (/externo). Mudou um dos dois → sobe aqui; os dois exibem o mesmo número.
const SISTEMA_VERSION = "1.28.0";
// CSP das telas do sistema de gestão e do portal — bloqueia script/objeto
// externos; só libera as fontes do Google. 'unsafe-inline' é preciso porque as
// telas usam script/estilo inline. A janela de impressão (about:blank via
// document.write) herda esta política — por isso o print usa <script> inline
// e imagem de mesma origem, ambos permitidos aqui.
const CSP_GESTAO = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
  "form-action 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'";
const { Q, config: configPg } = require("./pg");
const { migrar: migrarEsquema } = require("./migrar");
const { cifrar, chaveConfigurada, erroChave, digitos: soDigitos } = require("./cripto");

/* ==========================================================================
   O ESQUEMA NÃO MORA MAIS AQUI.

   Até a v2.0.0 este arquivo abria o SQLite e, a cada boot, executava um
   CREATE TABLE IF NOT EXISTS seguido de uma lista de ALTER TABLE dentro de
   try/catch vazios. Funcionava, mas escondia erro: um ALTER escrito errado era
   engolido junto com o "coluna já existe", e ninguém ficava sabendo.

   Agora o esquema vive em migrations/*.sql, aplicadas uma vez cada e
   registradas em schema_migrations. Mudança de estrutura = arquivo novo.
   ========================================================================== */

/* ------------------------- senha (scrypt) e config ------------------------ */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(senha), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
function confereSenha(senha, guardado) {
  if (!guardado || !guardado.startsWith("scrypt$")) return false;
  const [, N, r, p, saltHex, dkHex] = guardado.split("$");
  /* A CONFERÊNCIA DO FORMATO, e não só do prefixo. Um hash truncado ou de
     outro formato passava pelo `startsWith` e chegava ao `Buffer.from` com
     `undefined`, que ESTOURA — e a tela de entrada respondia 500 "erro
     interno" em vez de "usuário ou senha incorretos".

     Não é hipótese: aconteceu aqui, com uma conta criada por script fora do
     sistema. A consequência real é pior que o incômodo — a trava de tentativas
     não conta um 500, então uma conta com hash corrompido deixaria de ser
     protegida contra insistência, e ninguém saberia por quê. */
  if (!N || !r || !p || !saltHex || !dkHex || !/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(dkHex)) return false;
  const dk = crypto.scryptSync(String(senha), Buffer.from(saltHex, "hex"), dkHex.length / 2, { N: +N, r: +r, p: +p });
  return iguais(Buffer.from(dkHex, "hex"), dk);
}
/* Os parênteses em volta do await NÃO são enfeite: sem eles, o `?.value`
   seria aplicado à Promise (que não tem .value) antes de esperar, e o
   resultado viria undefined em silêncio. */
const getC = async (k) => (await Q.get("SELECT value FROM g_config WHERE key=?", k))?.value;
const setC = (k, v) => Q.run("INSERT INTO g_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, String(v));

/* ==========================================================================
   O QUE É GRAVADO CIFRADO

   Estes campos vão para o banco em texto cifrado (ver cripto.js) e voltam
   decifrados na leitura. Na tela e na impressão nada muda; no banco, num dump
   ou num backup vazado, não há nada legível.

   O instituto atende pessoas em situação de vulnerabilidade: além de CPF e
   endereço, o cadastro guarda NIS, cartão do SUS e a descrição da
   vulnerabilidade — dado que, vazado, causa dano muito além do constrangimento.

   POR QUE `nome` FICA DE FORA — é escolha, não esquecimento: é a chave de
   BUSCA e de ORDENAÇÃO das listas. Cifrado, o banco não conseguiria mais
   ordenar nem procurar por parte dele, e cada listagem teria de trazer o
   cadastro inteiro para a memória antes de mostrar a primeira linha.

   `senha_externo` também fica fora: já é um hash scrypt, não texto. Cifrá-lo
   não acrescentaria proteção e ainda poria o login do portal em risco.
   ========================================================================== */

/* ==========================================================================
   HIGIENIZAÇÃO DO HTML DO PRONTUÁRIO

   Os campos de registro clínico passaram a aceitar formatação. Isso significa
   que o sistema GRAVA HTML e depois o DEVOLVE para dentro da página e da
   janela de impressão — que é a definição de XSS armazenado se ninguém filtrar.

   O perigo aqui não é teórico nem é só "invasor": basta alguém colar um trecho
   de página da internet dentro de uma evolução para entrar script, iframe e
   estilo que quebram a impressão do prontuário.

   A regra é LISTA DE PERMITIDOS, e não lista de proibidos: só o que está aqui
   passa, o resto vira texto. Lista de proibidos sempre esquece alguma coisa —
   e a que esquecer é justamente a que vai ser usada.

   Nada de atributo: sem `style`, sem `class`, sem `on*`, sem `href`. Para
   negrito, itálico, sublinhado e lista, atributo nenhum é necessário — e é
   dentro deles que mora quase todo ataque.
   ========================================================================== */
const TAGS_PERMITIDAS = new Set(["p", "br", "b", "strong", "i", "em", "u", "ul", "ol", "li", "div", "span"]);

function htmlLimpo(valor) {
  if (valor === null || valor === undefined) return valor;
  let s = String(valor);
  if (!s.includes("<")) return s;                    // texto puro: nada a fazer

  /* Fora antes de tudo: o conteúdo destas tags some junto com elas. Remover só
     a tag deixaria o código do script solto como texto visível na tela. */
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta|base|svg|math)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<(script|style|iframe|object|embed|form|link|meta|base|svg|math)\b[^>]*\/?>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");

  /* Agora cada tag restante: se estiver na lista, volta SEM atributo nenhum;
     se não estiver, é descartada (o texto interno permanece). */
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, nome) => {
    const n = nome.toLowerCase();
    if (!TAGS_PERMITIDAS.has(n)) return "";
    return tag.startsWith("</") ? `</${n}>` : (n === "br" ? "<br>" : `<${n}>`);
  });
  return s;
}

/* Onde o HTML é aceito. Só o registro clínico — em nome, CPF ou endereço,
   marcação não tem função nenhuma e só serviria para esconder conteúdo. */
const CAMPOS_HTML = {
  prontuario_registros: ["texto"],
};

/* O texto sem marcação nenhuma, para onde só cabe uma linha (linha do tempo,
   resumo da auditoria). Guardar HTML ali sujaria a leitura com `<p>` no meio
   da frase. */
function semMarcacao(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function limparHtmlDoRegistro(tabela, obj) {
  const campos = CAMPOS_HTML[tabela];
  if (!campos || !obj) return obj;
  for (const c of campos) if (c in obj) obj[c] = htmlLimpo(obj[c]);
  return obj;
}

const CAMPOS_PROTEGIDOS = {
  pacientes: ["cpf", "rg", "nascimento", "endereco", "cep", "numero", "bairro", "complemento", "telefone", "email", "nis",
    "cartao_sus", "escolaridade", "vulnerabilidade", "observacoes", "foto",
    "pai", "mae", "resp_nome", "resp_cpf", "resp_rg", "resp_nascimento"],
  associados: ["cpf", "contato", "endereco", "cep", "numero", "bairro", "complemento", "foto"],
  // o registro em si: a observação da pasta e o texto de cada lançamento
  prontuario: ["observacao", "alta_motivo", "anexos", "responsavel"],
  prontuario_registros: ["texto", "anexo"],
  // o histórico guarda TRECHOS do que foi escrito nos lançamentos
  historico: ["detalhe"],
  atendimentos: ["observacoes"],
  beneficios: ["cpf", "foto"],
  documentos_gestao: ["titulo", "arquivo"],
  profissionais: ["contato", "registro"],
};

/* Cifra os campos protegidos de um objeto ANTES de gravar. Quem chama não
   precisa saber quais são sensíveis. */
function proteger(tabela, obj) {
  const campos = CAMPOS_PROTEGIDOS[tabela];
  if (!campos || !obj) return obj;
  for (const c of campos) if (c in obj) obj[c] = cifrar(obj[c]);
  return obj;
}

/* ==========================================================================
   HISTÓRICO DE VERSÕES — alimenta a tela "Sobre o sistema"

   Fica junto do SISTEMA_VERSION de propósito: separados em dois lugares, uma
   hora a tela anuncia uma versão cujo texto ficou para trás.
   Ao subir a versão: mude a constante e acrescente a entrada no TOPO.

   Reconstruído a partir do git (a versão gravada em cada commit) e do registro
   do projeto. Algumas versões saíram entre commits e estão descritas junto da
   que as entregou.
   ========================================================================== */
const HISTORICO_VERSOES = [
  { versao: "1.19.0", data: "2026-08-09", titulo: "Arquivar usuário e prontuário", mudancas: [
    "Arquivar tira o usuário da lista de Usuários sem apagar nada",
    "Arquivar tira o prontuário da tela de Prontuários, com o acompanhamento inteiro guardado",
    "Nova tela Arquivados, no menu da conta, com uma aba para cada área",
    "Restaurar devolve o registro à lista de origem com um clique",
    "Arquivar NÃO é inativar nem dar alta: essas duas continuam à vista, com etiqueta",
    "Quem arquivou e quando ficam registrados na linha do tempo",
  ] },
  { versao: "1.18.0", data: "2026-08-09", titulo: "Impressões em papel timbrado", mudancas: [
    "Marca d'água do Instituto ao centro de todas as folhas impressas",
    "Escolha entre retrato e paisagem na hora de imprimir, em qualquer documento",
    "Timbre e rodapé passam a se repetir em TODAS as páginas, não só na primeira",
    "Data, título e endereço que o navegador imprimia na borda da folha saíram",
    "Rótulos e valores deixam de sair picados em tiras verticais",
    "Lançamento do prontuário e assinatura não se partem mais entre duas folhas",
    "No prontuário completo, cada pasta começa em folha nova",
  ] },
  { versao: "1.16.0", data: "2026-07-28", titulo: "Prontuário em pasta", mudancas: [
    "Prontuário passa a ser uma PASTA por usuário + serviço, com número próprio",
    "Dentro da pasta, lançamentos datados: avaliação, evolução, plano e encaminhamento",
    "Alta é da pasta: encerrar um serviço não encerra os outros da mesma pessoa",
    "Lançamento nunca é excluído — é arquivado, e volta com um clique",
    "Agendamentos se penduram na pasta do serviço, e podem ser vinculados à mão",
    "Linha do tempo de cada pasta e de cada usuário",
    "Impressão da pasta e do prontuário completo, com o acompanhamento em sequência",
    "Prontuário saiu de Cadastros para o menu principal; Relatórios virou seção",
  ] },
  { versao: "1.15.0", data: "2026-07-28", titulo: "Paridade com o sistema da clínica", mudancas: [
    "Prontuário: o profissional vê apenas os registros pelos quais responde",
    "Listas paginadas, com escolha de quantos itens por página",
    "Filtro por período em Agenda, Prontuário, Benefícios, Eventos, Documentos e Relatórios",
    "Usuário pode ser inativado sem perder ficha, prontuário nem histórico",
    "Bloquear um profissional agora derruba o login dele na hora",
    "Endereço em partes, preenchido sozinho pelo CEP",
    "Nova tela: relação de usuários ativos / inativos, com impressão em paisagem",
  ] },
  { versao: "1.14.0", data: "2026-07-28", titulo: "Telas novas, editor de texto e atalhos", mudancas: [
    "Telas de Auditoria e Sobre o sistema disponíveis no menu da conta",
    "Backup do banco pode ser baixado pelo menu, em arquivo SQL completo",
    "Prontuário com editor de texto: negrito, itálico, sublinhado e listas",
    "Todo botão que fala com o servidor mostra que está trabalhando e trava a tela",
    "Ações das linhas em menu de três pontos; nas demais telas, ícone de lupa",
    "Atalho de 9 pontos no topo leva ao painel do site (já autenticado) e ao site",
    "Sair do sistema de gestão encerra também a sessão do painel do site",
  ] },
  { versao: "1.13.0", data: "2026-07-28", titulo: "Proteção dos dados e auditoria", mudancas: [
    "CPF, RG, NIS, cartão do SUS, endereço e prontuário gravados cifrados no banco",
    "Backup diário automático dos dois bancos, com restauração assistida",
    "Nova tela de Auditoria: tudo que acontece no sistema, com data, hora, IP e autor",
    "Nova tela Sobre o sistema",
    "Tela e impressões continuam mostrando tudo por extenso",
  ] },
  { versao: "1.12.0", data: "2026-07-28", titulo: "Banco de dados PostgreSQL", mudancas: [
    "Sistema de gestão migrado do SQLite para o PostgreSQL",
    "Estrutura do banco controlada por migrations versionadas",
    "Uma falha no banco não derruba mais o site do instituto",
  ] },
  { versao: "1.10.0", data: "2026-07-24", titulo: "Busca nos serviços", mudancas: [
    "Campo de busca para filtrar os 32 serviços ao digitar",
  ] },
  { versao: "1.9.0", data: "2026-07-24", titulo: "Menu e campos de busca", mudancas: [
    "Menu lateral reorganizado, com Cadastros em seções",
    "Campo com busca para escolher usuário e profissional",
    "Serviços restritos ao que o profissional realiza",
    "Impressão da agenda em paisagem",
  ] },
  { versao: "1.8.0", data: "2026-07-24", titulo: "Agenda impressa e responsável legal", mudancas: [
    "Imprimir a agenda do período, agrupada por dia",
    "Responsável legal no cadastro de menores de 18 anos",
    "Sala e valor no agendamento",
  ] },
  { versao: "1.7.0", data: "2026-07-23", titulo: "Serviços e projetos no sistema", mudancas: [
    "Serviços e projetos passaram a ser cadastrados aqui; o site publica a partir daqui",
    "Relatórios com barras clicáveis que levam à agenda filtrada",
  ] },
  { versao: "1.5.0", data: "2026-07-23", titulo: "Segurança e portal do associado", mudancas: [
    "Senha do portal do associado guardada como hash",
    "Portal do associado (/externo) com acesso por CPF e senha",
    "Impressões com papel timbrado do instituto",
  ] },
  { versao: "1.0.0", data: "2026-07-23", titulo: "Primeira versão", mudancas: [
    "Cadastros: usuários atendidos, associados e profissionais",
    "Agenda de serviços com regras de horário",
    "Prontuário, benefícios, eventos, documentos e relatórios",
    "Perfis de acesso: administrador, secretaria e profissional",
  ] },
];

/* As tecnologias do SISTEMA DE GESTÃO. O site do instituto é outro projeto,
   com outra estrutura — não entra aqui. */
const TECNOLOGIAS = [
  { nome: "Node.js", papel: "Servidor da aplicação", detalhe: process.version },
  { nome: "PostgreSQL", papel: "Banco de dados do sistema", detalhe: "acesso pelo driver pg" },
  { nome: "JavaScript, HTML e CSS", papel: "Interface", detalhe: "sem framework — tela única" },
  { nome: "Migrations em SQL", papel: "Controle da estrutura do banco", detalhe: "cada mudança é um arquivo versionado" },
  { nome: "AES-256-GCM", papel: "Proteção dos dados sensíveis", detalhe: "chave fora do banco" },
  { nome: "scrypt", papel: "Proteção das senhas", detalhe: "com sal individual por senha" },
  { nome: "pg_dump", papel: "Backup", detalhe: "cópia diária automática" },
];

/* a trilha de auditoria guarda O QUE foi feito — nome, CPF, trechos de
   prontuário. Cifrada pelo mesmo motivo dos demais. */
CAMPOS_PROTEGIDOS.auditoria = ["resumo", "detalhe"];

/* ==========================================================================
   AUDITORIA — quem fez o quê, quando e de onde

   Registra entradas, saídas, telas abertas, cadastros, edições e exclusões.
   Exclusiva do administrador.

   TRÊS DECISÕES QUE MOLDAM ISTO:

   1. NUNCA derruba a operação auditada — todo o corpo vive num catch que só
      escreve no log. Perder o cadastro do beneficiário para preservar o
      registro de que ele existiu seria trocar o certo pelo acessório.
   2. Não é aguardada: gravar a trilha não pode somar espera a cada clique.
      A promessa vai solta COM catch próprio, porque rejeição não tratada
      derruba o processo no Node.
   3. O `detalhe` guarda o antes/depois em JSON — é o que a tela abre no modal.
   ========================================================================== */
const ACOES_ROTULO = {
  login: "Entrou no sistema", login_falhou: "Tentativa de login sem sucesso",
  logout: "Saiu do sistema", acesso: "Abriu a tela",
  criar: "Cadastrou", editar: "Alterou", excluir: "Excluiu",
  backup: "Baixou backup do banco", senha: "Trocou a senha",
  inativar: "Inativou", reativar: "Reativou",
  bloquear: "Bloqueou o acesso", desbloquear: "Liberou o acesso",
};
/* Nome da tela como a equipe a conhece. A tabela se chama `pacientes`; no
   instituto aquilo é "Usuários", e `especialidade` são os "Serviços". */
const MODULO_ROTULO = {
  pacientes: "Usuários", associados: "Associados", profissionais: "Profissionais",
  atendimentos: "Agendamento", prontuario: "Prontuário", prontuario_registros: "Lançamentos do prontuário", beneficios: "Benefícios",
  eventos: "Eventos", documentos_gestao: "Documentos", projetos: "Projetos",
  servicos: "Serviços", usuarios: "Usuários do Sistema", relatorios: "Relatórios",
  painel: "Painel", auditoria: "Auditoria", sobre: "Sobre o sistema", conta: "Minha conta",
};
const rotuloModulo = (t) => MODULO_ROTULO[t] || t;
const rotuloRegistro = (tabela, r) => {
  if (!r) return "";
  if (tabela === "atendimentos") return [r.data, r.hora].filter(Boolean).join(" ");
  if (tabela === "prontuario") return [r.numero, r.especialidade].filter(Boolean).join(" · ");
  if (tabela === "prontuario_registros") return rotuloTipo(r.tipo) + (r.data ? ` de ${r.data}` : "");
  return r.nome || r.title || r.titulo || `#${r.id || ""}`;
};

function auditar({ req, sessao: sess, acao, modulo, entidadeId, resumo, detalhe }) {
  Promise.resolve().then(async () => {
    await Q.run(
      `INSERT INTO auditoria(criado,ip,usuario_id,usuario_nome,perfil,acao,modulo,entidade_id,resumo,detalhe,rota,metodo)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      agora(), req ? clientIp(req) : null,
      sess ? sess.userId : null, sess ? sess.nome : "", sess ? sess.perfil : "",
      acao, modulo || null, entidadeId || null,
      cifrar(resumo || ""), cifrar(detalhe ? JSON.stringify(detalhe) : ""),
      req ? String(req.url || "").slice(0, 300) : null, req ? req.method : null);
  }).catch((e) => console.error("  ✖ auditoria não gravada:", e.message));
}

/* Só o que MUDOU numa edição — é o que torna a trilha útil: "alterou o
   cadastro" não diz nada; "trocou o telefone de X para Y" diz. */
function diferencas(antes, depois, tabela) {
  const mudou = {};
  if (!antes || !depois) return mudou;
  const prot = new Set(CAMPOS_PROTEGIDOS[tabela] || []);
  const rec = (t) => { const x = String(t ?? "").replace(/s+/g, " ").trim(); return x.length > 400 ? x.slice(0, 400) + "…" : x; };
  for (const campo of Object.keys(depois)) {
    if (campo === "id" || campo === "criado") continue;
    const de = antes[campo], para = depois[campo];
    const vazio = (v) => v === null || v === undefined || v === "";
    if (vazio(de) && vazio(para)) continue;
    if (String(de ?? "") === String(para ?? "")) continue;
    mudou[campo] = { de: rec(de), para: rec(para), protegido: prot.has(campo) };
  }
  return mudou;
}

/* ==========================================================================
   ACESSO DE TELA — registrar sem afogar a trilha

   Uma tela não faz uma leitura, faz várias (lista, seletores, cache, cada
   busca digitada). Registrar todas encheria a auditoria de milhares de linhas
   por dia e esconderia o que importa. Guardamos só a PRIMEIRA visita de cada
   pessoa a cada tela dentro de uma janela de tempo.
   ========================================================================== */
const ACESSO_JANELA_MIN = 15;
const acessosRecentes = new Map();
function registrarAcesso(req, sess, modulo) {
  const chave = `${sess.userId}:${modulo}`;
  const antes = acessosRecentes.get(chave);
  if (antes && Date.now() - antes < ACESSO_JANELA_MIN * 60_000) return;
  acessosRecentes.set(chave, Date.now());
  auditar({ req, sessao: sess, acao: "acesso", modulo,
    resumo: `${sess.nome} abriu a tela ${rotuloModulo(modulo)}` });
}
setInterval(() => {
  const lim = Date.now() - ACESSO_JANELA_MIN * 60_000;
  for (const [k, t] of acessosRecentes) if (t < lim) acessosRecentes.delete(k);
}, 30 * 60_000).unref();

/* ------------------------------- sessões --------------------------------- */
const SESSAO_HORAS = 8;
const sessoes = new Map();   // rid -> { userId, perfil, nome, ts }
/* ==========================================================================
   SAIR DAQUI SAI TAMBÉM DO PAINEL DO SITE

   A sessão do /admin vive no server.js, não aqui — os dois sistemas são
   separados de propósito. Mas o server.js é quem CARREGA este arquivo; se
   fôssemos buscar lá de dentro, os dois passariam a exigir um ao outro para
   carregar (dependência circular), e um dos dois receberia o outro pela
   metade.

   Então o caminho é o inverso: o server.js REGISTRA aqui a função que sabe
   encerrar a sessão dele. Enquanto ninguém registrar, o valor é nulo e o
   logout daqui simplesmente segue sem mexer no painel — o /restrito continua
   funcionando isolado, como sempre funcionou.
   ========================================================================== */
let encerrarPainelDoSite = null;
const registrarEncerrarPainel = (fn) => { encerrarPainelDoSite = fn; };

function novaSessao(u) {
  const rid = crypto.randomBytes(24).toString("hex");
  sessoes.set(rid, { userId: u.id, perfil: u.perfil, nome: u.nome, profissionalId: u.profissional_id || null, ts: Date.now() });
  return rid;
}
function sessao(req) {
  const m = /(?:^|;\s*)rid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessoes.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.ts > SESSAO_HORAS * 3600_000) { sessoes.delete(m[1]); return null; }
  s.ts = Date.now();
  return { rid: m[1], ...s };
}
setInterval(() => {
  const lim = Date.now() - SESSAO_HORAS * 3600_000;
  for (const [k, v] of sessoes) if (v.ts < lim) sessoes.delete(k);
}, 30 * 60_000).unref();

/* FREIO CONTRA ADIVINHAÇÃO DE SENHA — ver limitador.js.

   Aqui o ganho é maior que no /admin, porque estes dois logins são
   MULTIUSUÁRIO: antes, a contagem por IP deixava alguém martelar a conta de
   UMA pessoa específica a partir de vários endereços sem disparar nada. O
   balde por conta soma as tentativas contra CADA pessoa, separadamente — e
   travar a conta da Maria não atrapalha o João.

   Arquivo próprio, e não o do server.js: os dois módulos guardam o estado em
   memória e gravam tudo de uma vez, então dividir o mesmo arquivo faria um
   apagar o que o outro acabou de escrever. */
const { criarLimitador } = require("./limitador");
const limite = criarLimitador({ arquivo: path.join(ROOT, "data", "limites-restrito.json") });
limite.carregar();
process.on("exit", () => limite.gravar());
setInterval(() => limite.limpar(), 10 * 60_000).unref();

/* -------------------------------- utilidades ----------------------------- */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugify = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/* Regras de agenda: expediente 07h–12h e 14h–18h (intervalo 12h–14h), cada
   atendimento ocupa um bloco de 40 min, e o mesmo profissional não pode ter
   dois blocos que se sobreponham. Devolve a mensagem de erro ou null se ok. */
async function validarAgenda(profissionalId, data, hora, excluirId) {
  if (!hora) return null;                        // sem horário definido, sem regra a aplicar
  const [h, mm] = String(hora).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(mm)) return "Horário inválido.";
  const ini = h * 60 + mm, fim = ini + 40;
  const manha = ini >= 7 * 60 && fim <= 12 * 60;
  const tarde = ini >= 14 * 60 && fim <= 18 * 60;
  if (!manha && !tarde)
    return "Horário fora do expediente. Os atendimentos vão das 07h às 12h e das 14h às 18h, em blocos de 40 minutos (o último começa 11h20 pela manhã e 17h20 à tarde).";
  if (!data || !profissionalId) return null;     // sem data e profissional não há como conferir choque
  const outros = excluirId
    ? await Q.all("SELECT hora FROM atendimentos WHERE profissional_id=? AND data=? AND hora<>'' AND id<>?", profissionalId, data, excluirId)
    : await Q.all("SELECT hora FROM atendimentos WHERE profissional_id=? AND data=? AND hora<>''", profissionalId, data);
  for (const o of outros) {
    const [oh, om] = String(o.hora).split(":").map(Number);
    if (Number.isNaN(oh)) continue;
    const oi = oh * 60 + om, of = oi + 40;
    if (ini < of && oi < fim) return `Choque de horário: este profissional já tem um atendimento às ${o.hora} (cada atendimento ocupa 40 minutos).`;
  }
  return null;
}
/* O IP REAL de quem está pedindo.

   Atrás do nginx o socket é sempre 127.0.0.1, então o IP verdadeiro precisa
   chegar por cabeçalho. Só que cabeçalho é texto que o CLIENTE também
   escreve. O nginx monta `X-Forwarded-For: <o que o cliente mandou>, <IP
   real>` — ele ACRESCENTA no fim, não substitui. Ler o PRIMEIRO item da lista,
   como estava aqui, é ler exatamente o que o visitante digitou.

   Na prática isso anulava a trava de força bruta: bastava mandar um
   X-Forwarded-For diferente a cada tentativa para nenhuma "contar" duas vezes
   no mesmo IP, e a senha podia ser tentada infinitas vezes.

   Duas correções: o cabeçalho só é aceito quando a conexão de fato veio do
   nginx local, e usamos o X-Real-IP — que o nginx SOBRESCREVE — ou, na falta
   dele, o ÚLTIMO item da lista, o único que o nginx escreveu. */
const DO_PROXY = /^(?:::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/;
function clientIp(req) {
  const direto = String(req.socket.remoteAddress || "");
  if (!DO_PROXY.test(direto)) return direto;                      // conexão direta: só o socket vale
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  const lista = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return lista.length ? lista[lista.length - 1] : direto;
}
const agora = () => new Date().toISOString();
function readBody(req) {
  return new Promise((ok, err) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 8e6) req.destroy(); });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { ok({}); } });
    req.on("error", err);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
  res.end(JSON.stringify(obj));
}

/* Tabelas expostas via CRUD genérico e suas colunas graváveis */
const TAB = {
  pacientes:  ["nome", "foto", "nascimento", "cpf", "rg", "pai", "mae", "endereco", "cep", "numero", "bairro", "cidade", "complemento", "telefone", "email", "nis", "cartao_sus", "escolaridade", "vulneravel", "vulnerabilidade", "primeiro_atendimento", "consentimento", "projeto_id", "observacoes", "resp_nome", "resp_cpf", "resp_rg", "resp_nascimento"],
  projetos:   ["title", "slug", "sigla", "status", "resumo", "publico", "content", "sort"],
  servicos:   ["title", "categoria", "sort"],
  associados: ["nome", "cpf", "contato", "endereco", "cep", "numero", "bairro", "cidade", "complemento", "foto", "vinculo", "adesao", "mensalidade", "status", "senha_externo"],
  profissionais: ["nome", "especialidade", "registro", "contato", "ativo"],
  atendimentos: ["paciente_id", "profissional_id", "especialidade", "data", "hora", "local", "sala", "valor", "status", "observacoes", "prontuario_id"],
  prontuario: ["paciente_id", "profissional", "profissional_id", "especialidade", "status", "aberto_em", "observacao", "anexos", "responsavel", "usuario_id"],
  prontuario_registros: ["prontuario_id", "tipo", "texto", "data", "profissional", "anexo", "usuario_id"],
  beneficios: ["nome", "cpf", "item", "data", "foto", "local", "responsavel"],
  eventos: ["tipo", "titulo", "tema", "local", "data", "hora", "publico_alvo", "participantes", "responsavel", "avaliacao", "fotos"],
  documentos_gestao: ["paciente_id", "tipo", "titulo", "arquivo", "data"],
  /* A folha de frequência guarda ids de pacientes, nunca nome/CPF — o cadastro
     é a fonte e a folha imprime o que está nele hoje (migration 008). */
  frequencias: ["turma", "mes", "datas", "participantes"],
};

const UPLOAD_DIR = path.join(ROOT, "restrito", "arquivos");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* Perfis de acesso (seção 2 da especificação). Cada perfil enxerga só os
   módulos abaixo; "usuarios" é sempre exclusivo do admin. O front esconde o que
   não pode, mas quem MANDA é esta checagem no servidor.
   - admin: acesso total.
   - secretaria/atendente: cadastros, agendamento e relatórios (não vê prontuário clínico).
   - profissional de saúde/terapias: sua agenda e os prontuários. */
const PERFIS = ["admin", "secretaria", "profissional"];
const PERM = {
  admin: "*",
  secretaria: new Set(["pacientes", "associados", "profissionais", "atendimentos", "documentos_gestao", "beneficios", "eventos", "projetos", "servicos", "relatorios", "frequencias"]),
  // profissional vê SOMENTE a sua agenda e os seus prontuários. Nada mais.
  // Lê pacientes/profissionais só como apoio (nomes nas telas e seletores),
  // sem menu próprio — ver PERM_LEITURA.
  profissional: new Set(["atendimentos", "prontuario", "prontuario_registros", "historico"]),
};
const PERM_LEITURA = { profissional: new Set(["pacientes", "profissionais", "servicos"]) };

/* ==========================================================================
   O QUE PODE SER ARQUIVADO

   Arquivar é decisão de ORGANIZAÇÃO da tela: "tire isto da minha frente".
   Não diz que a pessoa deixou de ser atendida (para isso existe `ativo`) nem
   que o acompanhamento terminou (para isso existe `status = Alta`). Some da
   lista, continua no banco, volta num clique.

   As três tabelas usam a MESMA dupla de colunas (`arquivado` 0/1 e
   `arquivado_em`), o mesmo parâmetro de consulta e a mesma rota — foi o que
   permitiu que `prontuario_registros`, que já arquivava desde a 006, entrasse
   nesta lista sem mudar de comportamento.
   ========================================================================== */
const TEM_ARQUIVO = new Set(["pacientes", "prontuario", "prontuario_registros"]);

/* De quem é este prontuário. A tela guarda o NOME do profissional (é o que a
   equipe digita e lê); o recorte de acesso precisa do ID. Resolver aqui, na
   gravação, mantém as duas coisas em dia sem obrigar a tela a mudar.

   Sem correspondência o dono fica NULL, e NULL não é de ninguém: nenhum
   profissional vê. Esconder demais se conserta escolhendo o profissional certo;
   mostrar de menos entregaria prontuário a quem não é o responsável. */
/* ==========================================================================
   NUMERAÇÃO DA PASTA — PR-AAAA-00001

   Sequencial por ANO, único e NUNCA reaproveitado: é por esse número que a
   equipe localiza a pasta no papel e no encaminhamento.

   Por que um contador em g_config e não "o maior número da tabela": se a
   última pasta for excluída, o maior da tabela cai — e a próxima herdaria um
   número que já circulou impresso. O contador só sobe, e ainda é comparado com
   o maior do banco a cada emissão, então se recupera sozinho se o g_config for
   perdido.
   ========================================================================== */
async function proximoSequencial(prefixo, chave, tabela, coluna, ano) {
  const y = ano || new Date().getFullYear();
  const inicio = `${prefixo}-${y}-`;
  const chaveAno = `${chave}_${y}`;
  const guardado = Number((await getC(chaveAno)) || 0);
  const r = await Q.get(`SELECT MAX(CAST(substr(${coluna}, ?) AS INTEGER)) m FROM ${tabela} WHERE ${coluna} LIKE ?`,
    inicio.length + 1, inicio + "%");
  const noBanco = (r && r.m) ? Number(r.m) : 0;
  const seq = Math.max(guardado, noBanco) + 1;
  await setC(chaveAno, seq);               // marca como usado, mesmo se falhar depois
  return inicio + String(seq).padStart(5, "0");
}
/* Grava o número, tentando de novo se colidir (backup restaurado por cima).
   Colisão é a ÚNICA falha que se repete: o Postgres a devolve com o código
   23505. Testar pelo CÓDIGO e não pela mensagem — mensagem muda com a versão e
   com o idioma do servidor, e um teste frouxo engoliria um erro real 20 vezes
   antes de desistir. */
async function emitirSequencial(prefixo, chave, tabela, coluna, id, ano) {
  for (let i = 0; i < 20; i++) {
    const num = await proximoSequencial(prefixo, chave, tabela, coluna, ano);
    try { await Q.run(`UPDATE ${tabela} SET ${coluna}=? WHERE id=?`, num, id); return num; }
    catch (e) { if (e.code !== "23505") throw e; }
  }
  throw new Error(`Não consegui gerar o número em ${tabela}.`);
}
const emitirNumeroProntuario = (id, ano) => emitirSequencial("PR", "pront_seq", "prontuario", "numero", id, ano);

/* Os quatro tipos de lançamento que compõem a pasta. Cada um vira uma área
   própria na tela, com a sua lista de registros datados. */
const TIPOS_REGISTRO = ["avaliacao", "evolucao", "plano", "encaminhamento"];
const ROTULO_TIPO = { avaliacao: "Avaliação", evolucao: "Evolução", plano: "Plano de acompanhamento", encaminhamento: "Encaminhamento" };
const rotuloTipo = (t) => ROTULO_TIPO[t] || t;

/* ==========================================================================
   LINHA DO TEMPO — o que sobrevive quando a pessoa sai e volta.

   `detalhe` é cifrado: ele carrega TRECHOS do que foi escrito no prontuário.
   Sem isso o histórico viraria a porta dos fundos do registro — o texto estaria
   protegido no lançamento e em claro aqui do lado. O `evento` fica legível:
   são rótulos fixos ("Alta", "Pasta aberta"), sem conteúdo de ninguém, e é por
   ele que a tela agrupa a linha do tempo.
   ========================================================================== */
async function anotar(entidade, entidadeId, evento, detalhe, sessao) {
  if (!entidadeId) return;
  await Q.run(
    "INSERT INTO historico(entidade,entidade_id,evento,detalhe,usuario_id,usuario_nome,criado) VALUES(?,?,?,?,?,?,?)",
    entidade, entidadeId, evento, cifrar(detalhe || ""),
    sessao ? sessao.userId : null, sessao ? sessao.nome : "", agora());
}

/* A pasta daquele par pessoa + serviço, se existir. */
const pastaDoPar = (pacienteId, servico) =>
  Q.get("SELECT * FROM prontuario WHERE paciente_id=? AND especialidade=?", pacienteId, servico);

/* Os serviços de um agendamento — a coluna guarda lista JSON. */
function servicosDoAtendimento(a) {
  try { const x = JSON.parse(a.especialidade || "[]"); return Array.isArray(x) ? x : (a.especialidade ? [a.especialidade] : []); }
  catch { return a.especialidade ? [String(a.especialidade)] : []; }
}

/* Pendura o agendamento na pasta correspondente, SE não houver dúvida.

   Só liga sozinho quando o agendamento tem UM serviço e existe pasta daquele
   par. Com dois ou mais serviços não há resposta certa — o atendimento não
   pertence a uma pasta específica —, e escolher uma no chute colocaria o
   registro na pasta errada em silêncio. Nesse caso fica solto, e a tela da
   pasta oferece o botão de vincular à mão. */
async function ligarAtendimentoNaPasta(id) {
  const a = await Q.get("SELECT id,paciente_id,especialidade,prontuario_id FROM atendimentos WHERE id=?", id);
  if (!a || a.prontuario_id) return null;
  const servicos = servicosDoAtendimento(a);
  if (servicos.length !== 1) return null;
  const pasta = await pastaDoPar(a.paciente_id, servicos[0]);
  if (!pasta) return null;
  await Q.run("UPDATE atendimentos SET prontuario_id=? WHERE id=?", pasta.id, id);
  return pasta;
}

/* Recolhe para a pasta recém-aberta os agendamentos daquele par que estavam
   sem vínculo — na prática, os marcados antes de a pasta existir. */
async function recolherAtendimentosSoltos(prontuarioId, pacienteId, servico) {
  const soltos = await Q.all(
    "SELECT id,especialidade FROM atendimentos WHERE paciente_id=? AND prontuario_id IS NULL", pacienteId);
  let n = 0;
  for (const a of soltos) {
    const servicos = servicosDoAtendimento(a);
    if (servicos.length === 1 && servicos[0] === servico) {
      await Q.run("UPDATE atendimentos SET prontuario_id=? WHERE id=?", prontuarioId, a.id);
      n++;
    }
  }
  return n;
}

/* Condição SQL do recorte por dono, para as consultas que não passam pelo CRUD
   genérico. Sem profissional vinculado devolve algo que não casa com nada: sem
   vínculo não há como dizer o que é dele, e o lado seguro do erro é não mostrar
   nada. */
const soDoProfissional = (sess) => sess && sess.perfil === "profissional";
function filtroDono(sess, coluna = "profissional_id") {
  if (!soDoProfissional(sess)) return { sql: "", args: [] };
  if (!sess.profissionalId) return { sql: " AND 1=0", args: [] };
  return { sql: ` AND ${coluna}=?`, args: [sess.profissionalId] };
}
/* Guarda de UM registro já lido. Devolve a mensagem de recusa ou null. */
function recusaPorDono(sess, registro) {
  if (!soDoProfissional(sess)) return null;
  if (!registro) return null;                    // quem trata "não existe" é o chamador
  if (!sess.profissionalId) return "Seu acesso não está vinculado a um profissional. Fale com o administrador.";
  if (String(registro.profissional_id || "") !== String(sess.profissionalId))
    return "Este registro pertence a outro profissional.";
  return null;
}

async function idDoProfissional(nome) {
  if (!nome) return null;
  const r = await Q.get("SELECT id FROM profissionais WHERE LOWER(TRIM(nome))=LOWER(TRIM(?))", String(nome));
  return r ? r.id : null;
}
/* ==========================================================================
   "A EQUIPE MUDOU" — aviso para quem estiver interessado (hoje: o chat)

   A gestão não conhece o chat, e é assim que fica: ela anuncia o fato, quem
   quiser que escute. O aviso dispara DEPOIS da escrita e não é esperado: o
   cadastro de um usuário não pode ficar lento nem falhar porque um ouvinte
   demorou. Mesma receita do BemEstarClinic.
   ========================================================================== */
const ouvintesDaEquipe = [];
function aoMudarEquipe(fn) { if (typeof fn === "function") ouvintesDaEquipe.push(fn); }
function equipeMudou(motivo) {
  for (const fn of ouvintesDaEquipe) {
    try { Promise.resolve(fn(motivo)).catch(() => { }); } catch { }
  }
}

const pode = (perfil, modulo) => perfil === "admin" || (PERM[perfil] ? PERM[perfil].has(modulo) : false);
const podeLer = (perfil, modulo) => pode(perfil, modulo) || (PERM_LEITURA[perfil] && PERM_LEITURA[perfil].has(modulo));
const adminsAtivos = async () => Number((await Q.get("SELECT COUNT(*) c FROM g_usuarios WHERE perfil='admin' AND ativo=1")).c);

/* Colunas reais de cada tabela. Serve para o CRUD só gravar o que existe — e
   para saber se a tabela tem "criado" antes de carimbá-lo. Preenchido em
   iniciarRestrito(), lendo o information_schema (o equivalente do Postgres ao
   PRAGMA table_info do SQLite). */
const COLS = {};

/* O TIPO de cada coluna, do mesmo information_schema. Existe por causa de um
   defeito que só apareceu depois da mudança para o PostgreSQL:

   Um campo de número deixado em branco no formulário chega aqui como STRING
   VAZIA — o navegador não manda `null`, manda `""`. O SQLite engolia isso sem
   reclamar (guardava a string na coluna INTEGER). O PostgreSQL recusa:

     invalid input syntax for type integer: ""

   e o salvar devolve 500. Editar um projeto e deixar a Ordem em branco era o
   suficiente; o mesmo valia para outras 17 colunas inteiras espalhadas por
   nove módulos — vínculo de usuário, profissional, prontuário, projeto,
   número de participantes.

   O tratamento fica AQUI, na beira do banco, e não em cada tela: tela se
   esquece, e a próxima coluna numérica que alguém acrescentar já nasceria com o
   mesmo defeito.

   Nem todo branco vira NULL, porém — o banco tem três respostas diferentes:

   · coluna que aceita nulo      → NULL, que é o que "não informado" significa
   · coluna com valor PADRÃO     → sai da instrução, e o padrão vale (é o caso
                                   de `pacientes.ativo DEFAULT 1`: gravar NULL
                                   ali quebraria por outro motivo)
   · coluna obrigatória sem padrão → é campo que a tela deixou passar em branco.
                                   Devolve 400 dizendo qual, em vez de 500 —
                                   quem preenche precisa saber o que faltou. */
const TIPOS = {};
const TIPO_NAO_TEXTO = /^(integer|bigint|smallint|numeric|real|double|boolean|date|timestamp|time)/i;

function destinoDoVazio(tabela, coluna) {
  const meta = TIPOS[tabela]?.[coluna];
  if (!meta || !TIPO_NAO_TEXTO.test(meta.tipo)) return "texto";   // em texto, "" é valor legítimo
  if (meta.nulavel) return "nulo";
  return meta.padrao ? "omitir" : "obrigatorio";
}

/* Coluna → rótulo legível, para a mensagem não sair em nome de banco. */
const rotuloColuna = (c) => String(c).replace(/_id$/, "").replace(/_/g, " ");

function prepararCampos(tabela, colunas, b) {
  const usar = [], valores = [], faltando = [];
  for (const c of colunas) {
    if (b[c] !== "") { usar.push(c); valores.push(b[c]); continue; }
    switch (destinoDoVazio(tabela, c)) {
      case "nulo": usar.push(c); valores.push(null); break;
      case "omitir": break;                        // deixa o padrão da coluna valer
      case "obrigatorio": faltando.push(rotuloColuna(c)); break;
      default: usar.push(c); valores.push(b[c]);
    }
  }
  return { usar, valores, faltando };
}

/* ==========================================================================
   INICIALIZAÇÃO — o que antes rodava solto no topo do arquivo

   Com o SQLite, abrir o banco era síncrono: dava para criar tabela e semear
   dado durante o `require`. Com o PostgreSQL, conectar é assíncrono — não
   existe "banco pronto" no meio de um require.

   Então o boot virou esta função, que o server.js AGUARDA antes de abrir a
   porta. É melhor assim: enquanto isto não terminar, ninguém entra num sistema
   meio inicializado. Se falhar, o /restrito não sobe — mas o site continua.

   É seguro rodar a cada boot: cada passo ou é idempotente (só semeia tabela
   vazia) ou tem trava em g_config.
   ========================================================================== */
async function iniciarRestrito() {
  /* 0. a chave dos dados sensíveis. Sem ela o sistema NÃO sobe: a alternativa
     seria gravar CPF, endereço e prontuário em texto puro com o instituto
     trabalhando normal e ninguém percebendo que a proteção parou de existir. */
  if (!chaveConfigurada()) {
    throw new Error([
      "chave dos dados sensíveis ausente ou inválida — " + erroChave(),
      "    Gere com: openssl rand -base64 32",
      "    E grave como DADOS_CHAVE em /etc/kenosis.env",
      "    ATENÇÃO: perder essa chave torna os dados já gravados ilegíveis.",
    ].join("\n"));
  }

  /* 1. esquema em dia, antes de qualquer consulta */
  await migrarEsquema({ silencioso: true });

  /* 2. quais colunas cada tabela tem de verdade */
  for (const t of Object.keys(TAB)) {
    const cols = await Q.all(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema='public' AND table_name=?`, t);
    COLS[t] = new Set(cols.map((c) => c.column_name));
    TIPOS[t] = Object.fromEntries(cols.map((c) => [c.column_name,
      { tipo: c.data_type, nulavel: c.is_nullable === "YES", padrao: c.column_default != null }]));
    if (!COLS[t].size) console.error(`  ✖ /restrito: a tabela "${t}" não existe no banco — migration faltando?`);
  }

  /* 3. semente: um usuário admin inicial, trocável na primeira entrada */
  if ((await Q.get("SELECT COUNT(*) c FROM g_usuarios")).c === 0) {
    await Q.run("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,criado) VALUES(?,?,?,?,1,?)",
      "Administrador", "admin", hashSenha("kenosis-gestao"), "admin", new Date().toISOString());
    console.log("  · /restrito: sistema de gestão criado. Login: admin · senha: kenosis-gestao");
  }
}

/* ==========================================================================
   Handler — o server.js chama isto para tudo que casa /restrito
   Retorna true se tratou a requisição.
   ========================================================================== */
function handleRestrito(req, res, pathname) {
  if (pathname !== "/restrito" && !pathname.startsWith("/restrito/")) return false;

  // normaliza /restrito -> /restrito/
  if (pathname === "/restrito") { res.writeHead(302, { Location: "/restrito/" }); res.end(); return true; }

  const rota = pathname.slice("/restrito".length) || "/";   // ex.: "/", "/api/pacientes"

  /* --------------------------- API (JSON) ------------------------------- */
  if (rota.startsWith("/api/")) { rotaApi(req, res, rota.slice(5)).catch((e) => {
    console.error("  ✖ /restrito/api:", e.message); json(res, 500, { error: "Erro interno" });
  }); return true; }

  /* ------------------------- arquivos enviados -------------------------- */
  if (rota.startsWith("/arquivos/")) {
    if (!sessao(req)) { res.writeHead(403); res.end("403"); return true; }
    const nome = path.basename(decodeURIComponent(rota.slice("/arquivos/".length)));
    const arq = path.join(UPLOAD_DIR, nome);
    if (!arq.startsWith(UPLOAD_DIR) || !fs.existsSync(arq)) { res.writeHead(404); res.end("404"); return true; }
    const ext = path.extname(arq).toLowerCase();
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".pdf": "application/pdf" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
    fs.createReadStream(arq).pipe(res);
    return true;
  }

  /* ------------------------------ app HTML ------------------------------ */
  if (rota === "/" || rota === "/index.html") {
    const arq = path.join(APP_DIR, "app.html");
    const html = fs.readFileSync(arq, "utf8").replace(/\{\{VERSAO\}\}/g, SISTEMA_VERSION);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": CSP_GESTAO });
    res.end(html);
    return true;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404");
  return true;
}

/* ==========================================================================
   BACKUP DO BANCO — o dump SQL completo da gestão

   Só o ADMIN. Este arquivo contém o instituto inteiro: CPF, endereço e
   prontuário de todo mundo. É o dado mais sensível que existe aqui, e sai do
   servidor pelo navegador de quem clicou.

   O dump sai do próprio pg_dump, no formato SQL de texto — o mesmo que o
   `psql` restaura. Não inventamos formato: um backup que só o nosso código
   sabe ler não é backup.

   Segurança do processo: o pg_dump é chamado por spawn com os argumentos em
   ARRAY e sem shell. Nada do que o usuário digita entra na linha de comando
   (não há o que digitar — a rota não recebe parâmetro), e a senha vai por
   variável de ambiente, nunca por argumento (argumento aparece no `ps` para
   qualquer usuário da máquina).
   ========================================================================== */
function dumpSql(res, sessaoAdmin) {
  const { spawn } = require("node:child_process");
  const cfg = configPg();
  const carimbo = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1-$2");
  const nome = `kenosis-gestao-${carimbo}.sql`;

  /* --no-owner / --no-privileges: o dump precisa restaurar em QUALQUER
     servidor, inclusive num de teste onde o usuário "kenosis" não existe.
     Sem isso, o restore falharia em cada GRANT e cada OWNER TO. */
  const args = ["--no-owner", "--no-privileges", "--clean", "--if-exists",
    "-h", cfg.host || "127.0.0.1", "-p", String(cfg.port || 5432),
    "-U", cfg.user, "-d", cfg.database];

  const pg_dump = process.env.PG_DUMP || "pg_dump";
  const filho = spawn(pg_dump, args, {
    env: { ...process.env, PGPASSWORD: cfg.password || "" },
    windowsHide: true,
  });

  let cabecalhoEnviado = false;
  const enviarCabecalho = () => {
    if (cabecalhoEnviado) return;
    cabecalhoEnviado = true;
    res.writeHead(200, {
      "Content-Type": "application/sql; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    });
  };

  let erro = "";
  filho.stderr.on("data", (d) => { erro += d.toString(); });

  /* O cabeçalho só vai quando o primeiro byte de dump chega. Assim, se o
     pg_dump falhar de cara (binário ausente, senha errada), ainda dá tempo de
     responder um JSON de erro em vez de entregar um arquivo vazio com nome
     bonito — que o usuário guardaria achando que tem backup. */
  filho.stdout.on("data", (bloco) => { enviarCabecalho(); res.write(bloco); });

  filho.on("error", (e) => {
    console.error("  ✖ pg_dump não executou:", e.message);
    if (!cabecalhoEnviado) json(res, 500, {
      error: e.code === "ENOENT"
        ? "O pg_dump não está instalado neste servidor (pacote postgresql-client)."
        : "Não consegui gerar o backup.",
    });
    else res.end();
  });

  filho.on("close", (codigo) => {
    if (codigo === 0) {
      console.log(`  · /restrito: backup SQL baixado por ${sessaoAdmin.nome} (${nome})`);
      enviarCabecalho();
      return res.end();
    }
    console.error(`  ✖ pg_dump saiu com código ${codigo}: ${erro.trim().slice(0, 400)}`);
    if (!cabecalhoEnviado) return json(res, 500, { error: "Não consegui gerar o backup. Veja o log do servidor." });
    /* Já mandamos bytes: não dá para trocar o status. Encerrar de forma abrupta
       é o que faz o navegador marcar o download como FALHOU — melhor um
       download quebrado e visível do que um .sql pela metade que parece bom. */
    res.destroy();
  });
}

/* ------------------------------- API ------------------------------------- */
async function rotaApi(req, res, p) {
  const ip = clientIp(req);

  // login
  if (p === "login" && req.method === "POST") {
    const { usuario, senha } = await readBody(req);
    /* A conta entra na conta: é o e-mail digitado, mesmo que não exista.
       Usar só as contas reais deixaria o atacante varrer nomes de graça. */
    const conta = String(usuario || "").trim().toLowerCase();
    const v = limite.verificar("restrito", ip, conta);
    if (!v.ok) { res.setHeader("Retry-After", String(v.esperar)); return json(res, 429, { error: v.mensagem }); }
    const u = await Q.get("SELECT * FROM g_usuarios WHERE email=? AND ativo=1", conta);
    if (!u || !confereSenha(senha, u.senha_hash)) {
      limite.errou("restrito", ip, conta);
      /* A tentativa SEM SUCESSO é a linha mais importante da trilha: é ela que
         revela alguém tentando entrar. Guarda o login digitado — nunca a senha. */
      auditar({ req, sessao: null, acao: "login_falhou",
        resumo: `Tentativa de entrar como "${String(usuario || "").slice(0, 60)}"`,
        detalhe: { usuario_informado: String(usuario || "").slice(0, 60), existe: !!u } });
      return json(res, 401, { error: "Usuário ou senha incorretos." });
    }
    limite.acertou("restrito", ip, conta);
    const rid = novaSessao(u);
    auditar({ req, sessao: { userId: u.id, nome: u.nome, perfil: u.perfil }, acao: "login",
      resumo: `${u.nome} entrou no sistema` });
    res.setHeader("Set-Cookie", `rid=${rid}; HttpOnly; SameSite=Lax; Path=/restrito; Max-Age=${SESSAO_HORAS * 3600}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
    return json(res, 200, { ok: true, nome: u.nome, perfil: u.perfil });
  }

  // daqui para baixo exige sessão
  const s = sessao(req);
  if (!s) return json(res, 401, { error: "Não autenticado" });

  if (p === "backup/sql" && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Só o administrador pode baixar o backup." });
    auditar({ req, sessao: s, acao: "backup", resumo: `${s.nome} baixou o backup completo do banco` });
    return dumpSql(res, s);
  }

  if (p === "me") return json(res, 200, { nome: s.nome, perfil: s.perfil });

  /* ==========================================================================
     AUDITORIA — a trilha completa, só para o administrador

     ÚNICA LISTA DO SISTEMA QUE PAGINA NO SERVIDOR. As outras devolvem tudo e a
     tela fatia, porque são listas de tamanho humano. A auditoria ganha uma
     linha por ação de cada pessoa, todo dia, para sempre.
     ========================================================================== */
  if (p === "auditoria" && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "A auditoria é exclusiva do administrador." });
    const q = new URL(req.url, "http://x").searchParams;
    const cond = [], args = [];
    const soData = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
    let de = soData(q.get("de")), ate = soData(q.get("ate"));
    if (de && ate && de > ate) { const t = de; de = ate; ate = t; }
    if (de) { cond.push("substr(criado,1,10) >= ?"); args.push(de); }
    if (ate) { cond.push("substr(criado,1,10) <= ?"); args.push(ate); }
    const uid = (q.get("usuario") || "").trim();
    if (/^\d+$/.test(uid)) { cond.push("usuario_id=?"); args.push(Number(uid)); }
    const acao = (q.get("acao") || "").trim();
    if (acao && ACOES_ROTULO[acao]) { cond.push("acao=?"); args.push(acao); }
    const mod = (q.get("modulo") || "").trim();
    if (mod && /^[a-z_]+$/.test(mod)) { cond.push("modulo=?"); args.push(mod); }
    const onde = cond.length ? " WHERE " + cond.join(" AND ") : "";
    const total = (await Q.get(`SELECT COUNT(*) c FROM auditoria${onde}`, ...args)).c;
    const porPagina = Math.min(Math.max(Number(q.get("por")) || 30, 5), 200);
    const pagina = Math.max(Number(q.get("pagina")) || 1, 1);
    const linhas = await Q.all(
      `SELECT * FROM auditoria${onde} ORDER BY criado DESC, id DESC LIMIT ? OFFSET ?`,
      ...args, porPagina, (pagina - 1) * porPagina);
    /* O detalhe (o JSON do antes/depois) NÃO vai na listagem — a tela busca o
       de UMA linha quando o usuário clica. Assim a tabela é leve e o dado
       sensível não trafega sem necessidade. */
    for (const l of linhas) { l.tem_detalhe = !!(l.detalhe && l.detalhe.length > 2); delete l.detalhe; }
    return json(res, 200, {
      total, pagina, porPagina, paginas: Math.max(Math.ceil(total / porPagina), 1), linhas,
      rotulos: ACOES_ROTULO, modulos: MODULO_ROTULO,
      usuarios: await Q.all(`SELECT DISTINCT usuario_id id, usuario_nome nome FROM auditoria
                              WHERE usuario_id IS NOT NULL ORDER BY usuario_nome`),
    });
  }
  const audm = p.match(/^auditoria\/(\d+)$/);
  if (audm && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "A auditoria é exclusiva do administrador." });
    const linha = await Q.get("SELECT * FROM auditoria WHERE id=?", audm[1]);
    if (!linha) return json(res, 404, { error: "Registro não encontrado." });
    let detalhe = null;
    try { detalhe = linha.detalhe ? JSON.parse(linha.detalhe) : null; } catch { detalhe = { texto: linha.detalhe }; }
    return json(res, 200, { ...linha, detalhe, rotulo: ACOES_ROTULO[linha.acao] || linha.acao, modulo_rotulo: rotuloModulo(linha.modulo) });
  }

  /* SOBRE O SISTEMA — versão, histórico, tecnologias e banco ativo.
     Só o admin: a tela descreve a INFRAESTRUTURA (versão do banco, do Node,
     nome da base). Para a equipe isso é ruído; para quem sonda, é mapa. */
  if (p === "sobre" && req.method === "GET") {
    if (s.perfil !== "admin") return json(res, 403, { error: "Tela exclusiva do administrador." });
    let banco = { motor: "PostgreSQL", conectado: false };
    try {
      const v = await Q.get(`SELECT version() v, current_database() d, current_user u,
                                    pg_size_pretty(pg_database_size(current_database())) tam`);
      const num = /PostgreSQL\s+([\d.]+)/.exec(v.v);
      const m = await Q.all("SELECT versao FROM schema_migrations ORDER BY versao");
      banco = { motor: "PostgreSQL", versao: num ? num[1] : "", base: v.d, usuario: v.u,
        tamanho: v.tam, migrations: m.length, ultimaMigration: m.length ? m[m.length - 1].versao : "", conectado: true };
    } catch (e) { banco.erro = String(e.message).split("\n")[0]; }
    return json(res, 200, {
      sistema: "Sistema de Gestão — Instituto Kenósis",
      versao: SISTEMA_VERSION, historico: HISTORICO_VERSOES, tecnologias: TECNOLOGIAS, banco,
    });
  }

  if (p === "logout" && req.method === "POST") {
    const cookies = ["rid=; HttpOnly; Path=/restrito; Max-Age=0"];

    /* Sair do sistema de gestão SAI TAMBÉM do painel do site.

       Quem entrou no /admin pelo atalho de 9 pontos não digitou senha nenhuma
       — a porta foi aberta pela credencial daqui. Se essa credencial for
       embora e a outra ficar, o computador da recepção fica com o painel do
       site destrancado depois que a pessoa "saiu". Num instituto, onde o mesmo
       computador atende o balcão o dia inteiro, é o cenário provável, não o
       raro.

       Encerra só a sessão DESTE navegador (a do cookie que veio na
       requisição), e não todas: derrubar as demais tiraria do ar quem
       estivesse trabalhando no painel de outra máquina, sem nenhum aviso. */
    let saiuDoPainel = false;
    if (typeof encerrarPainelDoSite === "function") {
      const fora = encerrarPainelDoSite(req);
      if (fora) { saiuDoPainel = true; cookies.push("sid=; HttpOnly; Path=/; Max-Age=0"); }
    }

    auditar({ req, sessao: s, acao: "logout",
      resumo: `${s.nome} saiu do sistema${saiuDoPainel ? " (e do painel do site)" : ""}` });
    sessoes.delete(s.rid);
    res.setHeader("Set-Cookie", cookies);
    return json(res, 200, { ok: true, painelEncerrado: saiuDoPainel });
  }

  if (p === "senha" && req.method === "POST") {
    /* Aqui também se adivinha senha: este endereço recebe a senha ATUAL.
       Sem freio, quem chegasse a um cookie de sessão poderia testá-la à
       vontade por aqui, contornando o login. A conta é a de quem está logado. */
    const vS = limite.verificar("troca-senha", ip, String(s.userId));
    if (!vS.ok) { res.setHeader("Retry-After", String(vS.esperar)); return json(res, 429, { error: vS.mensagem }); }
    const { atual, nova } = await readBody(req);
    const u = await Q.get("SELECT * FROM g_usuarios WHERE id=?", s.userId);
    if (!confereSenha(atual, u.senha_hash)) {
      limite.errou("troca-senha", ip, String(s.userId));
      return json(res, 400, { error: "Senha atual incorreta." });
    }
    limite.acertou("troca-senha", ip, String(s.userId));
    if (String(nova || "").length < 8) return json(res, 400, { error: "A nova senha precisa de ao menos 8 caracteres." });
    await Q.run("UPDATE g_usuarios SET senha_hash=? WHERE id=?", hashSenha(nova), s.userId);
    for (const [k, v] of sessoes) if (v.userId === s.userId && k !== s.rid) sessoes.delete(k);
    return json(res, 200, { ok: true });
  }

  // painel: números para a home do sistema. O profissional não vê números
  // globais (só a sua agenda e prontuários) — devolve os dele.
  if (p === "painel") {
    const n = async (sql, ...a) => (await Q.get(sql, ...a)).c;
    const hoje = new Date().toISOString().slice(0, 10);
    if (s.perfil === "profissional") {
      return json(res, 200, { profissional: true,
        agendaHoje: await n("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=? AND data=?", s.profissionalId, hoje),
        agendaTotal: await n("SELECT COUNT(*) c FROM atendimentos WHERE profissional_id=?", s.profissionalId),
        prontuarios: await n("SELECT COUNT(*) c FROM prontuario WHERE profissional_id=?", s.profissionalId) });
    }
    return json(res, 200, {
      pacientes: await n("SELECT COUNT(*) c FROM pacientes"),
      associados: await n("SELECT COUNT(*) c FROM associados"),
      atendimentosHoje: await n("SELECT COUNT(*) c FROM atendimentos WHERE data=?", hoje),
      eventos: await n("SELECT COUNT(*) c FROM eventos"),
      beneficios: await n("SELECT COUNT(*) c FROM beneficios"),
    });
  }

  // relatórios (3.5): agregações para a tela de indicadores
  /* ========================================================================
     RELAÇÃO DE USUÁRIOS ATIVOS / INATIVOS

     Serve para o instituto ligar, convidar de volta ou visitar: nome, endereço
     completo, telefone, o projeto a que está vinculado, os serviços que já
     recebeu e quem o atendeu. É a relação que a coordenação pede para retomar
     contato e a que instrui o relatório de execução dos projetos.

     Os serviços e os profissionais são levantados por usuário porque vêm de
     duas origens (agenda e prontuário) e uma delas guarda lista JSON, que o SQL
     não agrupa. São listas de tamanho humano — algumas centenas de linhas —,
     não uma varredura de banco inteiro por linha.
     ======================================================================== */
  if (p === "relatorios/pacientes") {
    if (!pode(s.perfil, "relatorios")) return json(res, 403, { error: "Sem permissão." });
    const q = new URL(req.url, "http://x").searchParams;
    const at = (q.get("ativo") || "").trim();
    const cond = at === "1" ? " WHERE COALESCE(ativo,1)<>0" : at === "0" ? " WHERE COALESCE(ativo,1)=0" : "";
    const pacs = await Q.all(`SELECT * FROM pacientes${cond} ORDER BY nome`);

    const projetos = new Map((await Q.all("SELECT id, title FROM projetos")).map((x) => [Number(x.id), x.title]));
    const juntar = (lista) => [...new Set(lista.filter((x) => x && String(x).trim()))].sort();
    /* A lista de serviços de um atendimento é JSON: quebra aqui, no mesmo lugar
       em que o relatório geral já faz isso. */
    const abrirServicos = (v) => {
      try { const a = JSON.parse(v || "[]"); return Array.isArray(a) ? a : (v ? [v] : []); }
      catch { return v ? [String(v)] : []; }
    };

    for (const pc of pacs) {
      const ats = await Q.all(
        `SELECT a.especialidade, pf.nome prof FROM atendimentos a
          LEFT JOIN profissionais pf ON pf.id=a.profissional_id WHERE a.paciente_id=?`, pc.id);
      const prs = await Q.all("SELECT especialidade, profissional FROM prontuario WHERE paciente_id=?", pc.id);
      pc.servicos = juntar([...ats.flatMap((x) => abrirServicos(x.especialidade)),
                            ...prs.flatMap((x) => abrirServicos(x.especialidade))]);
      pc.profissionais = juntar([...ats.map((x) => x.prof), ...prs.map((x) => x.profissional)]);
      pc.projeto_nome = pc.projeto_id ? (projetos.get(Number(pc.projeto_id)) || "") : "";
      pc.atendimentos = ats.length;
      /* O CPF entra na relação só pelos últimos dígitos: ela é impressa e
         circula pela equipe, e o número inteiro no papel não tem função aqui. */
      pc.cpf_final = pc.cpf ? String(pc.cpf).replace(/\D/g, "").slice(-4) : "";
      delete pc.cpf; delete pc.rg; delete pc.foto;      // não vão para esta tela
    }
    return json(res, 200, {
      filtro: at === "1" ? "Ativos" : at === "0" ? "Inativos" : "Todos",
      total: pacs.length,
      ativos: pacs.filter((x) => Number(x.ativo ?? 1) !== 0).length,
      pacientes: pacs,
    });
  }

  if (p === "relatorios") {
    if (!pode(s.perfil, "relatorios")) return json(res, 403, { error: "Sem permissão." });
    const q = new URL(req.url, "http://x").searchParams;
    const soData = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
    const de = soData(q.get("de")), ate = soData(q.get("ate"));
    /* Monta o recorte por data para uma coluna. Vai como texto na consulta, e
       não como parâmetro, porque cada pedaço é opcional — mas nada do usuário
       entra cru: `soData` só deixa passar AAAA-MM-DD, e o que não casa com esse
       formato vira string vazia. */
    const corte = (col, alias) => {
      const c = alias ? `${alias}.${col}` : col;
      const partes = [`${c} IS NOT NULL`, `${c} <> ''`];
      if (de) partes.push(`substr(${c},1,10) >= '${de}'`);
      if (ate) partes.push(`substr(${c},1,10) <= '${ate}'`);
      return (de || ate) ? partes.join(" AND ") : "1=1";
    };
    const onde = (col, alias) => ` WHERE ${corte(col, alias)}`;
    const e = (col, alias) => ` AND ${corte(col, alias)}`;
    const grupo = (sql) => Q.all(sql);
    const n = async (sql) => (await Q.get(sql)).c;
    /* A contagem por serviço não sai numa consulta SQL: um atendimento guarda
       VÁRIOS serviços numa lista JSON, e é preciso quebrar cada lista. Feito
       antes do json() porque agora depende de await. */
    const porEspecialidade = await (async () => {
        const conta = {};
        for (const a of await Q.all("SELECT especialidade FROM atendimentos" + onde("data"))) {
          let itens = [];
          try { itens = JSON.parse(a.especialidade || "[]"); if (!Array.isArray(itens)) itens = []; }
          catch { itens = a.especialidade ? [a.especialidade] : []; }   // compat: valor antigo era texto
          if (!itens.length) itens = ["(sem serviço)"];
          for (const it of itens) conta[it] = (conta[it] || 0) + 1;
        }
        return Object.entries(conta).map(([rotulo, total]) => ({ rotulo, total })).sort((x, y) => y.total - x.total);
    })();
    return json(res, 200, {
      periodo: { de, ate },
      totais: {
        /* Cada contagem é recortada pela data que FAZ SENTIDO nela: o cadastro
           do usuário pela data em que entrou (`criado`), o atendimento pelo dia
           marcado, a entrega do benefício pelo dia da entrega. Usar a mesma
           coluna em tudo daria número que não bate com a tela de origem. */
        pacientes: await n("SELECT COUNT(*) c FROM pacientes" + onde("criado")),
        associados: await n("SELECT COUNT(*) c FROM associados" + onde("adesao")),
        atendimentos: await n("SELECT COUNT(*) c FROM atendimentos" + onde("data")),
        faltas: await n("SELECT COUNT(*) c FROM atendimentos WHERE status='Faltou'" + e("data")),
        eventos: await n("SELECT COUNT(*) c FROM eventos" + onde("data")),
        beneficios: await n("SELECT COUNT(*) c FROM beneficios" + onde("data")),
      },
      porEspecialidade,
      porStatus: await grupo("SELECT COALESCE(NULLIF(status,''),'(sem status)') rotulo, COUNT(*) total FROM atendimentos" + onde("data") + " GROUP BY rotulo ORDER BY total DESC"),
      porMes: await grupo("SELECT substr(data,1,7) rotulo, COUNT(*) total FROM atendimentos" + onde("data") + " GROUP BY rotulo ORDER BY rotulo DESC LIMIT 12"),
    });
  }

  // upload de arquivo/foto (fica no diretório privado do /restrito)
  if (p === "upload" && req.method === "POST") {
    const { name, dataUrl } = await readBody(req);
    const m = /^data:(image\/(?:png|jpe?g|webp)|application\/pdf);base64,(.+)$/.exec(dataUrl || "");
    if (!m) return json(res, 400, { error: "Envie imagem (png/jpg/webp) ou PDF." });
    const ext = m[1] === "application/pdf" ? ".pdf" : "." + m[1].split("/")[1].replace("jpeg", "jpg");
    const safe = String(name || "arq").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "arq";
    const file = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${safe}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, file), Buffer.from(m[2], "base64"));
    return json(res, 200, { ok: true, path: `/restrito/arquivos/${file}` });
  }

  /* ------- Usuários do sistema (perfis de acesso) — só o admin ---------- */
  if (p === "usuarios" || /^usuarios\/\d+$/.test(p)) {
    if (s.perfil !== "admin") return json(res, 403, { error: "Apenas o administrador gerencia usuários." });
    const idm = p.match(/^usuarios\/(\d+)$/);
    const id = idm ? idm[1] : null;
    // nunca devolvemos o hash da senha
    if (req.method === "GET" && !id) return json(res, 200, await Q.all("SELECT id,nome,email,perfil,ativo,profissional_id,foto FROM g_usuarios ORDER BY id"));
    if (req.method === "GET" && id) return json(res, 200, await Q.get("SELECT id,nome,email,perfil,ativo,profissional_id,foto FROM g_usuarios WHERE id=?", id) || {});
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      const nome = String(b.nome || "").trim(), email = String(b.email || "").trim(), perfil = String(b.perfil || "secretaria").trim();
      if (!nome || !email) return json(res, 400, { error: "Nome e usuário (login) são obrigatórios." });
      if (!PERFIS.includes(perfil)) return json(res, 400, { error: "Perfil inválido." });
      if (String(b.senha || "").length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." });
      const profId = perfil === "profissional" && b.profissional_id ? Number(b.profissional_id) : null;
      try {
        await Q.run("INSERT INTO g_usuarios(nome,email,senha_hash,perfil,ativo,profissional_id,foto,criado) VALUES(?,?,?,?,?,?,?,?)", nome, email, hashSenha(b.senha), perfil, b.ativo === undefined ? 1 : (Number(b.ativo) ? 1 : 0), profId, String(b.foto || ""), agora());
      } catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao criar usuário." }); }
      equipeMudou("usuário criado");
      return json(res, 200, { ok: true });
    }
    if (req.method === "PUT" && id) {
      const b = await readBody(req);
      const alvo = await Q.get("SELECT perfil,ativo FROM g_usuarios WHERE id=?", id);
      if (!alvo) return json(res, 404, { error: "Usuário não encontrado." });
      // não deixar o único admin ativo se rebaixar a si mesmo ou desativar
      const viraNaoAdmin = b.perfil !== undefined && b.perfil !== "admin";
      const viraInativo = b.ativo !== undefined && !Number(b.ativo);
      if (alvo.perfil === "admin" && alvo.ativo && (viraNaoAdmin || viraInativo) && (await adminsAtivos()) <= 1)
        return json(res, 400, { error: "Não é possível rebaixar ou desativar o único administrador." });
      const sets = [], args = [];
      if (b.nome !== undefined) { sets.push("nome=?"); args.push(String(b.nome).trim()); }
      if (b.email !== undefined) { sets.push("email=?"); args.push(String(b.email).trim()); }
      if (b.perfil !== undefined) { if (!PERFIS.includes(b.perfil)) return json(res, 400, { error: "Perfil inválido." }); sets.push("perfil=?"); args.push(b.perfil); }
      if (b.ativo !== undefined) { sets.push("ativo=?"); args.push(Number(b.ativo) ? 1 : 0); }
      if (b.profissional_id !== undefined) { sets.push("profissional_id=?"); args.push(b.profissional_id ? Number(b.profissional_id) : null); }
      /* A foto é um CAMINHO do upload privado (/restrito/arquivos/…), nunca o
         arquivo em si — e vazia limpa o retrato. */
      if (b.foto !== undefined) { sets.push("foto=?"); args.push(String(b.foto || "")); }
      if (b.senha) { if (String(b.senha).length < 8) return json(res, 400, { error: "A senha precisa de ao menos 8 caracteres." }); sets.push("senha_hash=?"); args.push(hashSenha(b.senha)); }
      if (sets.length) {
        try { await Q.run(`UPDATE g_usuarios SET ${sets.join(",")} WHERE id=?`, ...args, id); }
        catch (e) { return json(res, 400, { error: /UNIQUE/.test(e.message) ? "Já existe um usuário com esse login." : "Erro ao salvar." }); }
        equipeMudou("usuário editado");
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (Number(id) === s.userId) return json(res, 400, { error: "Você não pode excluir o próprio usuário." });
      const alvo = await Q.get("SELECT perfil,ativo FROM g_usuarios WHERE id=?", id);
      if (alvo && alvo.perfil === "admin" && alvo.ativo && (await adminsAtivos()) <= 1) return json(res, 400, { error: "Não é possível excluir o único administrador." });
      await Q.run("DELETE FROM g_usuarios WHERE id=?", id);
      equipeMudou("usuário excluído");
      return json(res, 200, { ok: true });
    }
  }

  // Gerar/atualizar a senha do portal do associado — só admin e secretaria.
  const sm = p.match(/^associados\/(\d+)\/senha$/);
  if (sm && req.method === "POST") {
    if (!["admin", "secretaria"].includes(s.perfil)) return json(res, 403, { error: "Sem permissão." });
    const nova = String(crypto.randomInt(10000000, 100000000));   // 8 dígitos
    await Q.run("UPDATE associados SET senha_externo=? WHERE id=?", hashSenha(nova), sm[1]);   // guarda o hash
    return json(res, 200, { ok: true, senha: nova });                                           // devolve o texto uma vez
  }

  /* ========================================================================
     PRONTUÁRIO COMPLETO DE UMA PESSOA — a linha do tempo inteira

     Alimenta a impressão do acompanhamento: todas as pastas, cada uma com os
     seus lançamentos em ordem e os agendamentos que a compõem.
     ======================================================================== */
  const hm = p.match(/^historico\/(\d+)$/);
  if (hm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pac = await Q.get("SELECT * FROM pacientes WHERE id=?", hm[1]);
    if (!pac) return json(res, 404, { error: "Usuário não encontrado." });
    const proj = pac.projeto_id ? await Q.get("SELECT title FROM projetos WHERE id=?", pac.projeto_id) : null;
    /* O recorte por dono entra AQUI também. Este é o caminho mais perigoso dos
       que servem prontuário: se falhasse, o profissional imprimiria o
       acompanhamento inteiro da pessoa, incluindo o conduzido por colegas. */
    const dono = filtroDono(s);
    const pastas = await Q.all(
      `SELECT * FROM prontuario WHERE paciente_id=?${dono.sql} ORDER BY status, especialidade, id`,
      hm[1], ...dono.args);
    for (const pasta of pastas) {
      pasta.registros = await Q.all(
        "SELECT * FROM prontuario_registros WHERE prontuario_id=? AND arquivado=0 ORDER BY COALESCE(NULLIF(data,''),criado), id",
        pasta.id);
      pasta.atendimentos = await Q.all(
        `SELECT a.*, pf.nome profissional_nome FROM atendimentos a
           LEFT JOIN profissionais pf ON pf.id=a.profissional_id
          WHERE a.prontuario_id=? ORDER BY a.data, a.hora, a.id`, pasta.id);
    }
    return json(res, 200, {
      paciente: { ...pac, projeto_nome: proj ? proj.title : "" },
      prontuarios: pastas,
      /* A linha do tempo da PESSOA reúne o que aconteceu em todas as pastas, de
         todos os profissionais — para o profissional ela fica fora por inteiro,
         senão seria a porta dos fundos do recorte que acabamos de aplicar. */
      historico: soDoProfissional(s) ? []
        : await Q.all("SELECT * FROM historico WHERE entidade='paciente' AND entidade_id=? ORDER BY criado, id", hm[1]),
    });
  }

  /* ---------------- Alta e reabertura da pasta -------------------------
     A alta é DA PASTA: a pessoa pode concluir o acompanhamento no Serviço
     Social e seguir na Psicologia. Nada é apagado — muda a situação e fica
     registrado na linha do tempo. */
  const am = p.match(/^prontuario\/(\d+)\/(alta|reabrir)$/);
  if (am && req.method === "POST") {
    if (!pode(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", am[1]);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    /* Dar alta ou reabrir é MEXER no acompanhamento de alguém. Sem esta guarda
       um profissional encerraria o que outro conduz. */
    const recusa = recusaPorDono(s, pr);
    if (recusa) return json(res, 403, { error: recusa });
    const b = await readBody(req);
    if (am[2] === "alta") {
      const quando = b.data || new Date().toISOString().slice(0, 10);
      await Q.run("UPDATE prontuario SET status='Alta', alta_em=?, alta_motivo=? WHERE id=?",
        quando, cifrar(b.motivo || ""), am[1]);
      await anotar("prontuario", am[1], "Alta", `${pr.especialidade}${b.motivo ? " — " + b.motivo : ""}`, s);
      await anotar("paciente", pr.paciente_id, "Alta em " + pr.especialidade, pr.numero || "", s);
      auditar({ req, sessao: s, acao: "alta", modulo: "prontuario", entidadeId: Number(am[1]),
        resumo: `Deu alta no prontuário ${pr.numero || ""} · ${pr.especialidade}`,
        detalhe: { numero: pr.numero, servico: pr.especialidade, motivo: b.motivo || "" } });
    } else {
      const quando = agora();
      await Q.run("UPDATE prontuario SET status='Ativo', alta_em=NULL, alta_motivo=NULL, reativado_em=? WHERE id=?", quando, am[1]);
      await anotar("prontuario", am[1], "Prontuário reaberto", `${pr.especialidade}${b.motivo ? " — " + b.motivo : ""}`, s);
      await anotar("paciente", pr.paciente_id, "Retornou ao acompanhamento", pr.especialidade, s);
      auditar({ req, sessao: s, acao: "reabrir", modulo: "prontuario", entidadeId: Number(am[1]),
        resumo: `Reabriu o prontuário ${pr.numero || ""} · ${pr.especialidade}`,
        detalhe: { numero: pr.numero, servico: pr.especialidade, motivo: b.motivo || "" } });
    }
    return json(res, 200, { ok: true });
  }

  /* ---- Vincular / desvincular um agendamento à pasta, pela tela da pasta.
     É o caminho para o primeiro agendamento, marcado antes de a pasta existir,
     e para os que têm mais de um serviço (que o sistema não liga sozinho). */
  const vm = p.match(/^prontuario\/(\d+)\/atendimentos\/(\d+)$/);
  if (vm && (req.method === "POST" || req.method === "DELETE")) {
    if (!pode(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", vm[1]);
    const at = await Q.get("SELECT * FROM atendimentos WHERE id=?", vm[2]);
    if (!pr || !at) return json(res, 404, { error: "Prontuário ou agendamento não encontrado." });
    const recusa = recusaPorDono(s, pr);
    if (recusa) return json(res, 403, { error: recusa });
    if (req.method === "POST") {
      // a pasta é da pessoa: não se pendura nela o agendamento de outra
      if (String(at.paciente_id) !== String(pr.paciente_id))
        return json(res, 400, { error: "Este agendamento é de outro usuário." });
      await Q.run("UPDATE atendimentos SET prontuario_id=? WHERE id=?", pr.id, at.id);
      await anotar("prontuario", pr.id, "Agendamento vinculado", `${at.data || ""} ${at.hora || ""}`.trim(), s);
    } else {
      await Q.run("UPDATE atendimentos SET prontuario_id=NULL WHERE id=?", at.id);
      await anotar("prontuario", pr.id, "Agendamento desvinculado", `${at.data || ""} ${at.hora || ""}`.trim(), s);
    }
    return json(res, 200, { ok: true });
  }

  /* Agendamentos da pessoa que ainda não estão em pasta nenhuma — a lista que
     a tela oferece para vincular. */
  const dm = p.match(/^prontuario\/(\d+)\/disponiveis$/);
  if (dm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", dm[1]);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    const recusa = recusaPorDono(s, pr);
    if (recusa) return json(res, 403, { error: recusa });
    return json(res, 200, await Q.all(
      `SELECT a.*, pf.nome profissional_nome FROM atendimentos a
         LEFT JOIN profissionais pf ON pf.id=a.profissional_id
        WHERE a.paciente_id=? AND a.prontuario_id IS NULL
        ORDER BY a.data DESC, a.hora DESC, a.id DESC`, pr.paciente_id));
  }

  /* ======================================================================
     ARQUIVAR E RESTAURAR — pessoa, pasta e lançamento pela MESMA rota

     Uma rota para as três, porque é a mesma operação: `arquivado` vira 1, a
     linha some das listas e volta num clique. Três rotas parecidas
     divergiriam — e a que ficasse para trás esqueceria de registrar no
     histórico, que é o que responde "quem tirou isto da tela".

     NADA É APAGADO. Arquivar é organização, não exclusão: o registro continua
     inteiro no banco, sai nos backups e é lido pela tela de Arquivados.

     PERMISSÃO POR TABELA, não uma só para todas: a secretaria organiza a
     lista de pessoas atendidas mas não entra no prontuário; o profissional
     organiza as pastas DELE e não mexe na lista de pessoas.
     ====================================================================== */
  const ARQUIVAVEIS = {
    pacientes: { perm: "pacientes", oQue: "Usuário", entidade: "paciente" },
    prontuario: { perm: "prontuario", oQue: "Prontuário", entidade: "prontuario" },
    prontuario_registros: { perm: "prontuario", oQue: "Lançamento", entidade: "prontuario" },
  };
  const rm = p.match(/^(pacientes|prontuario|prontuario_registros)\/(\d+)\/(arquivar|restaurar)$/);
  if (rm && req.method === "POST") {
    const def = ARQUIVAVEIS[rm[1]];
    if (!pode(s.perfil, def.perm)) return json(res, 403, { error: "Sem permissão." });
    const arq = rm[3] === "arquivar";
    const linha = await Q.get(`SELECT * FROM ${rm[1]} WHERE id=?`, rm[2]);
    if (!linha) return json(res, 404, { error: def.oQue + " não encontrado." });

    /* O RECORTE DO PROFISSIONAL vale aqui como vale na leitura: ele só
       organiza o que é dele. Sem isto, quem não pode nem VER a pasta de outro
       poderia fazê-la sumir da tela de todo mundo. */
    if (s.perfil === "profissional") {
      if (rm[1] === "prontuario_registros" && String(linha.usuario_id) !== String(s.userId))
        return json(res, 403, { error: "Lançamento de outro profissional." });
      if (rm[1] === "prontuario") {
        const recusa = recusaPorDono(s, linha);
        if (recusa) return json(res, 403, { error: recusa });
      }
    }

    await Q.run(`UPDATE ${rm[1]} SET arquivado=?, arquivado_em=? WHERE id=?`,
      arq ? 1 : 0, arq ? agora() : null, rm[2]);

    /* Quem arquivou e quando entram na linha do tempo. Arquivar tira da vista
       — e "sumiu da lista" sem registro é a diferença entre um sistema que se
       explica e um que faz alguém desconfiar do banco. */
    const alvoHist = rm[1] === "prontuario_registros" ? linha.prontuario_id : linha.id;
    const nome = rm[1] === "prontuario_registros" ? rotuloTipo(linha.tipo)
               : rm[1] === "prontuario" ? (linha.numero || linha.especialidade || "")
               : (linha.nome || "");
    await anotar(def.entidade, alvoHist,
      def.oQue + (arq ? " arquivado" : " restaurado") + (nome ? ": " + nome : ""), "", s);
    return json(res, 200, { ok: true, arquivado: arq ? 1 : 0 });
  }

  /* --------- Linha do tempo de uma pessoa ou de uma pasta --------------- */
  const hm2 = p.match(/^historico\/(paciente|prontuario)\/(\d+)$/);
  if (hm2 && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    /* O histórico guarda trechos do que foi escrito. Para o profissional, só o
       da pasta DELE — e o da pessoa fica fora por inteiro, porque reúne o que
       aconteceu em todas as pastas. Sem isto bastaria pedir o histórico para
       ler o que a tela escondeu. */
    if (soDoProfissional(s)) {
      if (hm2[1] === "paciente") return json(res, 200, []);
      const pr = await Q.get("SELECT profissional_id FROM prontuario WHERE id=?", hm2[2]);
      if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
      const recusa = recusaPorDono(s, pr);
      if (recusa) return json(res, 403, { error: recusa });
    }
    return json(res, 200, await Q.all(
      "SELECT * FROM historico WHERE entidade=? AND entidade_id=? ORDER BY criado DESC, id DESC", hm2[1], hm2[2]));
  }

  /* ------- Pastas de uma pessoa, com a contagem do que há dentro -------
     Alimenta os "chips" que aparecem no agendamento e na tela da pessoa. */
  const pm2 = p.match(/^pacientes\/(\d+)\/prontuarios$/);
  if (pm2 && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const dono = filtroDono(s, "pr.profissional_id");
    return json(res, 200, await Q.all(
      `SELECT pr.*,
          (SELECT COUNT(*) FROM prontuario_registros r WHERE r.prontuario_id=pr.id AND r.arquivado=0) lancamentos,
          (SELECT COUNT(*) FROM atendimentos at WHERE at.prontuario_id=pr.id) atendimentos
         FROM prontuario pr WHERE pr.paciente_id=?${dono.sql} ORDER BY pr.status, pr.especialidade`,
      pm2[1], ...dono.args));
  }

  /* ------- O que está pendurado numa pasta (tela do prontuário) --------- */
  const vlm = p.match(/^prontuario\/(\d+)\/vinculos$/);
  if (vlm && req.method === "GET") {
    if (!podeLer(s.perfil, "prontuario")) return json(res, 403, { error: "Sem permissão." });
    const pr = await Q.get("SELECT * FROM prontuario WHERE id=?", vlm[1]);
    if (!pr) return json(res, 404, { error: "Prontuário não encontrado." });
    const recusa = recusaPorDono(s, pr);
    if (recusa) return json(res, 403, { error: recusa });
    const pac = await Q.get("SELECT id,nome,nascimento,telefone,projeto_id,ativo FROM pacientes WHERE id=?", pr.paciente_id);
    return json(res, 200, {
      prontuario: pr,
      paciente: pac || null,
      atendimentos: await Q.all(
        `SELECT a.*, pf.nome profissional_nome FROM atendimentos a
           LEFT JOIN profissionais pf ON pf.id=a.profissional_id
          WHERE a.prontuario_id=? ORDER BY a.data DESC, a.hora DESC, a.id DESC`, pr.id),
    });
  }

  /* ========================================================================
     INATIVAR / REATIVAR O USUÁRIO ATENDIDO

     Inativar é o "arquivar" da ficha: a pessoa some das telas de escolha
     (agenda, prontuário, benefícios) e da lista de ativos, mas NADA é apagado
     — ficha, prontuários, benefícios recebidos e histórico continuam inteiros.
     Numa OSC isso importa: o registro de quem foi atendido é o que sustenta a
     prestação de contas dos projetos.

     A coluna `ativo` fica de fora do CRUD genérico de propósito. Se estivesse
     em TAB.pacientes, qualquer edição comum de ficha poderia desligar alguém
     sem passar por aqui — sem motivo registrado e sem entrar na auditoria.
     ======================================================================== */
  const pm = p.match(/^pacientes\/(\d+)\/(inativar|reativar)$/);
  if (pm && req.method === "POST") {
    if (!pode(s.perfil, "pacientes")) return json(res, 403, { error: "Sem permissão." });
    const id = pm[1], inativar = pm[2] === "inativar";
    const pac = await Q.get("SELECT id,nome FROM pacientes WHERE id=?", id);
    if (!pac) return json(res, 404, { error: "Usuário não encontrado." });
    const b = await readBody(req);
    const quem = String(pac.nome || "(sem nome)");
    if (inativar) {
      /* Avisa se havia atendimento marcado daqui para a frente. Não impede — a
         pessoa pode simplesmente ter deixado de vir —, mas quem inativa precisa
         saber que existe horário reservado que ninguém vai ocupar. */
      const futuros = (await Q.get(
        "SELECT COUNT(*) c FROM atendimentos WHERE paciente_id=? AND data >= ? AND status NOT IN ('Atendido','Faltou')",
        id, new Date().toISOString().slice(0, 10))).c;
      await Q.run("UPDATE pacientes SET ativo=0, inativo_em=?, inativo_motivo=? WHERE id=?", agora(), b.motivo || "", id);
      auditar({ req, sessao: s, acao: "inativar", modulo: "pacientes", entidadeId: Number(id),
        resumo: `Inativou o usuário ${quem}`,
        detalhe: { motivo: b.motivo || "", atendimentos_futuros: futuros } });
      return json(res, 200, { ok: true, atendimentosFuturos: futuros });
    }
    await Q.run("UPDATE pacientes SET ativo=1, inativo_em=NULL, inativo_motivo=NULL, reativado_em=? WHERE id=?", agora(), id);
    auditar({ req, sessao: s, acao: "reativar", modulo: "pacientes", entidadeId: Number(id),
      resumo: `Reativou o usuário ${quem}`, detalhe: { motivo: b.motivo || "" } });
    return json(res, 200, { ok: true });
  }

  /* ========================================================================
     BLOQUEAR / LIBERAR O ACESSO DO PROFISSIONAL

     `profissionais.ativo` já existia, mas só escondia o nome das telas de
     agendamento — o LOGIN dele continuava valendo. Bloquear alguém e ele
     seguir entrando é o pior dos dois mundos: quem bloqueou acha que resolveu.

     Agora a trava é de verdade: desliga o login vinculado e derruba a sessão
     que estiver aberta naquele instante. Nada é apagado; o histórico do
     profissional e os registros dele continuam onde estão.
     ======================================================================== */
  const bm = p.match(/^profissionais\/(\d+)\/(bloquear|liberar)$/);
  if (bm && req.method === "POST") {
    if (!pode(s.perfil, "profissionais")) return json(res, 403, { error: "Sem permissão." });
    const id = bm[1], bloquear = bm[2] === "bloquear";
    const prof = await Q.get("SELECT id,nome FROM profissionais WHERE id=?", id);
    if (!prof) return json(res, 404, { error: "Profissional não encontrado." });
    await Q.run("UPDATE profissionais SET ativo=? WHERE id=?", bloquear ? 0 : 1, id);

    // o login que aponta para este profissional acompanha o bloqueio
    const u = await Q.get("SELECT id FROM g_usuarios WHERE profissional_id=?", id);
    if (u) {
      await Q.run("UPDATE g_usuarios SET ativo=? WHERE id=?", bloquear ? 0 : 1, u.id);
      equipeMudou(bloquear ? "profissional bloqueado" : "profissional liberado");
      // sessão aberta continuaria valendo até expirar: encerra agora
      if (bloquear) for (const [k, v] of sessoes) if (v.userId === u.id) sessoes.delete(k);
    }
    auditar({ req, sessao: s, acao: bloquear ? "bloquear" : "desbloquear", modulo: "profissionais",
      entidadeId: Number(id),
      resumo: `${bloquear ? "Bloqueou" : "Liberou"} o acesso de ${prof.nome || ""}`,
      detalhe: { login_vinculado: u ? "sim" : "não" } });
    return json(res, 200, { ok: true, tinhaLogin: !!u });
  }

  // CRUD genérico: /api/<tabela>[/<id>]
  const m = p.match(/^([a-z_]+)(?:\/(\d+))?$/);
  if (m && TAB[m[1]]) {
    const tabela = m[1], id = m[2], cols = TAB[tabela];
    // leitura precisa de podeLer (o profissional lê pacientes p/ o seletor);
    // qualquer escrita exige acesso pleno ao módulo.
    if (!podeLer(s.perfil, tabela)) return json(res, 403, { error: "Seu perfil não tem acesso a este módulo." });
    if (req.method !== "GET" && !pode(s.perfil, tabela)) return json(res, 403, { error: "Seu perfil não pode alterar este módulo." });

    /* ====================================================================
       O QUE O PROFISSIONAL PODE VER

       REGRA: o profissional vê APENAS os prontuários dele. Nunca, em nenhuma
       tela, os de outro profissional.

       Até aqui "seu prontuário" era o que ele tinha CRIADO (usuario_id). Isso
       errava dos dois lados: se a recepção lançava o atendimento, o
       profissional perdia de vista o próprio registro; e se um profissional
       cadastrava algo para outro, passava a ver o que não era dele. Autoria
       não é responsabilidade.

       Agora o dono é `profissional_id` — o mesmo vínculo que a agenda já usa
       (g_usuarios.profissional_id). Ver a migration 003.

       `admin` e `secretaria` não são afetados: a secretaria não abre prontuário
       (barrado por PERM) e o admin vê tudo por função.
       ==================================================================== */
    let donoCol = null, donoVal = null;
    if (s.perfil === "profissional" && (tabela === "prontuario" || tabela === "atendimentos")) {
      donoCol = "profissional_id";
      donoVal = s.profissionalId;
      /* Login de profissional SEM vínculo não tem como dizer o que é dele. O
         lado seguro do erro é não mostrar nada — e precisa ser explícito,
         porque comparar null com null passaria batido nas guardas abaixo. */
      if (!donoVal) return json(res, 403, {
        error: "Seu acesso não está vinculado a um profissional. Fale com o administrador." });
    }
    /* No LANÇAMENTO o dono é quem escreveu. É diferente da pasta de propósito:
       dentro de uma pasta compartilhada, cada profissional responde pelo que
       ele próprio registrou, e ninguém reescreve o texto de outro. */
    if (s.perfil === "profissional" && tabela === "prontuario_registros") {
      donoCol = "usuario_id"; donoVal = s.userId;
    }

    /* Lançamento não se EXCLUI — arquiva-se (POST .../arquivar). Registro de
       acompanhamento é documento: some da tela, continua no banco. Sem esta
       linha o CRUD genérico ofereceria o DELETE de graça. */
    if (tabela === "prontuario_registros" && req.method === "DELETE") return json(res, 400, {
      error: "Lançamento não é excluído — use Arquivar. Ele sai da tela e continua guardado." });

    // abrir uma tela é uma listagem: registra "fulano abriu Usuários"
    if (req.method === "GET" && !id) registrarAcesso(req, s, tabela);

    if (req.method === "GET" && !id) {
      const q = new URL(req.url, "http://x").searchParams;
      const busca = (q.get("q") || "").trim();
      let sql = `SELECT * FROM ${tabela}`;
      const cond = [], args = [];
      let filtrarNaMemoria = false;
      /* ================================================================
         BUSCA POR CPF DEPOIS DA CRIPTOGRAFIA

         O CPF é gravado cifrado com um vetor aleatório próprio, então o mesmo
         número tem texto diferente em cada linha — não há o que comparar no
         SQL. O recorte por CPF passou para a APLICAÇÃO, depois de decifrar,
         o que preserva inclusive a busca por PARTE do número.

         O NOME continua filtrado no banco quando a busca não tem dígitos; com
         dígitos, a lista inteira sobe e o filtro acontece em memória — é
         viável porque quem pagina aqui é a tela, não o SQL.
         ================================================================ */
      if (busca && (tabela === "pacientes" || tabela === "associados")) {
        filtrarNaMemoria = true;
      }
      if (donoCol) { cond.push(donoCol + "=?"); args.push(donoVal); }

      /* ================================================================
         ARQUIVADO SOME DA LISTA

         Um parâmetro, três valores — e não dois parâmetros parecidos, que é
         como alguém acaba usando o errado:

             (ausente)          só o que NÃO está arquivado   ← o dia a dia
             ?arquivados=1      inclui os arquivados          ← já era assim
                                                                nos lançamentos
             ?arquivados=so     SÓ os arquivados              ← a tela nova

         `so` é o que a tela de Arquivados pede. Sem ele, ela teria de trazer
         tudo e filtrar no navegador — e a lista inteira de pessoas atendidas
         viajaria pelo fio para mostrar as três que foram arquivadas.
         ================================================================ */
      if (TEM_ARQUIVO.has(tabela)) {
        const modo = q.get("arquivados");
        if (modo === "so") cond.push("arquivado=1");
        else if (modo !== "1") cond.push("arquivado=0");
      }
      /* Os lançamentos são sempre pedidos de DENTRO de uma pasta; devolver a
         tabela inteira misturaria o acompanhamento de todo mundo numa lista só. */
      if (tabela === "prontuario_registros") {
        const pid = q.get("prontuario_id");
        if (!/^\d+$/.test(String(pid || ""))) return json(res, 400, { error: "Informe o prontuário." });
        const pasta = await Q.get("SELECT * FROM prontuario WHERE id=?", pid);
        if (!pasta) return json(res, 404, { error: "Prontuário não encontrado." });
        const recusaLista = recusaPorDono(s, pasta);
        if (recusaLista) return json(res, 403, { error: recusaLista });
        cond.push("prontuario_id=?"); args.push(Number(pid));
        /* O filtro de arquivado desta tabela é o mesmo das outras e está
           logo acima, em TEM_ARQUIVO — antes vivia aqui, sozinho, e foi de
           onde saiu a regra. */
      }
      if (cond.length) sql += " WHERE " + cond.join(" AND ");
      /* O acompanhamento se lê do mais recente para o mais antigo — mas por
         DATA do lançamento, não por ordem de digitação: quem registra hoje uma
         sessão da semana passada não pode aparecer como a última. */
      sql += tabela === "prontuario_registros"
        ? " ORDER BY COALESCE(NULLIF(data,''),criado) DESC, id DESC"
        : " ORDER BY id DESC";
      let linhas = await Q.all(sql, ...args);

      /* Recorte por nome ou CPF, agora que as linhas voltaram decifradas.
         Mesmas regras de antes: casa em qualquer parte do texto, ignora
         maiúsculas, e o CPF casa com ou sem máscara (compara só os dígitos). */
      if (filtrarNaMemoria) {
        const alvo = busca.toLowerCase();
        const dig = soDigitos(busca);
        linhas = linhas.filter((r) =>
          String(r.nome || "").toLowerCase().includes(alvo) ||
          String(r.cpf || "").toLowerCase().includes(alvo) ||
          (dig.length >= 3 && soDigitos(r.cpf).includes(dig)));
      }
      return json(res, 200, linhas);
    }
    if (req.method === "GET" && id) {
      const row = await Q.get(`SELECT * FROM ${tabela} WHERE id=?`, id);
      if (!row) return json(res, 404, { error: "Registro não encontrado." });
      if (donoCol && String(row[donoCol]) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." });
      return json(res, 200, row);
    }
    if (req.method === "POST" && !id) {
      const b = await readBody(req);
      /* FREQUÊNCIA: pode haver mais de uma folha da mesma turma no mesmo mês
         (decisão do cliente — o par único saiu na migration 010). Só o básico
         é conferido: sem turma ou mês a folha não se acha na lista. */
      if (tabela === "frequencias") {
        b.turma = String(b.turma || "").trim();
        b.mes = String(b.mes || "").trim();
        if (!b.turma) return json(res, 400, { error: "Escolha a turma." });
        if (!/^\d{4}-\d{2}$/.test(b.mes)) return json(res, 400, { error: "Escolha o mês." });
      }
      if (tabela === "prontuario") {
        b.usuario_id = s.userId;                                            // quem digitou
        /* Quem RESPONDE pelo registro. O profissional só lança para si — a
           tela nem oferece outro nome, mas quem garante é isto aqui: sem esta
           linha, um POST montado à mão gravaria o prontuário no nome de outro
           e sumiria da lista de quem o criou. */
        if (s.perfil === "profissional") {
          b.profissional_id = s.profissionalId;
          /* O nome também: a tela esconde esse campo do profissional (ele só
             lança para si), e sem preenchê-lo aqui a coluna "Profissional" da
             lista sairia em branco justamente nos registros dele. */
          const pf = await Q.get("SELECT nome FROM profissionais WHERE id=?", s.profissionalId);
          if (pf) b.profissional = pf.nome;
        } else {
          b.profissional_id = await idDoProfissional(b.profissional);
        }
        /* UMA pasta por pessoa + serviço. O índice único no banco é quem
           garante de verdade; esta checagem existe para o recado ser útil —
           sem ela a equipe veria "erro ao salvar" e abriria um chamado. */
        if (!b.paciente_id) return json(res, 400, { error: "Selecione o usuário deste prontuário." });
        if (!b.especialidade) return json(res, 400, { error: "Selecione o serviço deste prontuário." });
        const ja = await pastaDoPar(b.paciente_id, b.especialidade);
        if (ja) return json(res, 409, {
          error: `Este usuário já tem prontuário de ${b.especialidade} (nº ${ja.numero || "—"}). Abra o existente — cada serviço tem um prontuário só.`,
          id: ja.id });
        if (!b.aberto_em) b.aberto_em = new Date().toISOString().slice(0, 10);
        b.status = "Ativo";
      }
      if (tabela === "prontuario_registros") {
        if (!b.prontuario_id) return json(res, 400, { error: "Lançamento sem prontuário." });
        if (!TIPOS_REGISTRO.includes(b.tipo)) return json(res, 400, { error: "Tipo de lançamento inválido." });
        if (!String(b.texto || "").trim()) return json(res, 400, { error: "Escreva o conteúdo do lançamento." });
        if (!b.data) b.data = new Date().toISOString().slice(0, 10);
        /* A pasta manda: quem não pode abrir a pasta não escreve dentro dela.
           Sem esta guarda o recorte por dono teria uma porta lateral — bastaria
           lançar direto no id da pasta do colega. */
        const pasta = await Q.get("SELECT * FROM prontuario WHERE id=?", b.prontuario_id);
        if (!pasta) return json(res, 404, { error: "Prontuário não encontrado." });
        const recusaReg = recusaPorDono(s, pasta);
        if (recusaReg) return json(res, 403, { error: recusaReg });
        if (pasta.status === "Alta") return json(res, 400, {
          error: "Este prontuário está com alta. Reabra antes de lançar." });
        b.usuario_id = s.userId;
        if (!b.profissional) b.profissional = pasta.profissional || s.nome;
      }
      if (tabela === "atendimentos" && s.perfil === "profissional") b.profissional_id = s.profissionalId; // marca na própria agenda
      // senha do portal: guarda só o HASH (scrypt); o texto puro é devolvido
      // UMA vez para a secretaria repassar, e nunca mais fica recuperável.
      let senhaGerada = null;
      if (tabela === "associados") { senhaGerada = String(crypto.randomInt(10000000, 100000000)); b.senha_externo = hashSenha(senhaGerada); }
      if (tabela === "atendimentos") { const e = await validarAgenda(b.profissional_id, b.data, b.hora, null); if (e) return json(res, 400, { error: e }); }
      if (tabela === "projetos") { b.slug = slugify(b.slug || b.title); if (b.slug && await Q.get("SELECT id FROM projetos WHERE slug=?", b.slug)) b.slug = `${b.slug}-${Date.now().toString(36)}`; }
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      const temCriado = COLS[tabela].has("criado");
      /* Cópia em texto claro ANTES de cifrar — é o que a auditoria registra.
         Depois de proteger(), `b` carrega texto cifrado, e a trilha guardaria
         um monte de "enc:1:..." em vez do que foi cadastrado. */
      const comoVeio = {}; for (const c of use) comoVeio[c] = b[c];
      limparHtmlDoRegistro(tabela, b);     // HTML do prontuário sai higienizado
      proteger(tabela, b);     // cifra os campos sensíveis antes de gravar
      /* Trata os campos em branco pelo que a COLUNA aceita (ver prepararCampos). */
      const pronto = prepararCampos(tabela, use, b);
      if (pronto.faltando.length)
        return json(res, 400, { error: `Preencha antes de salvar: ${pronto.faltando.join(", ")}.` });
      const campos = temCriado ? pronto.usar.concat("criado") : pronto.usar;
      const valores = temCriado ? pronto.valores.concat(agora()) : pronto.valores;
      /* Q.inserir e não Q.run: o id novo é preciso na resposta (a tela usa para
         abrir o registro recém-criado). No SQLite ele vinha de lastInsertRowid;
         no PostgreSQL só existe com RETURNING, que o Q.inserir acrescenta. */
      const novoId = await Q.inserir(`INSERT INTO ${tabela}(${campos.join(",")}) VALUES(${campos.map(() => "?").join(",")})`, ...valores);
      auditar({ req, sessao: s, acao: "criar", modulo: tabela, entidadeId: novoId,
        resumo: `Cadastrou em ${rotuloModulo(tabela)}: ${rotuloRegistro(tabela, comoVeio)}`,
        detalhe: { campos: comoVeio } });

      /* A pasta nasce numerada e recolhe os agendamentos daquele par que já
         existiam soltos — normalmente o primeiro, marcado antes de a pasta
         existir. */
      if (tabela === "prontuario") {
        const numero = await emitirNumeroProntuario(novoId);
        const recolhidos = await recolherAtendimentosSoltos(novoId, comoVeio.paciente_id, comoVeio.especialidade);
        await anotar("prontuario", novoId, "Prontuário aberto", `${numero} · ${comoVeio.especialidade}`, s);
        await anotar("paciente", comoVeio.paciente_id, "Prontuário aberto", `${numero} · ${comoVeio.especialidade}`, s);
        return json(res, 200, { ok: true, id: novoId, numero, recolhidos });
      }
      if (tabela === "prontuario_registros") {
        const pr = await Q.get("SELECT paciente_id,numero FROM prontuario WHERE id=?", comoVeio.prontuario_id) || {};
        await anotar("prontuario", comoVeio.prontuario_id, "Lançamento: " + rotuloTipo(comoVeio.tipo),
          semMarcacao(comoVeio.texto).slice(0, 160), s);
        if (pr.paciente_id) await anotar("paciente", pr.paciente_id,
          "Lançamento no prontuário " + (pr.numero || ""), rotuloTipo(comoVeio.tipo), s);
      }
      /* O agendamento se pendura sozinho na pasta do serviço, quando não há
         dúvida de qual é (ver ligarAtendimentoNaPasta). */
      if (tabela === "atendimentos") {
        const pasta = await ligarAtendimentoNaPasta(novoId);
        return json(res, 200, { ok: true, id: novoId, prontuario: pasta || null });
      }
      return json(res, 200, { ok: true, id: novoId, senha: senhaGerada || undefined });
    }
    if (req.method === "PUT" && id) {
      if (donoCol) { const dono = await Q.get(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`, id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      const b = await readBody(req);
      delete b.usuario_id; delete b.senha_externo;    // não se troca dono nem senha por aqui
      if (donoCol === "profissional_id") delete b.profissional_id;   // o profissional não reatribui o que é dele
      /* O admin PODE trocar o profissional responsável — e quando troca, o dono
         tem de ir junto. Se só o nome mudasse, o prontuário continuaria
         aparecendo para o profissional anterior e sumido para o novo. */
      if (tabela === "prontuario" && donoCol === null && b.profissional !== undefined) {
        b.profissional_id = await idDoProfissional(b.profissional);
      }
      if (tabela === "atendimentos") {
        const at = await Q.get("SELECT profissional_id,data,hora FROM atendimentos WHERE id=?", id) || {};
        const e = await validarAgenda(b.profissional_id ?? at.profissional_id, b.data ?? at.data, b.hora ?? at.hora, id);
        if (e) return json(res, 400, { error: e });
      }
      if (tabela === "projetos" && (b.slug !== undefined || b.title !== undefined)) {
        b.slug = slugify(b.slug || b.title);
        const clash = b.slug && await Q.get("SELECT id FROM projetos WHERE slug=?", b.slug);
        if (clash && String(clash.id) !== String(id)) b.slug = `${b.slug}-${Date.now().toString(36)}`;
      }
      const use = cols.filter((c) => c in b && COLS[tabela].has(c));
      /* Estado ANTES da edição, já decifrado (o Q devolve em claro). É a metade
         de trás do que a auditoria mostra no modal: de X para Y. */
      const antesTudo = await Q.get(`SELECT * FROM ${tabela} WHERE id=?`, id) || {};
      const comoVeio = {}; for (const c of use) comoVeio[c] = b[c];
      limparHtmlDoRegistro(tabela, b);     // HTML do prontuário sai higienizado
      proteger(tabela, b);     // mesma cifragem do INSERT
      /* Mesmo tratamento do cadastro: em branco vira NULL, ou sai da instrução
         quando a coluna tem padrão (aí o valor atual fica como está). */
      const pronto = prepararCampos(tabela, use, b);
      if (pronto.faltando.length)
        return json(res, 400, { error: `Preencha antes de salvar: ${pronto.faltando.join(", ")}.` });
      if (pronto.usar.length)
        await Q.run(`UPDATE ${tabela} SET ${pronto.usar.map((c) => c + "=?").join(",")} WHERE id=?`,
          ...pronto.valores, id);
      /* Lançamento editado guarda QUANDO foi editado e o que mudou entra na
         linha do tempo: num registro de acompanhamento, "alguém mexeu nisto
         depois" é informação, não detalhe. */
      if (tabela === "prontuario_registros" && use.length) {
        await Q.run("UPDATE prontuario_registros SET atualizado=? WHERE id=?", agora(), id);
        if (comoVeio.texto !== undefined && comoVeio.texto !== antesTudo.texto)
          await anotar("prontuario", antesTudo.prontuario_id,
            "Lançamento editado: " + rotuloTipo(antesTudo.tipo), semMarcacao(comoVeio.texto).slice(0, 160), s);
      }
      const mudou = diferencas(antesTudo, comoVeio, tabela);
      const nomes = Object.keys(mudou);
      /* Salvar sem mexer em nada não vira linha — senão a trilha encheria toda
         vez que alguém abrisse e fechasse uma ficha. */
      if (nomes.length) {
        auditar({ req, sessao: s, acao: "editar", modulo: tabela, entidadeId: Number(id),
          resumo: `Alterou em ${rotuloModulo(tabela)}: ${rotuloRegistro(tabela, antesTudo)} — ${nomes.length} campo(s): ${nomes.slice(0, 4).join(", ")}${nomes.length > 4 ? "…" : ""}`,
          detalhe: { alteracoes: mudou } });
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && id) {
      if (donoCol) { const dono = await Q.get(`SELECT ${donoCol} d FROM ${tabela} WHERE id=?`, id); if (dono && String(dono.d) !== String(donoVal)) return json(res, 403, { error: "Registro de outro profissional." }); }
      /* ====================================================================
         PASTA COM LANÇAMENTO NÃO SE APAGA

         Excluir a pasta apagaria o acompanhamento inteiro que está dentro
         dela — e o banco não tem cascata, então os lançamentos ficariam
         órfãos: invisíveis na tela, presentes em todo backup, sem pasta a que
         pertencer. Quem encerra um acompanhamento dá ALTA; quem errou um
         lançamento ARQUIVA.

         Uma pasta recém-aberta e ainda vazia continua podendo ser excluída —
         é o caso de quem escolheu o serviço errado e quer recomeçar.

         O agendamento NÃO entra nesta conta de propósito: ele não é conteúdo
         da pasta, está apenas arquivado nela, e continua existindo sozinho se
         ela sair. Apagar a pasta vazia solta os agendamentos e permite
         recomeçar; se contassem, um vínculo feito por engano prenderia a pasta
         para sempre. */
      /* Mesma regra, um nível acima: apagar a PESSOA levaria junto o prontuário
         dela — e como o banco não tem cascata, as pastas e os lançamentos
         ficariam órfãos, invisíveis na tela e presentes em todo backup. Quem
         sai do acompanhamento é INATIVADO; a ficha continua inteira. */
      if (tabela === "pacientes") {
        const nPastas = (await Q.get("SELECT COUNT(*) c FROM prontuario WHERE paciente_id=?", id)).c;
        const nAtend = (await Q.get("SELECT COUNT(*) c FROM atendimentos WHERE paciente_id=?", id)).c;
        if (nPastas || nAtend) return json(res, 400, {
          error: `Este usuário tem ${nPastas} prontuário(s) e ${nAtend} agendamento(s) e não pode ser excluído. Para tirá-lo do acompanhamento, use "Inativar usuário" — a ficha e o histórico continuam guardados.` });
      }
      if (tabela === "prontuario") {
        const n = (await Q.get("SELECT COUNT(*) c FROM prontuario_registros WHERE prontuario_id=?", id)).c;
        if (n) return json(res, 400, {
          error: `Este prontuário tem ${n} lançamento(s) e não pode ser excluído. Para encerrar o acompanhamento, use "Dar alta".` });
        await Q.run("UPDATE atendimentos SET prontuario_id=NULL WHERE prontuario_id=?", id);
        await Q.run("DELETE FROM historico WHERE entidade='prontuario' AND entidade_id=?", id);
      }
      /* Lê o registro INTEIRO antes de apagar: numa exclusão, a auditoria é a
         única coisa que sobra. Sem isso não há como responder depois "o que foi
         apagado?". */
      const apagado = await Q.get(`SELECT * FROM ${tabela} WHERE id=?`, id) || {};
      await Q.run(`DELETE FROM ${tabela} WHERE id=?`, id);
      auditar({ req, sessao: s, acao: "excluir", modulo: tabela, entidadeId: Number(id),
        resumo: `Excluiu de ${rotuloModulo(tabela)}: ${rotuloRegistro(tabela, apagado)}`,
        detalhe: { registro_excluido: apagado } });
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "Rota não encontrada" });
}

/* ==========================================================================
   Portal do associado — /externo
   O associado entra com CPF + a senha de 8 dígitos gerada no cadastro e vê a
   PRÓPRIA ficha, situação e novidades. Usa o MESMO banco (gestao.db); só uma
   sessão à parte (cookie "eid"). Somente leitura da própria ficha.
   ========================================================================== */
const sessoesExt = new Map();   // eid -> { associadoId, nome, ts }
const SESSAO_EXT_HORAS = 6;
function sessaoExt(req) {
  const m = /(?:^|;\s*)eid=([a-f0-9]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const s = sessoesExt.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.ts > SESSAO_EXT_HORAS * 3600_000) { sessoesExt.delete(m[1]); return null; }
  s.ts = Date.now();
  return { eid: m[1], ...s };
}
setInterval(() => { const lim = Date.now() - SESSAO_EXT_HORAS * 3600_000; for (const [k, v] of sessoesExt) if (v.ts < lim) sessoesExt.delete(k); }, 30 * 60_000).unref();

/* A foto do associado, servida só para ele mesmo. Fica fora do handleExterno
   porque precisa consultar o banco (assíncrono) e o handler tem de continuar
   síncrono — ver o comentário logo abaixo. */
async function fotoDoAssociado(req, res) {
  try {
    const s = sessaoExt(req);
    const a = s && await Q.get("SELECT foto FROM associados WHERE id=?", s.associadoId);
    const arq = a && a.foto ? path.join(UPLOAD_DIR, path.basename(a.foto)) : null;
    if (!arq || !arq.startsWith(UPLOAD_DIR) || !fs.existsSync(arq)) { res.writeHead(404); res.end("404"); return; }
    const ext = path.extname(arq).toLowerCase();
    res.writeHead(200, {
      "Content-Type": { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[ext] || "application/octet-stream",
      "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex",
    });
    fs.createReadStream(arq).pipe(res);
  } catch (e) {
    console.error("  ✖ /externo/foto:", e.message);
    if (!res.headersSent) { res.writeHead(500); res.end("500"); }
  }
}

/* ==========================================================================
   handleExterno CONTINUA SÍNCRONO — de propósito.

   O server.js decide o roteamento com `if (handleExterno(req,res,p)) return;`.
   Se esta função fosse assíncrona, ela devolveria uma Promise — que é SEMPRE
   verdadeira. O `if` passaria para TODAS as requisições, e o site inteiro
   pararia de responder porque o servidor acharia que o portal já tratou tudo.

   O único trecho que precisa do banco (a foto do associado) foi isolado numa
   função assíncrona própria, disparada como o `rotaExt` logo acima já era.
   ========================================================================== */
function handleExterno(req, res, pathname) {
  if (pathname !== "/externo" && !pathname.startsWith("/externo/")) return false;
  if (pathname === "/externo") { res.writeHead(302, { Location: "/externo/" }); res.end(); return true; }
  const rota = pathname.slice("/externo".length) || "/";

  if (rota.startsWith("/api/")) { rotaExt(req, res, rota.slice(5)).catch((e) => {
    console.error("  ✖ /externo/api:", e.message); json(res, 500, { error: "Erro interno" });
  }); return true; }

  // foto da ficha, servida só para o próprio associado logado
  if (rota === "/foto") { fotoDoAssociado(req, res); return true; }

  if (rota === "/" || rota === "/index.html") {
    const html = fs.readFileSync(path.join(APP_DIR, "externo.html"), "utf8").replace(/\{\{VERSAO\}\}/g, SISTEMA_VERSION);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": CSP_GESTAO });
    res.end(html); return true;
  }
  res.writeHead(404, { "Content-Type": "text/plain" }); res.end("404"); return true;
}

async function rotaExt(req, res, p) {
  const ip = clientIp(req);
  if (p === "login" && req.method === "POST") {
    const { cpf, senha } = await readBody(req);
    const dig = String(cpf || "").replace(/\D/g, "");
    /* A "conta" é o CPF digitado — é o identificador que o atacante escolhe,
       e portanto o que precisa ser contado. */
    const v = limite.verificar("externo", ip, dig || "sem-cpf");
    if (!v.ok) { res.setHeader("Retry-After", String(v.esperar)); return json(res, 429, { error: v.mensagem }); }
    // acha o associado pelo CPF e confere o HASH da senha (nunca comparamos texto puro)
    const cand = dig ? await Q.all("SELECT id,nome,cpf,senha_externo FROM associados WHERE senha_externo IS NOT NULL AND senha_externo<>''") : [];
    const a = cand.find((x) => String(x.cpf || "").replace(/\D/g, "") === dig && confereSenha(String(senha || "").trim(), x.senha_externo));
    if (!a) { limite.errou("externo", ip, dig || "sem-cpf"); return json(res, 401, { error: "CPF ou senha incorretos." }); }
    limite.acertou("externo", ip, dig || "sem-cpf");
    const eid = crypto.randomBytes(24).toString("hex");
    sessoesExt.set(eid, { associadoId: a.id, nome: a.nome, ts: Date.now() });
    res.setHeader("Set-Cookie", `eid=${eid}; HttpOnly; SameSite=Lax; Path=/externo; Max-Age=${SESSAO_EXT_HORAS * 3600}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
    return json(res, 200, { ok: true, nome: a.nome });
  }
  const s = sessaoExt(req);
  if (!s) return json(res, 401, { error: "Não autenticado" });
  if (p === "logout" && req.method === "POST") { sessoesExt.delete(s.eid); res.setHeader("Set-Cookie", "eid=; HttpOnly; Path=/externo; Max-Age=0"); return json(res, 200, { ok: true }); }
  if (p === "ficha") {
    const a = await Q.get("SELECT nome,cpf,contato,endereco,vinculo,adesao,mensalidade,status,foto FROM associados WHERE id=?", s.associadoId) || {};
    const eventos = await Q.all("SELECT tipo,titulo,tema,local,data FROM eventos WHERE data<>'' ORDER BY data DESC LIMIT 8");
    return json(res, 200, { ficha: a, temFoto: !!a.foto, novidades: eventos });
  }
  return json(res, 404, { error: "Rota não encontrada" });
}

/* ------- Ponte com o site: o painel (/admin) só LÊ os projetos daqui ------
   Estas quatro funções são chamadas pelo server.js na hora de publicar o site.
   Todas viraram ASSÍNCRONAS na passagem para o PostgreSQL — quem as chama
   precisa aguardar. */
const listarProjetos = () => Q.all("SELECT * FROM projetos ORDER BY sort, id");
const contarProjetos = async () => Number((await Q.get("SELECT COUNT(*) c FROM projetos")).c);
// Semeia os projetos que já existiam no site.db na primeira vez (migração única).
async function importarProjetos(rows) {
  let n = 0;
  for (const p of rows || []) {
    await Q.run("INSERT INTO projetos(title,slug,sigla,status,resumo,publico,content,sort,criado) VALUES(?,?,?,?,?,?,?,?,?)",
      p.title, p.slug || slugify(p.title), p.sigla || "", p.status || "", p.resumo || "", p.publico || "", p.content || "", p.sort || 0, agora());
    n++;
  }
  return n;
}

const listarServicos = () => Q.all("SELECT * FROM servicos ORDER BY sort, id");
const contarServicos = async () => Number((await Q.get("SELECT COUNT(*) c FROM servicos")).c);
async function importarServicos(rows) {
  let n = 0;
  for (const s of rows || []) {
    await Q.run("INSERT INTO servicos(title,categoria,sort,criado) VALUES(?,?,?,?)",
      s.title, s.categoria || "", s.sort || 0, agora());
    n++;
  }
  return n;
}

module.exports = { handleRestrito, handleExterno, iniciarRestrito, sessao, SISTEMA_VERSION, CAMPOS_PROTEGIDOS,
  registrarEncerrarPainel, auditar, aoMudarEquipe,
  listarProjetos, contarProjetos, importarProjetos, listarServicos, contarServicos, importarServicos };
