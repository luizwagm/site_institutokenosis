/* ==========================================================================
   main.js — Instituto Kenósis
   Cabeçalho no scroll · menu mobile · busca · revelação · formulário → WhatsApp
   · botão flutuante · consentimento de cookies (LGPD)

   ATENÇÃO: os nomes de classe aqui seguem o CSS deste projeto (em português):
   .cabecalho/.rolou, .nav/.aberta, [data-revela]/.visivel, .zap-flutua.
   ========================================================================== */
import { WHATSAPP_NUMBER, GA4_ID, GTM_ID, META_PIXEL_ID, CLARITY_ID, HOTJAR_ID } from "./config.js";

const $ = (s, c = document) => c.querySelector(s);
const $$ = (s, c = document) => [...c.querySelectorAll(s)];

/* ------------------------------ Cabeçalho -------------------------------- */
function iniCabecalho() {
  const h = $(".cabecalho");
  if (!h) return;
  const aplicar = () => h.classList.toggle("rolou", window.scrollY > 8);
  aplicar();
  window.addEventListener("scroll", aplicar, { passive: true });
}

function iniMenu() {
  const botao = $(".nav-botao"), nav = $("#nav-principal");
  if (!botao || !nav) return;
  const abrir = (v) => { nav.classList.toggle("aberta", v); botao.setAttribute("aria-expanded", String(v)); };
  botao.addEventListener("click", () => abrir(botao.getAttribute("aria-expanded") !== "true"));
  $$("a", nav).forEach((a) => a.addEventListener("click", () => abrir(false)));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") abrir(false); });
}

/* ------------------------------ Revelação -------------------------------- */
function iniRevelacao() {
  const els = $$("[data-revela]");
  if (!els.length) return;

  const semAnimacao = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (semAnimacao || !("IntersectionObserver" in window)) return;   // fica tudo visível

  // só a partir daqui o CSS esconde para animar — se o script parasse antes,
  // a página continuaria legível
  document.documentElement.classList.add("js-anima");

  const io = new IntersectionObserver((entradas) => entradas.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("visivel"); io.unobserve(e.target); }
  }), { threshold: .1, rootMargin: "0px 0px -6% 0px" });
  els.forEach((e) => io.observe(e));

  // rede de segurança: se em 2,5s algo continuar escondido (observador que não
  // disparou, aba em segundo plano, bloqueador), revela assim mesmo
  setTimeout(() => {
    els.forEach((e) => { if (!e.classList.contains("visivel")) e.classList.add("visivel"); });
  }, 2500);
}

/* -------------------------------- Aviso ---------------------------------- */
let avisoT;
function aviso(msg) {
  let el = $(".aviso");
  if (!el) { el = document.createElement("div"); el.className = "aviso"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add("visivel"));
  clearTimeout(avisoT);
  avisoT = setTimeout(() => el.classList.remove("visivel"), 3200);
}

/* --------------------------- Formulário → WhatsApp ------------------------ */
function iniFormulario() {
  const form = $("#form-contato");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const d = Object.fromEntries(new FormData(form).entries());
    const msg = encodeURIComponent(
      `*Contato pelo site — Instituto Kenósis*\n\n` +
      `Nome: ${d.nome}\nAssunto: ${d.assunto}\nWhatsApp: ${d.whatsapp}\n\n` +
      `Mensagem:\n${d.mensagem || "-"}`
    );
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`, "_blank", "noopener");
    aviso("Abrindo o WhatsApp com a sua mensagem…");
    form.reset();
  });
}

/* --------------------------- Botão flutuante ----------------------------- */
function iniBotaoZap() {
  if ($(".zap-flutua")) return;
  const msg = encodeURIComponent("Olá! Vim pelo site do Instituto Kenósis e gostaria de mais informações.");
  const a = document.createElement("a");
  a.className = "zap-flutua";
  a.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${msg}`;
  a.target = "_blank"; a.rel = "noopener";
  a.setAttribute("aria-label", "Falar no WhatsApp");
  a.innerHTML = `<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M16 3C9 3 3.5 8.5 3.5 15.5c0 2.4.7 4.7 1.9 6.7L4 29l7-1.8c1.9 1 4 1.6 6 1.6 7 0 12.5-5.5 12.5-12.5S23 3 16 3Zm0 22.7c-1.8 0-3.6-.5-5.2-1.4l-.4-.2-4.1 1.1 1.1-4-.2-.4a10 10 0 0 1-1.6-5.4C5.6 9.7 10.3 5 16 5s10.4 4.7 10.4 10.5S21.7 25.7 16 25.7Zm5.7-7.8c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.2-.7.1a8.2 8.2 0 0 1-2.4-1.5 9 9 0 0 1-1.7-2.1c-.2-.3 0-.5.1-.7l.5-.6.3-.5c.1-.2 0-.4 0-.6l-1-2.3c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.4-1.2 1.2-1.2 2.9s1.2 3.4 1.4 3.6c.2.2 2.4 3.7 5.8 5.1.8.4 1.5.6 2 .7.8.3 1.6.2 2.2.1.7-.1 2-.8 2.2-1.6.3-.8.3-1.4.2-1.6l-.6-.3Z"/></svg>`;
  document.body.appendChild(a);
}

