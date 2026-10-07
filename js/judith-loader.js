/* Judith — homepage entry points (small; the chat itself is /js/judith.js).
 *
 * Runs only after the page has loaded and gone idle, and asks the server
 * whether Judith is on. If she is, her photo takes the place of the floating
 * WhatsApp button (desktop) and of the WhatsApp button in the bottom bar
 * (phones); WhatsApp stays reachable from inside the chat. If she's off (no
 * API key, or JUDITH_ENABLED=0), nothing on the page changes. */
(function () {
  'use strict';

  const STORE = 'casa-judith';
  const PHOTO = '/img/judith-avatar-192.webp';
  const PHOTO_SM = '/img/judith-avatar-96.webp';
  const CSS = `
.jd-launcher{position:fixed;z-index:44;right:2rem;bottom:2rem;width:62px;height:62px;padding:0;border:0;border-radius:50%;
  background:#f3efe6;cursor:pointer;box-shadow:0 0 0 2px #fff,0 0 0 3.5px rgba(201,169,110,.85),0 8px 26px rgba(47,52,48,.22);
  opacity:0;transform:translateY(8px) scale(.96);transition:opacity .5s ease,transform .5s cubic-bezier(.16,1,.3,1),box-shadow .2s ease}
.jd-launcher.is-in{opacity:1;transform:none}
.jd-launcher:hover{transform:scale(1.05)}
.jd-launcher:focus-visible{outline:2px solid #625e51;outline-offset:5px}
.jd-launcher img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
.jd-hint{position:fixed;z-index:44;right:calc(2rem + 76px);bottom:calc(2rem + 12px);max-width:220px;padding:.55rem .85rem;background:#fff;color:#2f3430;
  border:1px solid rgba(98,94,81,.14);border-radius:14px;border-end-end-radius:4px;box-shadow:0 8px 24px rgba(47,52,48,.12);
  font-size:.86rem;line-height:1.45;cursor:pointer;opacity:0;transform:translateX(6px);transition:opacity .4s ease,transform .4s ease}
.jd-hint.is-in{opacity:1;transform:none}
.jd-hint b{font-weight:500}
html.jd-open .jd-launcher,html.jd-open .jd-hint,body.scroll-locked .jd-launcher,body.scroll-locked .jd-hint{display:none}
.mobile-cta .cta-judith{color:#433f33;border:1px solid rgba(201,169,110,.75);background:rgba(201,169,110,.08)}
.mobile-cta .cta-judith img{width:28px;height:28px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 1.5px rgba(201,169,110,.9)}
@media (max-width:767px){.jd-launcher,.jd-hint{display:none}}
@media (prefers-reduced-motion:reduce){.jd-launcher,.jd-hint{transition:none}}`;

  let loading;

  function loadChat() {
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/js/judith.js';
        s.async = true;
        s.onload = () => (window.CasaJudith ? resolve(window.CasaJudith) : reject(new Error('judith missing')));
        s.onerror = () => { loading = null; reject(new Error('judith failed to load')); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  // The hello next to her photo stays until the visitor opens the chat once.
  const HINT_KEY = 'casa-judith-hint';
  let hint = null;
  function dropHint() {
    try { sessionStorage.setItem(HINT_KEY, 'opened'); } catch (_) {}
    if (hint) { hint.remove(); hint = null; }
  }

  function open(from) {
    dropHint();
    from.setAttribute('aria-busy', 'true');
    loadChat().then((j) => j.open({ launcher: from }))
      .catch(() => { location.href = '/lead?source=judith_ai'; }) // never lose the visitor
      .finally(() => from.removeAttribute('aria-busy'));
  }

  function wire(btn) {
    btn.addEventListener('click', () => open(btn));
    ['pointerenter', 'touchstart', 'focus'].forEach((ev) => btn.addEventListener(ev, () => loadChat().catch(() => {}), { once: true, passive: true }));
    return btn;
  }

  function img(src, size) {
    const i = document.createElement('img');
    i.src = src; i.alt = ''; i.width = size; i.height = size; i.decoding = 'async';
    return i;
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const label = 'צ׳אט עם יהודית מ-Casa Mancini';

    // Desktop: her photo where the floating WhatsApp button was.
    const waFloat = document.getElementById('waFloat');
    if (waFloat) waFloat.style.display = 'none';
    const desk = wire(document.createElement('button'));
    desk.type = 'button';
    desk.className = 'jd-launcher';
    desk.setAttribute('aria-label', label);
    desk.setAttribute('aria-haspopup', 'dialog');
    desk.appendChild(img(PHOTO, 62));
    document.body.appendChild(desk);
    requestAnimationFrame(() => requestAnimationFrame(() => desk.classList.add('is-in')));

    // Desktop: her hello stays next to the photo until the chat is opened.
    let opened = false;
    try { opened = sessionStorage.getItem(HINT_KEY) === 'opened'; } catch (_) {}
    if (!opened) {
      hint = document.createElement('div');
      hint.className = 'jd-hint';
      hint.setAttribute('aria-hidden', 'true');
      hint.innerHTML = '<b>היי, אני יהודית 👋</b><br>יש שאלה על הבית? אני כאן.';
      hint.addEventListener('click', () => open(desk));
      document.body.appendChild(hint);
      setTimeout(() => hint && hint.classList.add('is-in'), 1200);
    }

    // Phones: the bottom bar's WhatsApp button becomes Judith.
    const waBar = document.querySelector('#mobileCta .cta-wa');
    let bar = null;
    if (waBar) {
      bar = wire(document.createElement('button'));
      bar.type = 'button';
      bar.className = 'cta-judith flex-1';
      bar.setAttribute('aria-label', label);
      bar.setAttribute('aria-haspopup', 'dialog');
      bar.append(img(PHOTO_SM, 28), document.createTextNode('יהודית'));
      waBar.replaceWith(bar);
    }

    // A conversation that was open before a reload comes back open.
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      if (saved && saved.open) open(window.matchMedia('(min-width: 768px)').matches || !bar ? desk : bar);
    } catch (_) {}
  }

  function start() {
    fetch('/api/judith/chat', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => { if (s && s.enabled) mount(); })
      .catch(() => {});
  }

  // The site first; Judith once the page is loaded and the browser is idle.
  function whenIdle() {
    if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 4000 });
    else setTimeout(start, 1500);
  }
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
})();
