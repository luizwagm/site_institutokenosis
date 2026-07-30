/* Prova do limitador, com relógio controlado.

   Roda com:  node testar-limitador.js

   Relógio de mentira de propósito: um teste que dependesse do tempo real ou
   dormiria 15 minutos, ou mediria o relógio em vez da regra. Aqui o tempo
   anda quando eu mando, e cada bloqueio é verificado no instante exato em que
   deve cair e no instante em que deve soltar. */
const fs = require("node:fs");
const path = require("node:path");
const { criarLimitador } = require("./limitador");

const TMP = path.join(process.env.TEMP || "/tmp", "zz-limitador-teste.json");
try { fs.unlinkSync(TMP); } catch {}

let ok = 0; const falhas = [];
const eq = (nome, achado, esperado) => {
  if (JSON.stringify(achado) === JSON.stringify(esperado)) { ok++; console.log(`  ok   ${nome}`); }
  else { falhas.push(nome); console.log(`  FALHA ${nome}\n         esperado: ${JSON.stringify(esperado)}\n         achado:   ${JSON.stringify(achado)}`); }
};
const certo = (nome, cond, det = "") => eq(nome + (det && !cond ? ` — ${det}` : ""), !!cond, true);

let T = 1_700_000_000_000;
const relogio = () => T;
const avancarS = (s) => { T += s * 1000; };
const avancarMin = (m) => { T += m * 60_000; };
const novo = (arquivo) => criarLimitador({ arquivo, agora: relogio });

console.log("\n=== Limitador — ataque de senha ===\n");

/* ------------------------------------------------------------------ */
console.log("-- Uso normal (não pode atrapalhar quem é de casa) --");
{
  const L = novo(null);
  eq("primeira tentativa passa", L.verificar("painel", "1.1.1.1", "admin").ok, true);
  L.errou("painel", "1.1.1.1", "admin");
  eq("errou uma vez: pode tentar de novo NA HORA", L.verificar("painel", "1.1.1.1", "admin").ok, true);
  L.acertou("painel", "1.1.1.1", "admin");
  eq("depois de acertar, segue liberado", L.verificar("painel", "1.1.1.1", "admin").ok, true);
}

/* ------------------------------------------------------------------ */
console.log("\n-- Espera progressiva entre tentativas --");
{
  const L = novo(null);
  const IP = "2.2.2.2";
  L.errou("painel", IP, "admin");                       // 1º erro
  L.errou("painel", IP, "admin");                       // 2º erro
  const v2 = L.verificar("painel", IP, "admin");
  eq("no 2º erro passa a exigir espera", v2.ok, false);
  eq("espera de 1s", v2.esperar, 1);
  avancarS(1);
  eq("passada a espera, pode tentar", L.verificar("painel", IP, "admin").ok, true);

  L.errou("painel", IP, "admin");                       // 3º erro
  eq("3º erro: espera dobra para 2s", L.verificar("painel", IP, "admin").esperar, 2);
  avancarS(2);
  L.errou("painel", IP, "admin");                       // 4º erro
  eq("4º erro: espera 4s", L.verificar("painel", IP, "admin").esperar, 4);
  avancarS(4);
  eq("ainda não está bloqueado de vez", L.verificar("painel", IP, "admin").ok, true);
}

/* ------------------------------------------------------------------ */
console.log("\n-- Bloqueio do IP no 5º erro --");
{
  const L = novo(null);
  const IP = "3.3.3.3";
  for (let i = 0; i < 5; i++) { L.errou("painel", IP, "admin"); avancarS(60); }
  const v = L.verificar("painel", IP, "admin");
  eq("5 erros → bloqueado", v.ok, false);
  eq("motivo é o IP", v.motivo, "ip");
  certo("a mensagem diz quanto falta", /\d+ min/.test(v.mensagem), v.mensagem);
  certo("a mensagem não entrega se a conta existe", !/senha correta|usuário existe/i.test(v.mensagem));

  avancarMin(10);
  eq("10 min depois ainda bloqueado", L.verificar("painel", IP, "admin").ok, false);
  avancarMin(6);
  eq("passados os 15 min, solta sozinho", L.verificar("painel", IP, "admin").ok, true);
}

/* ------------------------------------------------------------------ */
console.log("\n-- A BRECHA PRINCIPAL: ataque distribuído --");
{
  /* Antes: cada IP tinha o seu orçamento de 5 e a conta nunca era contada.
     Trinta máquinas davam 150 tentativas sem disparar nada. */
  const L = novo(null);
  let aceitas = 0, i = 0;
  for (let maquina = 0; maquina < 30; maquina++) {
    const ip = `10.0.3.${maquina}`;
    for (let k = 0; k < 5; k++) {
      if (L.verificar("painel", ip, "admin").ok) { aceitas++; L.errou("painel", ip, "admin"); }
      i++;
    }
  }
  console.log(`     de 150 tentativas em rajada, passaram: ${aceitas}`);
  certo("a rajada distribuída é cortada logo", aceitas <= 12, `passaram ${aceitas}`);
  eq("e quem segura é o balde da CONTA", L.verificar("painel", "10.0.3.99", "admin").motivo, "conta");
}