/* Cards de serviço: mostra 5 itens e revela o resto ao clicar. As categorias
   têm 14 e 16 itens — sem isso o card fica altíssimo e desalinha a linha. */
function iniServicos() {
  $$(".serv-cartao__botao").forEach((b) => {
    const card = b.closest(".serv-cartao");
    const n = b.dataset.mais;
    b.addEventListener("click", () => {
      const abrindo = !card.classList.contains("aberto");
      card.classList.toggle("aberto", abrindo);
      b.setAttribute("aria-expanded", String(abrindo));
      b.textContent = abrindo ? "− ver menos" : `+${n} itens`;
    });
  });
}

function iniAno() { const y = $("#ano"); if (y) y.textContent = new Date().getFullYear(); }

/* --------------------------------- Busca --------------------------------- */
function iniLupa() {
  const nav = $("#nav-principal");
  if (!nav || $(".busca-lupa")) return;
  const a = document.createElement("a");
  a.className = "busca-lupa";
  a.href = "/busca/";
  a.setAttribute("aria-label", "Buscar no site");
  a.innerHTML = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;
  nav.insertBefore(a, nav.querySelector(".btn"));
}

async function iniResultados() {
  const alvo = $("#busca-results");
  if (!alvo) return;
  const status = $("#busca-status"), form = $("#busca-form"), input = $("#busca-input");
  const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  const q = new URLSearchParams(location.search).get("q") || "";
  input.value = q;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const nq = input.value.trim();
    location.href = "/busca/" + (nq ? "?q=" + encodeURIComponent(nq) : "");
  });

  if (!q.trim()) { status.textContent = "Digite um termo para buscar."; return; }
  document.title = `Busca: ${q} — Instituto Kenósis`;

  let dados = [];
  try { dados = await (await fetch("/assets/data/search-index.json")).json(); }
  catch { status.textContent = "Não foi possível carregar a busca agora."; return; }

  const termos = norm(q).split(/\s+/).filter(Boolean);
  const achados = dados.map((it) => {
    let pontos = 0;
    for (const t of termos) {
      if (norm(it.t).includes(t)) pontos += 10;
      if (norm(it.d).includes(t)) pontos += 3;
    }
    return { it, pontos };
  }).filter((x) => x.pontos > 0).sort((a, b) => b.pontos - a.pontos);

  status.textContent = achados.length
    ? `${achados.length} resultado${achados.length > 1 ? "s" : ""} para “${q}”.`
    : `Nenhum resultado para “${q}”. Tente outro termo.`;

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  alvo.innerHTML = achados.map(({ it }) => `
    <a class="cartao" href="${esc(it.u)}" style="text-decoration:none">
      <p class="rotulo" style="margin-bottom:.4rem">${esc(it.tipo)}</p>
      <h3 class="cartao__titulo">${esc(it.t)}</h3>
      <p class="cartao__texto">${esc(String(it.d).slice(0, 170))}…</p>
    </a>`).join("");
}

/* ==========================================================================
   Consentimento de cookies (LGPD)
   Os scripts de medição SÓ carregam depois do "Aceitar" — é o consentimento
   prévio que a lei exige, não um aviso decorativo.
   ========================================================================== */
const COOKIE_CONSENT = "ik_consent";
const CONSENT_DIAS = 180;

const lerConsent = () =>
  (new RegExp(`(?:^|;\\s*)${COOKIE_CONSENT}=(aceito|essenciais)`).exec(document.cookie) || [])[1] || null;

