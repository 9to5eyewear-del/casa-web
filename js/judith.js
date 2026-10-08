/* Judith AI — the chat window (loaded on demand by /js/judith-loader.js).
 *
 * The browser sends only { session_id, message }; history, state and the
 * system prompt live on the server. Messages are rendered as text, never
 * HTML. The visible transcript is kept in sessionStorage so a reload (or a
 * trip to /lead and back) doesn't lose it; "שיחה חדשה" erases it everywhere. */
(function () {
  'use strict';
  if (window.CasaJudith) return;

  const API = '/api/judith/chat';
  const STORE = 'casa-judith';
  const LEAD_URL = '/lead?source=judith_ai';
  const MAX_CHARS = 600;
  const GREETING = 'היי, אני יהודית מקאזה מנצ׳יני 🌿\nאשמח לעזור לבדוק אם הבית מתאים למה שאתם מתכננים — מה מביא אותך אלינו?';
  const FALLBACK = 'נראה שאני לא זמינה לרגע, אבל אני לא רוצה לעכב אותך. אפשר להשאיר כאן כמה פרטים ונחזור אלייך, או לכתוב לנו ישר בוואטסאפ.';
  const WHATSAPP = 'https://wa.me/972546787179';
  const PHOTO = '/img/judith-avatar-96.webp';
  const QUICK = ['התארגנות כלה', 'הפקת צילום', 'רוצה לשמוע על המקום'];

  const CSS = `
.jd-panel{position:fixed;z-index:950;right:2rem;bottom:2rem;width:min(390px,calc(100vw - 4rem));height:min(640px,calc(100vh - 4rem));
  display:flex;flex-direction:column;background:#faf9f6;color:#2f3430;border:1px solid rgba(98,94,81,.14);border-radius:10px;
  box-shadow:0 18px 60px rgba(47,52,48,.22);overflow:hidden;font-family:inherit;direction:rtl;
  opacity:0;transform:translateY(12px) scale(.985);transform-origin:bottom right;transition:opacity .25s ease,transform .3s cubic-bezier(.16,1,.3,1)}
.jd-panel.is-open{opacity:1;transform:none}
.jd-panel[hidden]{display:none}
.jd-head{flex:none;display:flex;align-items:center;gap:.7rem;padding:.85rem 1rem;background:#fff;border-bottom:1px solid rgba(98,94,81,.1)}
.jd-head .jd-avatar{flex:none;width:2.6rem;height:2.6rem;border-radius:50%;object-fit:cover;background:#f3efe6;box-shadow:0 0 0 1.5px #fff,0 0 0 2.5px rgba(201,169,110,.8)}
.jd-title{flex:1;min-width:0;line-height:1.25}
.jd-title b{display:block;font-weight:500;font-size:.98rem}
.jd-title span{display:block;font-size:.74rem;color:#777c77;font-weight:300}
.jd-icon{flex:none;width:2.5rem;height:2.5rem;display:flex;align-items:center;justify-content:center;border:0;background:none;color:#5c605c;border-radius:50%;cursor:pointer}
.jd-icon:hover{background:#f3f1ec;color:#2f3430}
.jd-icon:focus-visible,.jd-send:focus-visible,.jd-chip:focus-visible,.jd-cta:focus-visible{outline:2px solid #625e51;outline-offset:2px}
.jd-icon svg{width:1.15rem;height:1.15rem}
.jd-log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:1.1rem 1rem .5rem;display:flex;flex-direction:column;gap:.55rem;-webkit-overflow-scrolling:touch}
.jd-msg{max-width:86%;padding:.65rem .9rem;border-radius:14px;font-size:.93rem;line-height:1.6;white-space:pre-line;overflow-wrap:anywhere;animation:jd-in .3s ease both}
.jd-msg.from-judith{align-self:flex-start;background:#fff;border:1px solid rgba(98,94,81,.1);border-start-start-radius:4px}
.jd-msg.from-user{align-self:flex-end;background:#433f33;color:#fef7e6;border-start-end-radius:4px;font-weight:300}
.jd-cta-wrap{align-self:flex-start;display:flex;flex-direction:column;gap:.35rem;max-width:86%;animation:jd-in .3s ease both}
.jd-cta{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:46px;padding:0 1.3rem;background:#433f33;color:#fef7e6;
  border-radius:2px;font-size:.92rem;font-weight:500;text-decoration:none;transition:background .2s}
.jd-cta:hover{background:#625e51}
.jd-cta-note{font-size:.74rem;color:#777c77;font-weight:300}
.jd-wa{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;min-height:46px;padding:0 1.2rem;border:1px solid rgba(11,122,69,.45);
  border-radius:2px;color:#0b7a45;background:#fff;font-size:.92rem;font-weight:500;text-decoration:none}
.jd-wa:hover{background:rgba(11,122,69,.06)}
.jd-wa svg{width:1.2rem;height:1.2rem}
.jd-wa:focus-visible{outline:2px solid #625e51;outline-offset:2px}
.jd-chips{display:flex;flex-wrap:wrap;gap:.45rem;align-self:flex-start;animation:jd-in .3s ease both}
.jd-chip{min-height:40px;padding:0 .95rem;border:1px solid rgba(98,94,81,.28);border-radius:999px;background:transparent;color:#433f33;font:inherit;font-size:.86rem;cursor:pointer}
.jd-chip:hover{background:rgba(201,169,110,.12);border-color:rgba(201,169,110,.7)}
.jd-typing{align-self:flex-start;display:flex;gap:4px;padding:.8rem .95rem;background:#fff;border:1px solid rgba(98,94,81,.1);border-radius:14px;border-start-start-radius:4px}
.jd-typing i{width:6px;height:6px;border-radius:50%;background:#a8a29e;animation:jd-dot 1.2s infinite ease-in-out}
.jd-typing i:nth-child(2){animation-delay:.15s}.jd-typing i:nth-child(3){animation-delay:.3s}
.jd-form{flex:none;display:flex;align-items:flex-end;gap:.5rem;padding:.6rem .75rem;background:#fff;border-top:1px solid rgba(98,94,81,.1)}
.jd-input{flex:1;min-height:44px;max-height:7.5rem;resize:none;padding:.65rem .85rem;border:1px solid rgba(98,94,81,.22);border-radius:22px;background:#faf9f6;
  color:#2f3430;font:inherit;font-size:16px;line-height:1.45;outline:none}
.jd-input:focus{border-color:#625e51;background:#fff;box-shadow:none;outline:none}
.jd-send{flex:none;width:44px;height:44px;border-radius:50%;border:0;background:#433f33;color:#fef7e6;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:opacity .2s,background .2s}
.jd-send:hover{background:#625e51}
.jd-send:disabled{opacity:.35;cursor:default}
.jd-send svg{width:1.1rem;height:1.1rem;transform:scaleX(-1)}
.jd-foot{flex:none;padding:0 1rem .55rem;background:#fff;font-size:.68rem;color:#8a8e8a;text-align:center;font-weight:300}
.jd-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@keyframes jd-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes jd-dot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
@media (max-width:767px){
  .jd-panel{left:0;right:0;top:0;bottom:auto;transform-origin:bottom center;width:100%;height:100%;border:0;border-radius:0;box-shadow:none;transform:translateY(16px)}
  .jd-head{padding-top:max(.85rem,env(safe-area-inset-top))}
  .jd-foot{padding-bottom:max(.55rem,env(safe-area-inset-bottom))}
  html.jd-open,html.jd-open body{overflow:hidden}
}
@media (prefers-reduced-motion:reduce){.jd-panel,.jd-msg,.jd-cta-wrap,.jd-chips{transition:none;animation:none}.jd-typing i{animation:none;opacity:.6}}`;

  const ICONS = {
    wa: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21c5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm5.8 14.03c-.25.69-1.44 1.32-2 1.4-.51.08-1.16.11-1.87-.12-.43-.14-.98-.32-1.69-.62-2.98-1.29-4.92-4.29-5.07-4.49-.15-.2-1.21-1.61-1.21-3.07s.77-2.18 1.04-2.48c.27-.3.6-.37.8-.37l.57.01c.18.01.43-.07.67.51.25.6.84 2.06.92 2.21.07.15.12.32.02.52-.1.2-.15.32-.3.5l-.45.52c-.15.15-.3.31-.13.6.17.3.77 1.27 1.65 2.06 1.14 1.01 2.09 1.33 2.39 1.48.3.15.47.12.64-.07.17-.2.74-.86.94-1.16.2-.3.4-.25.67-.15.27.1 1.73.82 2.03.97.3.15.5.22.57.35.08.12.08.72-.17 1.41z"/></svg>',
    leaf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21V9"/><path d="M12 13c-3.5 0-6-2.4-6-6 3.5 0 6 2.4 6 6z"/><path d="M12 10c0-3.6 2.5-6 6-6 0 3.6-2.5 6-6 6z"/><path d="M12 17c2.6 0 4.6-1.7 4.6-4.4-2.6 0-4.6 1.7-4.6 4.4z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  // ── State (sessionStorage; may be unavailable in private modes) ──
  let data = load();
  function fresh() { return { session_id: null, items: [], open: false }; }
  function load() {
    try {
      const d = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      if (d && Array.isArray(d.items)) return d;
    } catch (_) {}
    return fresh();
  }
  function save() { try { sessionStorage.setItem(STORE, JSON.stringify(data)); } catch (_) {} }

  // ── DOM ──
  let panel, log, input, sendBtn, launcher, busy = false, mounted = false;

  function el(tag, attrs, text) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = el('section', { class: 'jd-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'jd-title', hidden: '' });
    const head = el('header', { class: 'jd-head' });
    head.appendChild(el('img', { class: 'jd-avatar', src: PHOTO, alt: '', width: '42', height: '42' }));
    const title = el('div', { class: 'jd-title' });
    title.appendChild(el('b', { id: 'jd-title' }, 'יהודית'));
    title.appendChild(el('span', null, 'Casa Mancini'));
    head.appendChild(title);
    const resetBtn = el('button', { type: 'button', class: 'jd-icon', 'aria-label': 'שיחה חדשה', title: 'שיחה חדשה' });
    resetBtn.innerHTML = ICONS.reset;
    resetBtn.addEventListener('click', reset);
    const closeBtn = el('button', { type: 'button', class: 'jd-icon jd-close', 'aria-label': 'סגירת השיחה', title: 'סגירה' });
    closeBtn.innerHTML = ICONS.close;
    closeBtn.addEventListener('click', close);
    head.append(resetBtn, closeBtn);

    log = el('div', { class: 'jd-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });

    const form = el('form', { class: 'jd-form' });
    const label = el('label', { class: 'jd-sr', for: 'jd-input' }, 'הודעה ליהודית');
    input = el('textarea', { id: 'jd-input', class: 'jd-input', rows: '1', maxlength: String(MAX_CHARS), placeholder: 'כתבו כאן…', enterkeyhint: 'send', autocomplete: 'off' });
    sendBtn = el('button', { type: 'submit', class: 'jd-send', 'aria-label': 'שליחה' });
    sendBtn.innerHTML = ICONS.send;
    form.append(label, input, sendBtn);
    form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
    });
    input.addEventListener('input', () => { autosize(); syncSend(); });

    const foot = el('p', { class: 'jd-foot' }, 'המענה בצ׳אט נכתב בעזרת AI · פרטים סופיים מול הצוות');
    panel.append(head, log, form, foot);
    document.body.appendChild(panel);

    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    if (window.visualViewport) {
      const fit = () => {
        if (!panel.classList.contains('is-open') || window.innerWidth >= 768) { panel.style.height = ''; panel.style.top = ''; return; }
        panel.style.height = `${window.visualViewport.height}px`;
        panel.style.top = `${window.visualViewport.offsetTop}px`;
        scrollDown();
      };
      window.visualViewport.addEventListener('resize', fit);
      window.visualViewport.addEventListener('scroll', fit);
    }
    render();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }
  function syncSend() { sendBtn.disabled = busy || !input.value.trim(); }
  function scrollDown() { if (log) log.scrollTop = log.scrollHeight; }

  // ── Rendering ──
  function bubble(item) {
    const frag = document.createDocumentFragment();
    const msg = el('div', { class: `jd-msg ${item.role === 'user' ? 'from-user' : 'from-judith'}` }, item.text);
    // The conversation itself is never machine-swapped (js/i18n.js); only our own fixed lines are.
    if (item.text !== GREETING && item.text !== FALLBACK) msg.setAttribute('data-no-i18n', '');
    frag.appendChild(msg);
    if (item.handoff_url) {
      const wrap = el('div', { class: 'jd-cta-wrap' });
      const a = el('a', { class: 'jd-cta', href: safeLeadUrl(item.handoff_url) }, 'להשארת פרטים ←');
      a.addEventListener('click', () => { data.open = false; save(); });
      wrap.appendChild(a);
      if (!item.fallback) wrap.appendChild(el('span', { class: 'jd-cta-note' }, 'מה שכבר סיפרת יתמלא אוטומטית'));
      frag.appendChild(wrap);
    }
    if (item.whatsapp_url) {
      const wrap = el('div', { class: 'jd-cta-wrap' });
      const a = el('a', { class: 'jd-wa', href: safeWhatsappUrl(item.whatsapp_url), target: '_blank', rel: 'noopener noreferrer' });
      a.innerHTML = ICONS.wa;
      a.appendChild(document.createTextNode('להמשך איתי בוואטסאפ'));
      wrap.appendChild(a);
      frag.appendChild(wrap);
    }
    return frag;
  }

  // Only ever link to our own WhatsApp number.
  function safeWhatsappUrl(url) {
    return typeof url === 'string' && url.indexOf(WHATSAPP + '?') === 0 ? url : WHATSAPP;
  }

  // Only ever link to our own lead page.
  function safeLeadUrl(url) {
    return typeof url === 'string' && url.indexOf('/lead?') === 0 ? url : LEAD_URL;
  }

  function render() {
    log.replaceChildren(bubble({ role: 'judith', text: GREETING }));
    data.items.forEach((it) => log.appendChild(bubble(it)));
    if (!data.items.length) {
      const chips = el('div', { class: 'jd-chips', role: 'group', 'aria-label': 'הצעות לפתיחה' });
      QUICK.forEach((q) => {
        const c = el('button', { type: 'button', class: 'jd-chip' }, q);
        // What she sees (English on the English site), so Judith answers in that language.
        c.addEventListener('click', () => send(c.textContent));
        chips.appendChild(c);
      });
      log.appendChild(chips);
    }
    syncSend();
    scrollDown();
  }

  function add(item) {
    data.items.push(item);
    save();
    const chips = log.querySelector('.jd-chips');
    if (chips) chips.remove();
    log.appendChild(bubble(item));
    scrollDown();
  }

  function typing(on) {
    const t = log.querySelector('.jd-typing');
    if (on && !t) {
      const d = el('div', { class: 'jd-typing', 'aria-label': 'יהודית כותבת…', role: 'status' });
      d.innerHTML = '<i></i><i></i><i></i>';
      log.appendChild(d);
      scrollDown();
    } else if (!on && t) t.remove();
  }

  // ── Talking to the server ──
  async function send(raw) {
    const text = String(raw || '').trim().slice(0, MAX_CHARS);
    if (!text || busy) return;
    busy = true;
    input.value = '';
    autosize();
    syncSend();
    add({ role: 'user', text });
    typing(true);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let out = null;
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ session_id: data.session_id, message: text }),
        signal: ctrl.signal,
      });
      out = await res.json().catch(() => null);
      if (out && out.session_id) data.session_id = out.session_id;
      if (!res.ok || !out || typeof out.message !== 'string') throw new Error(`status ${res.status}`);
      typing(false);
      add({ role: 'judith', text: out.message, handoff_url: out.handoff_url || null, whatsapp_url: out.whatsapp_url || null });
    } catch (_) {
      // Any failure still ends in a way to leave details — never a dead end.
      typing(false);
      add({ role: 'judith', text: (out && typeof out.message === 'string' && out.message) || FALLBACK,
        handoff_url: safeLeadUrl(out && out.handoff_url), whatsapp_url: safeWhatsappUrl(out && out.whatsapp_url), fallback: true });
    } finally {
      clearTimeout(timer);
      busy = false;
      syncSend();
      if (window.matchMedia('(min-width: 768px)').matches) input.focus();
    }
  }

  function reset() {
    if (busy) return;
    if (data.session_id) {
      fetch(API, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: data.session_id }), keepalive: true }).catch(() => {});
    }
    data = fresh();
    data.open = true;
    save();
    render();
    input.focus();
  }

  // ── Open / close ──
  function open(opts) {
    if (opts && opts.launcher) launcher = opts.launcher;
    mount();
    panel.hidden = false;
    document.documentElement.classList.add('jd-open');
    requestAnimationFrame(() => panel.classList.add('is-open'));
    data.open = true;
    save();
    scrollDown();
    // On phones, let the visitor read first; the keyboard opens on tap.
    if (window.matchMedia('(min-width: 768px)').matches) setTimeout(() => input.focus(), 50);
    else panel.querySelector('.jd-close').focus({ preventScroll: true });
  }

  function close() {
    panel.classList.remove('is-open');
    document.documentElement.classList.remove('jd-open');
    data.open = false;
    save();
    setTimeout(() => { if (!panel.classList.contains('is-open')) panel.hidden = true; }, 250);
    if (launcher) launcher.focus({ preventScroll: true });
  }

  window.CasaJudith = { open, close };
})();