console.log("\n-- O que interessa num rate limit: a TAXA no longo prazo --");
{
  /* O balde é uma JANELA, não banimento: o ataque é bloqueado, espera a
     janela vencer e volta. Então a pergunta certa não é "quantas no total",
     e sim QUANTAS POR HORA ele consegue sustentar — é isso que decide se uma
     senha cai em dias ou em séculos. Simula 24 horas de ataque teimoso vindo
     de 200 máquinas, uma tentativa por minuto. */
  const L = novo(null);
  let aceitas = 0;
  const HORAS = 24;
  for (let minuto = 0; minuto < HORAS * 60; minuto++) {
    const ip = `172.16.${Math.floor(minuto / 256) % 256}.${minuto % 256}`;   // IP novo toda vez
    if (L.verificar("painel", ip, "admin").ok) { aceitas++; L.errou("painel", ip, "admin"); }
    avancarMin(1);
  }
  const porHora = aceitas / HORAS;
  const semLimite = 60;                                  // 1 por minuto era o que ele tentava
  console.log(`     ataque de ${HORAS}h, IP diferente a cada tentativa:`);
  console.log(`     passaram ${aceitas} de ${HORAS * 60}  ·  ${porHora.toFixed(1)}/hora (tentava ${semLimite}/hora)`);
  certo("a taxa cai para menos de 25 por hora", porHora < 25, `${porHora.toFixed(1)}/h`);
  certo("é ao menos 3x menos que sem limite", porHora < semLimite / 3, `${porHora.toFixed(1)}/h`);

  /* Tradução para o mundo real: com essa taxa, quanto tempo para varrer uma
     senha fraca de 8 letras minúsculas? Só para deixar o número no relatório. */
  const anos = 26 ** 8 / (porHora * 24 * 365);
  console.log(`     uma senha de 8 letras minúsculas levaria ~${Math.round(anos).toLocaleString("pt-BR")} anos`);
}

/* ------------------------------------------------------------------ */
console.log("\n-- O dono não pode ser trancado do lado de fora --");
{
  const L = novo(null);
  const DONO = "200.1.1.1";
  L.acertou("painel", DONO, "admin");                   // entrou hoje de manhã
  // à tarde, um ataque distribuído enche o balde da conta
  for (let m = 0; m < 30; m++) {
    const ip = `10.0.1.${m}`;
    for (let i = 0; i < 5; i++) { L.errou("painel", ip, "admin"); avancarS(30); }
  }
  eq("a conta está bloqueada para quem é de fora", L.verificar("painel", "9.9.9.9", "admin").motivo, "conta");
  eq("mas o dono, do IP de sempre, entra", L.verificar("painel", DONO, "admin").ok, true);

  /* E o IP conhecido não vira passe livre: se ELE for o comprometido, o balde
     do próprio IP continua valendo. */
  for (let i = 0; i < 5; i++) { L.errou("painel", DONO, "admin"); avancarS(60); }
  eq("IP conhecido também é barrado se começar a errar", L.verificar("painel", DONO, "admin").motivo, "ip");
}

/* ------------------------------------------------------------------ */
console.log("\n-- Escopos não se misturam --");
{
  const L = novo(null);
  const IP = "4.4.4.4";
  for (let i = 0; i < 5; i++) { L.errou("painel", IP, "admin"); avancarS(60); }
  eq("bloqueado no painel", L.verificar("painel", IP, "admin").ok, false);
  eq("mas o /restrito continua livre", L.verificar("restrito", IP, "maria@x.org").ok, true);
}

console.log("\n-- Contas diferentes não se contaminam --");
{
  const L = novo(null);
  for (let m = 0; m < 30; m++) {
    const ip = `10.0.2.${m}`;
    for (let i = 0; i < 5; i++) { L.errou("restrito", ip, "maria@x.org"); avancarS(30); }
  }
  eq("a conta atacada está bloqueada", L.verificar("restrito", "8.8.8.8", "maria@x.org").motivo, "conta");
  eq("outra pessoa entra normalmente", L.verificar("restrito", "8.8.8.9", "joao@x.org").ok, true);
}

/* ------------------------------------------------------------------ */
console.log("\n-- Sobrevive ao reinício do servidor --");
{
  const L1 = novo(TMP);
  const IP = "5.5.5.5";
  for (let i = 0; i < 5; i++) { L1.errou("painel", IP, "admin"); avancarS(60); }
  eq("bloqueado antes de reiniciar", L1.verificar("painel", IP, "admin").ok, false);
  L1.gravar();                                          // o que o processo faria ao sair

  const L2 = novo(TMP);                                 // "reiniciou"
  L2.carregar();
  eq("continua bloqueado depois do reinício", L2.verificar("painel", IP, "admin").ok, false);
  certo("o arquivo existe em disco", fs.existsSync(TMP));

  avancarMin(16);
  eq("e ainda solta sozinho na hora certa", L2.verificar("painel", IP, "admin").ok, true);
}

console.log("\n-- Arquivo corrompido não derruba o login --");
{
  fs.writeFileSync(TMP, "{ isto não é json");
  const L = novo(TMP);
  L.carregar();
  eq("com o arquivo quebrado, o login continua funcionando", L.verificar("painel", "6.6.6.6", "admin").ok, true);
}

try { fs.unlinkSync(TMP); } catch {}
console.log(`\n=== ${ok}/${ok + falhas.length} ===`);
if (falhas.length) { console.log("\nFalhou:\n" + falhas.map((f) => "  · " + f).join("\n")); process.exit(1); }
console.log("Tudo certo.\n");