function gravarConsent(valor) {
  const seguro = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_CONSENT}=${valor}; Max-Age=${CONSENT_DIAS * 86400}; Path=/; SameSite=Lax${seguro}`;
}

let medicaoCarregada = false;
function carregarMedicao() {
  if (medicaoCarregada) return;
  medicaoCarregada = true;
  const script = (src) => { const s = document.createElement("script"); s.async = true; s.src = src; document.head.appendChild(s); };
  const inline = (code) => { const s = document.createElement("script"); s.textContent = code; document.head.appendChild(s); };

  if (GA4_ID) {
    script(`https://www.googletagmanager.com/gtag/js?id=${GA4_ID}`);
    inline(`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}
      gtag('js',new Date());gtag('config','${GA4_ID}',{anonymize_ip:true});`);
  }
  if (GTM_ID) {
    inline(`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});
      var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';
      j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
      })(window,document,'script','dataLayer','${GTM_ID}');`);
  }
  if (META_PIXEL_ID) {
    inline(`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
      n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script',
      'https://connect.facebook.net/en_US/fbevents.js');fbq('init','${META_PIXEL_ID}');fbq('track','PageView');`);
  }
  if (CLARITY_ID) {
    inline(`(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");`);
  }
  if (HOTJAR_ID) {
    inline(`(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};
      h._hjSettings={hjid:${HOTJAR_ID},hjsv:6};a=o.getElementsByTagName('head')[0];
      r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j;a.appendChild(r);
      })(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');`);
  }
}

function montarBarraCookies() {
  if ($(".cookie-barra")) return;
  const bar = document.createElement("div");
  bar.className = "cookie-barra";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-live", "polite");
  bar.setAttribute("aria-label", "Aviso sobre cookies");
  bar.innerHTML = `
    <div class="cookie-barra__texto">
      <b>A gente usa cookies. 🍪</b>
      <p>Alguns são necessários para o site funcionar. Com a sua autorização, usamos também cookies de medição — só para entender como as pessoas chegam até o Instituto. Nada do que é tratado no atendimento passa por aqui. <a href="/privacidade/">Ler a Política de Privacidade</a>.</p>
    </div>
    <div class="cookie-barra__acoes">
      <button type="button" class="btn btn--contorno btn--p" data-consent="essenciais">Só os essenciais</button>
      <button type="button" class="btn btn--principal btn--p" data-consent="aceito">Aceitar cookies</button>
    </div>`;
  document.body.appendChild(bar);

  // o botão flutuante é criado ANTES da barra, então seletor de irmão não pega:
  // marcamos o body e publicamos a altura real para o CSS subir o botão
  const medir = () => {
    document.body.classList.add("tem-cookie-barra");
    document.body.style.setProperty("--cookie-barra-h", `${Math.ceil(bar.getBoundingClientRect().height)}px`);
  };
  medir();
  window.addEventListener("resize", medir);
  requestAnimationFrame(() => bar.classList.add("aberta"));

  bar.addEventListener("click", (e) => {
    const escolha = e.target.closest("[data-consent]")?.dataset.consent;
    if (!escolha) return;
    gravarConsent(escolha);
    if (escolha === "aceito") carregarMedicao();
    bar.classList.remove("aberta");
    document.body.classList.remove("tem-cookie-barra");
    window.removeEventListener("resize", medir);
    setTimeout(() => bar.remove(), 350);
    aviso(escolha === "aceito" ? "Preferência salva. Obrigado! 💙" : "Certo — só os cookies essenciais.");
  });
}

/* Link no rodapé de todas as páginas — a LGPD exige que rever a escolha seja
   tão fácil quanto fazê-la. Injetado aqui para não duplicar markup nos templates. */
function linksRodape() {
  const alvo = $(".rodape__base p");
  if (!alvo || $(".cookie-prefs")) return;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cookie-prefs";
  b.textContent = "Preferências de cookies";
  b.addEventListener("click", () => {
    document.cookie = `${COOKIE_CONSENT}=; Max-Age=0; Path=/`;
    montarBarraCookies();
  });
  alvo.append(" · ", b);
}

function iniConsentimento() {
  linksRodape();
  const escolha = lerConsent();
  if (!escolha) montarBarraCookies();
  else if (escolha === "aceito") carregarMedicao();
}

/* -------------------------------- Boot ----------------------------------- */
function iniciar() {
  iniCabecalho(); iniMenu(); iniLupa(); iniRevelacao();
  iniFormulario(); iniBotaoZap(); iniServicos(); iniAno(); iniResultados(); iniConsentimento();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
else iniciar();
