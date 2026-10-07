/* Judith AI — homepage launcher (small; the chat itself is /js/judith.js).
 *
 * Runs only after the page has loaded and gone idle, asks the server whether
 * Judith is on (no API key → no button at all), then shows the launcher. The
 * chat code is fetched on first intent (hover / touch / focus) or click. */
(function () {
  'use strict';

  const STORE = 'casa-judith';
  const CSS = `
.jd-launcher{position:fixed;z-index:44;left:2rem;bottom:2rem;display:flex;align-items:center;gap:.7rem;
  padding:.45rem 1.1rem .45rem .45rem;background:#fff;color:#2f3430;border:1px solid rgba(98,94,81,.16);border-radius:999px;
  box-shadow:0 6px 24px rgba(47,52,48,.12);font:inherit;cursor:pointer;opacity:0;transform:translateY(8px);
  transition:opacity .5s ease,transform .5s cubic-bezier(.16,1,.3,1),box-shadow .2s ease}
.jd-launcher.is-in{opacity:1;transform:none}
.jd-launcher:hover{box-shadow:0 10px 30px rgba(47,52,48,.18)}
.jd-launcher:focus-visible{outline:2px solid #625e51;outline-offset:3px}
.jd-avatar{flex:none;width:2.6rem;height:2.6rem;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:#f3efe6;color:#8a672a;box-shadow:inset 0 0 0 1px rgba(201,169,110,.55)}
.jd-avatar svg{width:58%;height:58%}
.jd-launcher-text{display:flex;flex-direction:column;align-items:flex-start;line-height:1.2;text-align:right}
.jd-launcher-text b{font-weight:500;font-size:.92rem}
.jd-launcher-text span{font-size:.72rem;color:#777c77;font-weight:300}
.jd-launcher[hidden],html.jd-open .jd-launcher,body.scroll-locked .jd-launcher{display:none}
.jd-launcher.in-hero{opacity:0;pointer-events:none;transform:translateY(8px)}
@media (max-width:767px){
  .jd-launcher{left:.85rem;bottom:calc(76px + env(safe-area-inset-bottom));padding:.3rem}
  .jd-launcher-text{display:none}
  .jd-avatar{width:2.85rem;height:2.85rem}
}
@media (prefers-reduced-motion:reduce){.jd-launcher{transition:none}}`;

  let btn, loading;

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

  function open() {
    btn.setAttribute('aria-busy', 'true');
    loadChat().then((j) => j.open({ launcher: btn }))
      .catch(() => { location.href = '/lead?source=judith_ai'; }) // never lose the visitor
      .finally(() => btn.removeAttribute('aria-busy'));
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jd-launcher';
    btn.setAttribute('aria-label', 'שיחה עם יהודית, העוזרת הדיגיטלית של Casa Mancini');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.innerHTML = '<span class="jd-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21V9"/><path d="M12 13c-3.5 0-6-2.4-6-6 3.5 0 6 2.4 6 6z"/><path d="M12 10c0-3.6 2.5-6 6-6 0 3.6-2.5 6-6 6z"/><path d="M12 17c2.6 0 4.6-1.7 4.6-4.4-2.6 0-4.6 1.7-4.6 4.4z"/></svg></span>'
      + '<span class="jd-launcher-text" aria-hidden="true"><b>יהודית</b><span>העוזרת הדיגיטלית · יש שאלה?</span></span>';
    btn.addEventListener('click', open);
    ['pointerenter', 'touchstart', 'focus'].forEach((ev) => btn.addEventListener(ev, () => loadChat().catch(() => {}), { once: true, passive: true }));
    document.body.appendChild(btn);
    requestAnimationFrame(() => requestAnimationFrame(() => btn.classList.add('is-in')));

    // Phones: the hero has its own big CTAs, so the button waits below it
    // instead of sitting on top of them.
    const hero = document.getElementById('top');
    if (hero && 'IntersectionObserver' in window) {
      const phone = window.matchMedia('(max-width: 767px)');
      new IntersectionObserver(([e]) => {
        btn.classList.toggle('in-hero', phone.matches && e.intersectionRatio > 0.35);
      }, { threshold: [0, 0.35, 1] }).observe(hero);
    }

    // A conversation that was open before a reload comes back open.
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      if (saved && saved.open) open();
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
