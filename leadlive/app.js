/* Casa Mancini leads PWA. Plain JS, no build step.
 *
 * Auth lives in an HttpOnly cookie the page never sees; every request just
 * sends it (same origin). Lead data is always rendered as text, never HTML. */
(function () {
  'use strict';

  // ── Labels ──
  const STATUS = { new: 'לטיפול', in_progress: 'בטיפול', won: 'נסגר', lost: 'לא נסגר' };
  const SOURCE = { website_form: 'טופס באתר', lead_page: 'דף ליד' };
  const TYPE = { bridal: 'התארגנות כלה', production: 'הפקת צילום', fashion: 'צילום אופנה', product: 'צילום מוצר', other: 'אחר' };
  const URGENCY = { this_week: 'השבוע', this_month: 'בחודש הקרוב', three_months: 'ב-3 החודשים הקרובים', flexible: 'גמיש' };
  const SCORE = { hot: 'HOT', warm: 'WARM', cold: 'COLD' };

  const $ = (sel) => document.querySelector(sel);
  const state = {
    status: '', source: '', q: '',
    leads: [], cursor: null, loading: false, listSeq: 0,
    vapidKey: null, authed: false,
  };

  // ── DOM helper: children are text unless they're nodes ──
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false || c === '') continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ICONS = {
    wa: 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7.5-.1 1.5-.6 1.7-1.2s.2-1.1.2-1.2-.2-.2-.4-.3z',
    call: 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.2 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.2.2 2.4.6 3.6a1 1 0 0 1-.3 1z',
    open: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z',
  };
  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', ICONS[name]);
    svg.append(p);
    return svg;
  };

  // ── Formatting ──
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y.slice(2)}`; };
  function fmtTime(ts) {
    const d = new Date(ts), now = new Date();
    const mins = Math.round((now - d) / 60000);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (mins < 1) return 'עכשיו';
    if (mins < 60) return `לפני ${mins} דק׳`;
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d >= startOfDay) return `היום ${hm}`;
    if (d >= new Date(startOfDay - 86400000)) return `אתמול ${hm}`;
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${d.getFullYear() !== now.getFullYear() ? '.' + String(d.getFullYear()).slice(2) : ''} ${hm}`;
  }
  const fmtFull = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const typeLabel = (l) => TYPE[l.lead_type] || l.lead_type || 'פנייה';
  const sourceLabel = (s) => SOURCE[s] || s;
  const relevantDate = (l) => (l.event_date ? fmtDate(l.event_date) : URGENCY[l.urgency] || '');

  // Prefer the normalized number (972…); fall back to the digits typed.
  function phoneDigits(l) {
    const d = l.phone_normalized || String(l.phone || '').replace(/\D/g, '');
    return d.length >= 7 ? d : null;
  }
  const waHref = (l) => { const d = phoneDigits(l); return d ? `https://wa.me/${d}` : null; };
  const telHref = (l) => (l.phone_normalized ? `tel:+${l.phone_normalized}` : l.phone ? `tel:${String(l.phone).replace(/[^\d+]/g, '')}` : null);

  // ── API ──
  class HttpError extends Error { constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; } }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        credentials: 'same-origin',
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
      });
    } catch (err) {
      setOffline(true);
      throw err;
    }
    setOffline(false);
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && !opts.allow401) { showLogin(); throw new HttpError(401, body); }
    if (!res.ok) throw new HttpError(res.status, body);
    return body;
  }

  // ── UI bits ──
  let toastTimer;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function setOffline(on) { $('#offline').hidden = !on; }
  function sheet(title, text) {
    $('#sheetTitle').textContent = title;
    $('#sheetText').textContent = text;
    $('#sheet').hidden = false;
  }

  // ── Login ──
  function showLogin() {
    state.authed = false;
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginError').textContent = '';
    setTimeout(() => $('#password').focus(), 50);
  }

  async function onLogin(e) {
    e.preventDefault();
    const input = $('#password'), err = $('#loginError'), btn = e.target.querySelector('button');
    if (!input.value) { err.textContent = 'נא להזין סיסמה'; return; }
    btn.disabled = true;
    err.textContent = '';
    try {
      await api('/api/auth/login', { method: 'POST', body: { password: input.value }, allow401: true });
      input.value = '';
      await boot();
    } catch (ex) {
      if (ex.status === 401) err.textContent = 'סיסמה שגויה';
      else if (ex.status === 429) err.textContent = `יותר מדי ניסיונות. אפשר לנסות שוב בעוד ${Math.ceil((ex.body.retry_after_seconds || 60) / 60)} דק׳`;
      else if (!navigator.onLine || !ex.status) err.textContent = 'אין חיבור לאינטרנט';
      else err.textContent = 'משהו השתבש, נסו שוב';
    } finally {
      btn.disabled = false;
    }
  }

  async function logout() {
    closeMenu();
    try { await api('/api/auth/logout', { method: 'POST', allow401: true }); } catch {}
    state.leads = [];
    $('#leadList').replaceChildren();
    history.replaceState(null, '', '/leadlive');
    showLogin();
  }

  // ── List ──
  function renderCounts(c) {
    document.querySelectorAll('.counter').forEach((el) => {
      el.querySelector('b').textContent = c[el.dataset.status] ?? 0;
      el.classList.toggle('is-active', state.status === el.dataset.status);
    });
  }
  function syncChips() {
    document.querySelectorAll('#statusChips .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.status === state.status));
    document.querySelectorAll('#sourceChips .chip').forEach((c) => c.classList.toggle('is-active', c.dataset.source === state.source));
    document.querySelectorAll('.counter').forEach((el) => el.classList.toggle('is-active', state.status === el.dataset.status));
  }

  function card(l) {
    const wa = waHref(l), tel = telHref(l);
    const what = [typeLabel(l), relevantDate(l)].filter(Boolean).join(' · ');
    return h('li', { class: 'card' },
      h('a', { class: 'card-main', href: `#/lead/${l.id}` },
        h('div', { class: 'card-top' },
          h('h2', { class: 'card-name' }, l.name),
          l.lead_score && h('span', { class: `score score-${l.lead_score}` }, SCORE[l.lead_score])),
        h('p', { class: 'card-what' }, what),
        h('p', { class: 'card-meta' },
          h('span', { class: 'phone' }, l.phone),
          h('span', null, sourceLabel(l.source)),
          h('span', null, fmtTime(l.last_submission_at))),
        h('div', { class: 'badges' },
          h('span', { class: `badge badge-status-${l.status}` }, STATUS[l.status] || l.status),
          l.submission_count > 1 && h('span', { class: 'badge badge-repeat' }, `פנייה חוזרת ×${l.submission_count}`))),
      h('div', { class: 'card-actions' },
        wa ? h('a', { class: 'wa', href: wa, target: '_blank', rel: 'noopener' }, icon('wa'), 'WhatsApp')
           : h('span', { class: 'is-disabled' }, icon('wa'), 'WhatsApp'),
        tel ? h('a', { href: tel }, icon('call'), 'התקשר') : h('span', { class: 'is-disabled' }, icon('call'), 'התקשר'),
        h('a', { href: `#/lead/${l.id}` }, 'פתח', icon('open'))));
  }

  async function loadList({ more = false } = {}) {
    const seq = ++state.listSeq;
    const list = $('#leadList');
    if (!more && !state.leads.length) list.replaceChildren(...[1, 2, 3].map(() => h('li', { class: 'skeleton' })));
    $('#loadMore').disabled = true;

    const params = new URLSearchParams();
    if (state.status) params.set('status', state.status);
    if (state.source) params.set('source', state.source);
    if (state.q) params.set('q', state.q);
    if (more && state.cursor) params.set('cursor', state.cursor);

    try {
      const data = await api(`/api/leadlive?${params}`);
      if (seq !== state.listSeq) return; // a newer request superseded this one
      state.leads = more ? state.leads.concat(data.leads) : data.leads;
      state.cursor = data.next_cursor;
      if (data.counts) renderCounts(data.counts);
      list.replaceChildren(...state.leads.map(card));
      $('#listEmpty').hidden = state.leads.length > 0;
      $('#loadMore').hidden = !state.cursor;
    } catch (err) {
      if (seq !== state.listSeq) return;
      if (err.status !== 401) {
        if (!state.leads.length) list.replaceChildren();
        if (err.status) toast('טעינת הלידים נכשלה');
      }
    } finally {
      $('#loadMore').disabled = false;
    }
  }

  // ── Detail ──
  function fieldRows(l) {
    const rows = [
      ['סוג פנייה', [typeLabel(l), l.lead_subtype].filter(Boolean).join(' · ')],
      ['תאריך', l.event_date && fmtDate(l.event_date)],
      ['מתי', URGENCY[l.urgency]],
      ['מלוות', l.companions != null && String(l.companions)],
      ['סוג הפקה', l.production_type],
      ['תקציב', l.budget != null && `₪${Number(l.budget).toLocaleString('he-IL')}`],
    ];
    return rows.filter(([, v]) => v);
  }
  const dl = (rows) => h('dl', { class: 'fields' }, rows.flatMap(([k, v, cls]) => [h('dt', null, k), h('dd', { class: cls }, v)]));

  function eventItem(e) {
    let title, extra;
    if (e.type === 'lead_created') {
      title = `הליד נוצר · ${sourceLabel(e.data?.source)}`;
    } else if (e.type === 'repeat_submission') {
      title = `פנייה חוזרת · ${sourceLabel(e.data?.source)}`;
      const d = e.data || {};
      extra = [d.lead_type && TYPE[d.lead_type], d.event_date && fmtDate(d.event_date), d.message].filter(Boolean).join('\n');
    } else if (e.type === 'status_changed') {
      title = `סטטוס: ${STATUS[e.from_status] || e.from_status} ← ${STATUS[e.to_status] || e.to_status}`;
    } else {
      title = e.type;
    }
    return h('li', null, title, extra && h('span', { class: 'tl-extra' }, extra), h('time', null, fmtFull(e.created_at)));
  }

  async function setStatus(l, status, picker) {
    if (l.status === status) return;
    const buttons = picker.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const { lead } = await api(`/api/leadlive/${l.id}`, { method: 'PATCH', body: { status } });
      toast(`הסטטוס עודכן: ${STATUS[lead.status]}`);
      state.leads = []; // list + counters reload when going back
      await openLead(l.id, { keepScroll: true });
    } catch (err) {
      if (err.status !== 401) toast(err.status ? 'השמירה נכשלה, נסו שוב' : 'אין חיבור — הסטטוס לא נשמר');
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  async function openLead(id, { keepScroll = false } = {}) {
    const view = $('#detailView');
    $('#listView').hidden = true;
    view.hidden = false;
    if (!keepScroll) {
      view.replaceChildren(h('div', { class: 'skeleton' }));
      window.scrollTo(0, 0);
    }
    let l;
    try {
      ({ lead: l } = await api(`/api/leadlive/${encodeURIComponent(id)}`));
    } catch (err) {
      if (err.status === 401) return;
      view.replaceChildren(backBtn(), h('p', { class: 'empty' }, err.status === 404 ? 'הליד לא נמצא' : 'טעינת הליד נכשלה'));
      return;
    }
    if (location.hash !== `#/lead/${id}`) return; // navigated away meanwhile

    const wa = waHref(l), tel = telHref(l);
    const picker = h('div', { class: 'status-picker', role: 'group', 'aria-label': 'סטטוס' },
      Object.entries(STATUS).map(([key, label]) => h('button', {
        type: 'button', class: key === l.status ? 'is-active' : '', 'aria-pressed': String(key === l.status),
        onclick: () => setStatus(l, key, picker),
      }, label)));

    const contact = [['שם', l.name], ['טלפון', l.phone, 'ltr']];
    if (l.email) contact.push(['אימייל', h('a', { href: `mailto:${l.email}` }, l.email), 'ltr']);

    const meta = [
      ['מקור', sourceLabel(l.source)],
      ['Lead Score', l.lead_score ? SCORE[l.lead_score] : 'אין מספיק מידע'],
      ['נוצר', fmtFull(l.created_at)],
      ['פעילות אחרונה', fmtFull(l.last_submission_at)],
      ['מספר פניות', String(l.submission_count)],
    ];
    if (l.closed_at) meta.push(['נסגר', fmtFull(l.closed_at)]);

    view.replaceChildren(
      backBtn(),
      h('div', { class: 'd-head' },
        h('h1', null, l.name),
        h('div', { class: 'badges' },
          h('span', { class: `badge badge-status-${l.status}` }, STATUS[l.status] || l.status),
          l.submission_count > 1 && h('span', { class: 'badge badge-repeat' }, `פנייה חוזרת ×${l.submission_count}`),
          l.lead_score && h('span', { class: `score score-${l.lead_score}` }, SCORE[l.lead_score]))),
      h('div', { class: 'd-actions' },
        wa ? h('a', { class: 'btn wa', href: wa, target: '_blank', rel: 'noopener' }, 'WhatsApp') : null,
        tel ? h('a', { class: 'btn btn-primary', href: tel }, 'התקשר') : null),
      picker,
      l.possible_duplicate_of && h('div', { class: 'section' },
        h('span', { class: 'badge badge-dup' }, 'ייתכן שזה לקוח קיים'), ' ',
        h('button', { type: 'button', class: 'link-btn', onclick: () => { location.hash = `#/lead/${l.possible_duplicate_of}`; } }, 'לליד הקודם')),
      h('section', { class: 'section' }, h('h2', null, 'פרטי לקוח'), dl(contact)),
      fieldRows(l).length && h('section', { class: 'section' }, h('h2', null, 'פרטי הפנייה'), dl(fieldRows(l))),
      l.message && h('section', { class: 'section' }, h('h2', null, 'הודעה / הערות'), h('p', { class: 'message' }, l.message)),
      h('section', { class: 'section' }, h('h2', null, 'פרטים'), dl(meta)),
      h('section', { class: 'section' }, h('h2', null, 'היסטוריה'),
        h('ul', { class: 'timeline' }, [...(l.events || [])].reverse().map(eventItem))));
  }

  const backBtn = () => h('button', { type: 'button', class: 'back', onclick: () => { location.hash = '#/'; } }, '→ כל הלידים');

  // ── Routing ──
  function route() {
    if (!state.authed) return;
    const m = location.hash.match(/^#\/lead\/([0-9a-f-]{36})$/i);
    if (m) return openLead(m[1]);
    $('#detailView').hidden = true;
    $('#listView').hidden = false;
    syncChips();
    loadList();
  }

  // ── Menu ──
  function closeMenu() { $('#menu').hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); }
  function toggleMenu() {
    const open = $('#menu').hidden;
    $('#menu').hidden = !open;
    $('#menuBtn').setAttribute('aria-expanded', String(open));
    if (open) refreshPushUi();
  }

  // ── Push ──
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function b64ToBytes(b64) {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  }
  async function currentSubscription() {
    if (!pushSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  function promptDismissed() { try { return localStorage.getItem('casa-leads-push-dismissed') === '1'; } catch { return false; } }

  async function refreshPushUi() {
    const item = $('#menuPush'), prompt = $('#pushPrompt');
    let sub = null;
    try { sub = await currentSubscription(); } catch {}
    const on = Boolean(sub) && Notification.permission === 'granted';
    item.textContent = on ? 'כיבוי התראות במכשיר הזה' : 'הפעל התראות';
    prompt.hidden = on || promptDismissed() || (pushSupported() && Notification.permission === 'denied') || !state.vapidKey;
    return sub;
  }

  async function enablePush() {
    closeMenu();
    if (!pushSupported()) {
      if (isIos && !isStandalone) {
        return sheet('התראות באייפון', 'באייפון, התראות עובדות רק מהאפליקציה שעל מסך הבית. בספארי: כפתור השיתוף ← "הוספה למסך הבית", ואז פותחים את "לידים" מהמסך הראשי ומפעילים התראות משם.');
      }
      return sheet('התראות', 'הדפדפן הזה לא תומך בהתראות. נסו מ-Chrome או מ-Safari מעודכן.');
    }
    if (!state.vapidKey) return toast('התראות עדיין לא הוגדרו בשרת');
    const existing = await currentSubscription();
    if (existing) {
      await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint: existing.endpoint } }).catch(() => {});
      await existing.unsubscribe().catch(() => {});
      toast('ההתראות כובו במכשיר הזה');
      return refreshPushUi();
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      return sheet('ההתראות חסומות', 'כדי לקבל התראות צריך לאשר אותן. אפשר לשנות את זה בהגדרות המכשיר עבור "לידים".');
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.vapidKey) });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
      toast('התראות הופעלו ✓');
    } catch (err) {
      if (err.status !== 401) toast('הפעלת ההתראות נכשלה');
    }
    refreshPushUi();
  }

  // Keep the server's copy in sync (e.g. after the browser rotated it).
  async function resyncPush() {
    try {
      if (!pushSupported() || Notification.permission !== 'granted') return;
      const sub = await currentSubscription();
      if (sub) await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    } catch {}
  }

  // ── Boot ──
  async function boot() {
    let s;
    try {
      s = await api('/api/auth/session', { allow401: true });
    } catch {
      // Offline at launch: show the shell with the banner; retry when back online.
      $('#login').hidden = true;
      $('#app').hidden = false;
      return;
    }
    if (!s.authenticated) return showLogin();
    state.authed = true;
    state.vapidKey = s.vapid_public_key;
    $('#login').hidden = true;
    $('#app').hidden = false;
    route();
    refreshPushUi();
    resyncPush();
  }

  function init() {
    $('#loginForm').addEventListener('submit', onLogin);
    $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
    $('#menuLogout').addEventListener('click', logout);
    $('#menuRefresh').addEventListener('click', () => { closeMenu(); route(); });
    $('#menuPush').addEventListener('click', enablePush);
    $('#pushPrompt').addEventListener('click', (e) => {
      if (e.target.closest('[data-dismiss]')) {
        try { localStorage.setItem('casa-leads-push-dismissed', '1'); } catch {}
        $('#pushPrompt').hidden = true;
        return;
      }
      enablePush();
    });
    $('#sheetClose').addEventListener('click', () => { $('#sheet').hidden = true; });

    $('#statusChips').addEventListener('click', (e) => {
      const c = e.target.closest('.chip'); if (!c) return;
      state.status = c.dataset.status; state.leads = []; syncChips(); loadList();
    });
    $('#sourceChips').addEventListener('click', (e) => {
      const c = e.target.closest('.chip'); if (!c) return;
      state.source = c.dataset.source; state.leads = []; syncChips(); loadList();
    });
    $('#counters').addEventListener('click', (e) => {
      const c = e.target.closest('.counter'); if (!c) return;
      state.status = state.status === c.dataset.status ? '' : c.dataset.status; state.leads = []; syncChips(); loadList();
    });
    let searchTimer;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.leads = []; loadList(); }, 300);
    });
    $('#loadMore').addEventListener('click', () => loadList({ more: true }));

    window.addEventListener('hashchange', route);
    window.addEventListener('online', () => { setOffline(false); state.authed ? route() : boot(); });
    window.addEventListener('offline', () => setOffline(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.authed && $('#detailView').hidden) loadList();
    });
    if (!navigator.onLine) setOffline(true);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/leadlive/sw.js', { scope: '/leadlive' }).catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'open' && e.data.url) {
          const hash = new URL(e.data.url, location.origin).hash;
          if (hash) location.hash = hash;
        } else if (e.data?.type === 'lead' && state.authed && $('#detailView').hidden) {
          loadList();
        }
      });
    }
    boot();
  }

  init();
})();
