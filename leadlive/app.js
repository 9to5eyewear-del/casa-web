/* Casa Mancini · LeadLive. Plain JS, no build step.
 *
 * Auth lives in an HttpOnly cookie the page never sees; every request just
 * sends it (same origin). Lead data is always rendered as text, never HTML.
 * Every number on screen comes from /api/dashboard or /api/leads — this file
 * formats, it never computes a metric of its own.
 *
 * Routes: #/ home · #/leads · #/insights · #/new (manual lead) · #/lead/{id} (push deep links). */
(function () {
  'use strict';

  // ── Labels ──
  const STATUS = { new: 'לטיפול', in_progress: 'בטיפול', won: 'נסגר', lost: 'לא נסגר' };
  // Where a hand-entered lead came from (the server accepts only these on /api/leads/manual).
  const MANUAL_SOURCE = { phone: 'שיחת טלפון', whatsapp: 'וואטסאפ', instagram: 'אינסטגרם', facebook: 'פייסבוק', referral: 'המלצה', walk_in: 'הגיעו לסטודיו', manual: 'אחר' };
  const SOURCE = { website_form: 'טופס באתר', lead_page: 'דף ליד', judith_ai: 'יהודית AI', ...MANUAL_SOURCE, manual: 'הוזן ידנית' };
  const TYPE = { bridal: 'התארגנות כלה', production: 'הפקת צילום', fashion: 'צילום אופנה', product: 'צילום מוצר', other: 'אחר', unknown: 'לא צוין' };
  // l.timing: the server files every lead by how far off its date is, fresh on each load (priority.js → timingFor).
  const URGENCY = { this_week: 'השבוע', this_month: 'בחודש הקרוב', three_months: 'ב-3 החודשים הקרובים', later: 'בעוד יותר מ-3 חודשים', past: 'התאריך עבר', flexible: 'גמיש' };
  const PAYMENT = { transfer: 'העברה בנקאית', credit: 'אשראי', bit: 'ביט / פייבוקס', cash: 'מזומן', check: 'צ׳ק', other: 'אחר' };
  const PRIO = { hot: '🔥 HOT', warm: '● WARM', cold: '○ COLD' };
  const SCORE = { hot: 'HOT', warm: 'WARM', cold: 'COLD' };
  const RANGES = [['7d', '7 ימים'], ['30d', '30 ימים'], ['this_month', 'החודש'], ['previous_month', 'חודש קודם']];
  const VS = { '7d': 'מ-7 הימים הקודמים', '30d': 'מ-30 הימים הקודמים', this_month: 'מאותה נקודה בחודש שעבר', previous_month: 'מהחודש שלפניו', custom: 'מהתקופה הקודמת' };
  const ATTENTION = {
    waiting: { label: '⏰ ממתין לטיפול' },
    hot: { label: '🔥 ליד HOT' },
    repeat: { label: '↩ פנייה חוזרת' },
    date_soon: { label: '📅 תאריך מתקרב' },
  };

  const $ = (sel) => document.querySelector(sel);
  const VIEWS = ['homeView', 'leadsView', 'insightsView', 'detailView', 'newView'];
  const state = {
    authed: false, vapidKey: null, installPrompt: null,
    range: loadRange(), custom: null,          // custom = { from, to } (desktop only)
    dash: null, dashKey: null, dashSeq: 0, dashError: false,
    filter: '', source: '', q: '',
    leads: [], cursor: null, listSeq: 0, listStale: true,
    counts: null,
  };

  function loadRange() {
    try { const r = localStorage.getItem('leadlive-range'); if (RANGES.some(([k]) => k === r)) return r; } catch {}
    return '30d';
  }
  function saveRange(r) { try { localStorage.setItem('leadlive-range', r); } catch {} }

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
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  const ICONS = {
    wa: 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7.5-.1 1.5-.6 1.7-1.2s.2-1.1.2-1.2-.2-.2-.4-.3z',
    call: 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.2 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.2.2 2.4.6 3.6a1 1 0 0 1-.3 1z',
  };
  const icon = (name) => s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));

  // ── Formatting ──
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; };
  const fmtShort = (iso) => { const [, m, d] = iso.split('-'); return `${Number(d)}.${Number(m)}`; };
  const fmtFull = (ts) => { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmtHm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const ils = (n) => `₪${Number(n).toLocaleString('he-IL')}`;
  const pct = (x, digits = 0) => `${(x * 100).toFixed(digits).replace(/\.0$/, '')}%`;
  const typeLabel = (l) => TYPE[l.lead_type] || l.lead_type || 'פנייה';
  const sourceLabel = (src) => SOURCE[src] || src;

  /** עכשיו · לפני 8 דקות · לפני שעה · אתמול · לפני 3 ימים · 12.09.26 */
  function rel(ts) {
    const d = new Date(ts), now = new Date();
    const mins = Math.floor((now - d) / 60000);
    if (mins < 1) return 'עכשיו';
    if (mins === 1) return 'לפני דקה';
    if (mins < 60) return `לפני ${mins} דקות`;
    const hours = Math.floor(mins / 60);
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d >= startOfDay || hours < 6) return hours === 1 ? 'לפני שעה' : hours === 2 ? 'לפני שעתיים' : `לפני ${hours} שעות`;
    const days = Math.round((startOfDay - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (days === 1) return 'אתמול';
    if (days === 2) return 'לפני יומיים';
    if (days < 7) return `לפני ${days} ימים`;
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${d.getFullYear() !== now.getFullYear() ? '.' + String(d.getFullYear()).slice(2) : ''}`;
  }
  function untilText(days) {
    if (days == null || days < 0) return null;
    if (days === 0) return 'היום';
    if (days === 1) return 'מחר';
    return `בעוד ${days} ימים`;
  }
  function whenText(l) {
    if (l.event_date) {
      const u = l.priority && untilText(l.priority.days_to_event);
      return u ? `${fmtDate(l.event_date)} · ${u}` : fmtDate(l.event_date);
    }
    return URGENCY[l.timing || l.urgency] || '';
  }

  // Red number on the app icon = unread leads.
  function setBadge(n) {
    if (!('setAppBadge' in navigator) || typeof n !== 'number') return;
    (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }
  // The "לידים" tab badge = leads still 'לטיפול'.
  function setNavBadge(n) {
    const b = $('#navBadge');
    b.hidden = !(n > 0);
    b.textContent = n > 99 ? '99+' : String(n || '');
    b.setAttribute('aria-label', `${n} לידים לטיפול`);
  }
  function applyCounts(c) {
    if (!c) return;
    state.counts = c;
    setBadge(c.unread);
    setNavBadge(c.new);
    document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = c[el.dataset.count] || ''; });
  }

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
  function toast(text, { success = false } = {}) {
    const t = $('#toast');
    t.textContent = text;
    t.className = success ? 'toast is-success' : 'toast';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  function setOffline(on) { $('#offline').hidden = !on; }

  let sheetReturn = null;
  function openSheet(title, ...body) {
    sheetReturn = document.activeElement;
    $('#sheetTitle').textContent = title;
    $('#sheetBody').replaceChildren(...body);
    $('#sheet').hidden = false;
    const first = $('#sheetBody').querySelector('button, a');
    if (first) first.focus({ preventScroll: true });
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    if (sheetReturn && sheetReturn.isConnected) sheetReturn.focus({ preventScroll: true });
  }
  const infoSheet = (title, text) => openSheet(title, h('p', null, text),
    h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: closeSheet }, 'הבנתי'));

  function emptyState(title, text, action) {
    return h('div', { class: 'empty-state' }, h('h3', null, title), text && h('p', null, text), action);
  }
  function errorState(text, retry) {
    const el = emptyState('לא הצלחנו לטעון את הנתונים', text,
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: retry }, 'נסה שוב'));
    el.classList.add('is-error');
    return el;
  }

  // Counts up to the new value (only numbers that changed; skipped for reduced motion).
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  function countTo(el, to, fmt = String) {
    const from = Number(el.dataset.v || 0);
    el.dataset.v = to;
    if (reduceMotion.matches || from === to || !Number.isFinite(to)) { el.firstChild.textContent = fmt(to); return; }
    const start = performance.now(), dur = 420;
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - k, 3);
      el.firstChild.textContent = fmt(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
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
    state.leads = []; state.dash = null; state.dashKey = null;
    $('#leadList').replaceChildren();
    VIEWS.forEach((v) => { if (v !== 'leadsView') $('#' + v).replaceChildren(); });
    history.replaceState(null, '', '/leadlive');
    showLogin();
  }

  // ══════════════════ Dashboard data ══════════════════

  function dashQuery() {
    if (state.range === 'custom' && state.custom) return `range=custom&from=${state.custom.from}&to=${state.custom.to}`;
    return `range=${state.range}`;
  }

  /** Loads /api/dashboard for the current range, then re-renders whichever dashboard view is showing. */
  async function loadDash({ force = false } = {}) {
    const key = dashQuery();
    if (!force && state.dash && state.dashKey === key) return renderDashViews();
    const seq = ++state.dashSeq;
    if (state.dashKey !== key) state.dash = null;   // a different period: show skeletons, not stale numbers
    state.dashError = false;
    renderDashViews();
    try {
      const data = await api(`/api/dashboard?${key}`);
      if (seq !== state.dashSeq) return;
      state.dash = data; state.dashKey = key; state.dashAt = Date.now();
      setNavBadge(data.summary.open_now.new);
      setBadge(data.summary.open_now.unread);
    } catch (err) {
      if (seq !== state.dashSeq || err.status === 401) return;
      state.dashError = true;
    }
    renderDashViews();
  }
  function renderDashViews() {
    if (!$('#homeView').hidden) renderHome();
    if (!$('#insightsView').hidden) renderInsights();
  }
  function setRange(r, custom) {
    state.range = r;
    state.custom = custom || null;
    if (r !== 'custom') saveRange(r);
    loadDash();
  }

  // ══════════════════ Components ══════════════════

  function rangeControl() {
    const wrap = h('div', null);
    const custom = h('div', { class: 'custom-range' + (state.range === 'custom' ? ' is-open' : '') });
    const bar = h('div', { class: 'range', role: 'group', 'aria-label': 'תקופה' },
      RANGES.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(state.range === k), onclick: () => setRange(k) }, label)),
      h('button', { type: 'button', class: 'only-desktop', 'aria-pressed': String(state.range === 'custom'),
        onclick: () => custom.classList.toggle('is-open') }, 'טווח מותאם'));
    const today = new Date().toLocaleDateString('en-CA');
    const from = h('input', { type: 'date', 'aria-label': 'מתאריך', max: today, value: state.custom?.from || '' });
    const to = h('input', { type: 'date', 'aria-label': 'עד תאריך', max: today, value: state.custom?.to || today });
    custom.append('מ-', from, 'עד', to, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => {
      if (!from.value || !to.value || from.value > to.value) return toast('בחרו תאריך התחלה וסיום');
      setRange('custom', { from: from.value, to: to.value });
    } }, 'הצג'));
    wrap.append(bar, custom);
    return wrap;
  }

  function delta(change, { points = false } = {}) {
    if (change == null) return null;
    const v = points ? Math.abs(change * 100).toFixed(1).replace(/\.0$/, '') : Math.round(Math.abs(change) * 100);
    if (Number(v) === 0) return h('span', { class: 'delta flat' }, 'ללא שינוי');
    const up = change > 0;
    return h('span', { class: `delta ${up ? 'up' : 'down'}` }, up ? '↑' : '↓', points ? `${v} נק׳` : `${v}%`);
  }

  // ── Micro visuals: each KPI shows the shape behind its number ──

  // Tiny trend line of one series from the period's trend points.
  function spark(values, cls) {
    if (values.length < 2 || !values.some(Boolean)) return null;
    const W = 120, H = 30, max = Math.max(...values, 1);
    // RTL: oldest on the right, like the main chart.
    const pts = values.map((v, i) => [W - (i * W) / (values.length - 1), H - 2 - (v / max) * (H - 4)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    return s('svg', { class: `spark ${cls}`, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      s('path', { class: 'spark-area', d: `${line}L0,${H}L${W},${H}Z` }), s('path', { class: 'spark-line', d: line }));
  }

  // Conversion ring; fills to the rate on render.
  function ring(rate) {
    const r = 22, c = 2 * Math.PI * r;
    const arc = s('circle', { class: 'ring-val', cx: 26, cy: 26, r, 'stroke-dasharray': c.toFixed(1), 'stroke-dashoffset': c.toFixed(1) });
    requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', (c * (1 - (rate || 0))).toFixed(1))));
    return s('svg', { class: 'ring', viewBox: '0 0 52 52', 'aria-hidden': 'true' }, s('circle', { class: 'ring-track', cx: 26, cy: 26, r }), arc);
  }

  // new | in progress split, for "needs attention".
  function split(a, b) {
    const total = a + b;
    if (!total) return null;
    const i1 = h('i', { class: 'split-new' }), i2 = h('i', { class: 'split-prog' });
    requestAnimationFrame(() => { i1.style.flexGrow = String(a); i2.style.flexGrow = String(b); });
    return h('div', { class: 'split', 'aria-hidden': 'true' }, i1, i2);
  }

  // KPI tiles are a list, so a future "Revenue won" / "Deal value" tile is one more entry.
  function kpiStrip(d) {
    const sm = d.summary, vs = VS[d.range.key], conv = sm.conversion, pts = d.trend.points;
    const tiles = [
      { label: 'לידים חדשים', tone: 'gold', value: sm.leads.value, viz: spark(pts.map((p) => p.leads), 'gold'),
        sub: [delta(sm.leads.change), sm.leads.change != null ? ` ${vs}` : `${sm.leads.prev} בתקופה הקודמת`] },
      { label: 'דורשים טיפול', value: sm.open_now.value, tone: sm.open_now.waiting_24h > 0 ? 'alert' : 'warm',
        viz: split(sm.open_now.new, sm.open_now.in_progress),
        sub: `${sm.open_now.new} לטיפול · ${sm.open_now.in_progress} בטיפול` },
      { label: 'נסגרו', tone: 'won', value: sm.won.value, viz: spark(pts.map((p) => p.won), 'won'),
        sub: [delta(sm.won.change), sm.won.change != null ? ` ${vs}` : `מהלידים שנכנסו בתקופה`] },
      { label: 'המרה', tone: 'dark', value: conv.rate, fmt: (x) => Math.round(x * 100), suffix: '%',
        viz: conv.rate == null ? null : ring(conv.rate), side: true,
        sub: conv.rate == null ? 'אין עדיין לידים בתקופה'
          : [`${conv.num} מתוך ${conv.den}`, conv.delta != null ? h('br') : null, delta(conv.delta, { points: true }), conv.delta != null ? ` ${vs}` : null] },
    ];
    return h('div', { class: 'kpis' }, tiles.map((t) => {
      const val = h('b', { class: 'kpi-value' + (t.value == null ? ' is-empty' : '') }, '–', t.suffix && t.value != null ? h('small', null, t.suffix) : null);
      if (t.value != null) countTo(val, t.fmt ? t.fmt(t.value) : t.value, (x) => String(Math.round(x)));
      return h('div', { class: 'kpi' + (t.side ? ' has-side' : ''), 'data-tone': t.tone },
        h('span', { class: 'kpi-label' }, t.label),
        t.side ? h('div', { class: 'kpi-row' }, val, t.viz) : val,
        !t.side && t.viz,
        h('span', { class: 'kpi-sub' }, t.sub));
    }));
  }

  // ── Compact lead rows (home): avatar · who · why · actions ──

  const AVATAR_TONES = ['gold', 'olive', 'sage', 'slate', 'brick', 'ochre'];
  function avatar(l, tone) {
    const parts = String(l.name || '?').trim().split(/\s+/);
    const initials = (parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
    let hash = 0;
    for (const ch of String(l.id || l.name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return h('span', { class: `avatar av-${tone || AVATAR_TONES[hash % AVATAR_TONES.length]}`, 'aria-hidden': 'true' }, initials);
  }

  function leadRow(l, { kind, line } = {}) {
    const wa = waHref(l), tel = telHref(l);
    return h('li', { class: 'lrow' + (l.seen_at ? '' : ' is-unread'), 'data-kind': kind || null },
      h('a', { class: 'lrow-main', href: `#/lead/${l.id}` },
        avatar(l, kind ? { waiting: 'brick', hot: 'brick', repeat: 'ochre', date_soon: 'slate' }[kind] : null),
        h('span', { class: 'lrow-text' },
          h('span', { class: 'lrow-top' }, h('b', null, l.name), prioMark(l)),
          h('span', { class: 'lrow-line' }, line || [typeLabel(l), whenText(l)].filter(Boolean).join(' · ')),
          h('span', { class: 'lrow-when' }, rel(l.last_submission_at)))),
      h('span', { class: 'lrow-actions' },
        wa && h('a', { class: 'act wa', href: wa, target: '_blank', rel: 'noopener', 'aria-label': `WhatsApp ל${l.name}` }, icon('wa')),
        tel && h('a', { class: 'act call', href: tel, 'aria-label': `התקשרות ל${l.name}` }, icon('call'))));
  }

  function attentionBlock(items) {
    if (!items.length) return emptyState('הכול מטופל', 'אין כרגע לידים שדורשים תשומת לב.');
    return h('ul', { class: 'lrows panel' }, items.map((l) => {
      const kind = l.priority.reasons[0];
      const why = {
        waiting: `ממתין ${rel(l.created_at).replace('לפני ', '')}`,
        hot: 'ליד חם',
        repeat: `פנה ${l.submission_count} פעמים`,
        date_soon: untilText(l.priority.days_to_event) ? `התאריך ${untilText(l.priority.days_to_event)}` : 'תאריך קרוב',
      }[kind];
      return leadRow(l, { kind, line: [h('span', { class: 'why' }, why), ` · ${typeLabel(l)}`] });
    }));
  }

  function insightsBlock(items, limit) {
    if (!items.length) return emptyState('עדיין אין מספיק נתונים לתובנה', 'התובנות יופיעו כאן ככל שיצטברו לידים.');
    return h('ul', { class: 'insights' }, items.slice(0, limit).map((i) => h('li', { class: 'insight', 'data-tone': i.tone },
      h('span', { class: 'insight-icon', 'aria-hidden': 'true' }, i.icon),
      h('div', null, h('h3', null, i.title), h('p', null, i.text)))));
  }

  // One column per day / week: all leads, with the won part in sage. Columns
  // read honestly at low volume, where a line would zigzag between 0 and 1.
  function trendChart(trend) {
    const pts = trend.points;
    const total = pts.reduce((n, p) => n + p.leads, 0);
    if (!total) return emptyState('אין עדיין לידים בתקופה', 'הגרף יתמלא עם הלידים הראשונים.');
    const narrow = window.innerWidth < 700;
    const W = narrow ? 360 : 640, H = narrow ? 170 : 210, top = 8, bottom = 22, axisW = 22;
    const max = Math.max(2, ...pts.map((p) => p.leads));
    const step = max <= 4 ? 1 : max <= 10 ? 2 : Math.ceil(max / 4);
    const top_ = Math.ceil(max / step) * step;
    const plotW = W - axisW, slot = plotW / pts.length, colW = Math.max(2, Math.min(slot * 0.62, 26));
    // RTL: time runs right → left, like the rest of the page; the scale sits on the left.
    const cx = (i) => W - (i + 0.5) * slot;
    const y = (v) => top + (H - top - bottom) * (1 - v / top_);

    const grid = [];
    for (let v = 0; v <= top_; v += step) {
      grid.push(s('line', { class: 'grid', x1: axisW, x2: W, y1: y(v), y2: y(v) }),
        s('text', { class: 'axis', x: 0, y: y(v) + 4, 'text-anchor': 'start' }, String(v)));
    }
    const cols = pts.map((p, i) => s('g', { class: 'col', 'data-i': i },
      p.leads ? s('rect', { class: 'col-all', x: cx(i) - colW / 2, y: y(p.leads), width: colW, height: y(0) - y(p.leads), rx: Math.min(3, colW / 3) }) : null,
      p.won ? s('rect', { class: 'col-won', x: cx(i) - colW / 2, y: y(p.won), width: colW, height: y(0) - y(p.won), rx: Math.min(3, colW / 3) }) : null));
    // Columns grow in from the oldest day (CSSOM styles are allowed by the CSP).
    cols.forEach((g, i) => { g.style.animationDelay = `${Math.min(i * 14, 420)}ms`; });
    const labelIdx = [...new Set([0, Math.floor((pts.length - 1) / 2), pts.length - 1])];
    const labels = labelIdx.map((i) => s('text', { class: 'axis', x: cx(i), y: H - 4, 'text-anchor': 'middle' }, fmtShort(pts[i].start)));
    const hi = s('rect', { class: 'col-hi', y: top, height: y(0) - top, width: slot, visibility: 'hidden' });
    const won = pts.reduce((n, p) => n + p.won, 0);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `לידים לאורך זמן: ${total} לידים, ${won} נסגרו` },
      hi, grid, cols, labels);

    const unit = trend.bucket === 'week' ? 'שבוע מ-' : '';
    const readout = h('div', { class: 'chart-read' });
    const legend = () => readout.replaceChildren(h('span', { class: 'key' }, `${total} לידים`), h('span', { class: 'key won' }, `${won} נסגרו`),
      h('span', null, trend.bucket === 'week' ? 'לפי שבוע' : 'לפי יום'));
    legend();
    function show(evt) {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.floor((W - px) / slot)));
      const p = pts[i];
      hi.setAttribute('x', cx(i) - slot / 2); hi.setAttribute('visibility', 'visible');
      readout.replaceChildren(h('span', null, unit + fmtShort(p.start)), h('span', null, h('b', null, p.leads), ' לידים'), h('span', null, h('b', null, p.won), ' נסגרו'));
    }
    function hide() { hi.setAttribute('visibility', 'hidden'); legend(); }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
    return h('div', { class: 'chart panel' }, readout, svg);
  }

  function bar(ratio, cls = '') {
    const i = h('i');
    requestAnimationFrame(() => { i.style.width = `${Math.max(0, Math.min(1, ratio || 0)) * 100}%`; });
    return h('div', { class: `bar ${cls}`, 'aria-hidden': 'true' }, i);
  }

  function pipelineBlock(p) {
    if (!p.entered) return emptyState('אין עדיין לידים בתקופה', 'המשפך יופיע כשייכנסו לידים.');
    const stage = (label, n, cls, note) => h('div', null,
      h('div', { class: 'stage-top' }, h('span', null, label), h('span', null, note && `${note} · `, h('b', null, n))),
      bar(n / p.entered, cls));
    return h('div', { class: 'funnel panel' },
      stage('נכנסו', p.entered, 'entered'),
      stage('טופלו', p.handled, '', pct(p.handled / p.entered)),
      stage('נסגרו', p.won, 'won', pct(p.won / p.entered)),
      stage('לא נסגרו', p.lost, 'lost', pct(p.lost / p.entered)),
      p.open ? stage('עדיין פתוחים', p.open, 'open', pct(p.open / p.entered)) : null);
  }

  // Judith AI: conversations → lead → won. All counts and rates come from the server.
  function judithBlock(j) {
    if (!j) return emptyState('אין עדיין שיחות עם יהודית בתקופה', 'כשמבקרים ידברו עם יהודית באתר, המשפך שלה יופיע כאן.');
    const top = Math.max(j.conversations, j.leads, 1);
    const stage = (label, n, cls, r) => h('div', null,
      h('div', { class: 'stage-top' }, h('span', null, label), h('span', null, r && r.rate != null && `${pct(r.rate)} · `, h('b', null, n))),
      bar(n / top, cls));
    return h('div', null,
      h('div', { class: 'funnel panel' },
        stage('שיחות', j.conversations, 'entered'),
        stage('לקוחות רלוונטיים', j.qualified, '', j.qualified_rate),
        stage('הוצעה השארת פרטים', j.handoff_shown, '', j.handoff_rate),
        stage('עברו לטופס', j.handoff_clicked, '', j.click_rate),
        stage('לידים', j.leads, '', j.lead_rate),
        stage('נסגרו', j.won, 'won', j.won_rate)),
      h('div', { class: 'metrics' },
        h('div', { class: 'metric' }, h('b', null, j.lead_rate.rate == null ? '—' : pct(j.lead_rate.rate)), h('span', null, 'שיחה → ליד')),
        h('div', { class: 'metric' }, h('b', null, j.won_rate.rate == null ? '—' : pct(j.won_rate.rate)), h('span', null, 'ליד → סגירה')),
        h('div', { class: 'metric' }, h('b', null, j.whatsapp_shown ?? 0), h('span', null, 'הופנו לוואטסאפ'))));
  }

  // ── Claude API card (inside the Judith block) ──
  // Loaded on its own, so a slow or failing Anthropic never holds up the
  // dashboard. The server caches what it gets from Anthropic; there is no API
  // for the real credit balance, so only an estimate is ever shown.
  const CLAUDE_STALE_MS = 5 * 60000;
  const CLAUDE_STATE = {
    active: ['פעיל', 'ok'], idle: ['מוגדר · עדיין אין שיחות', ''], off: ['כבוי', ''],
    no_credit: ['הקרדיט נגמר', 'bad'], auth_error: ['מפתח API לא תקין', 'bad'], error: ['שגיאה בקריאה האחרונה', 'warn'],
  };
  const CREDIT_LEVEL = {
    ok: ['🟢 תקין', 'ok'], low: ['🟠 קרדיט נמוך', 'warn'],
    critical: ['🔴 קרדיט כמעט נגמר', 'bad'], empty: ['🔴 יהודית עלולה להיות לא זמינה', 'bad'],
  };
  const usd = (x) => (x > 0 && x < 0.01 ? '<$0.01' : `${x < 0 ? '−' : ''}$${Math.abs(x).toFixed(2)}`);
  function agoText(ts) {
    const m = Math.floor((Date.now() - Date.parse(ts)) / 60000);
    return m < 1 ? 'עכשיו' : m < 60 ? `לפני ${m} דק׳` : `לפני ${Math.floor(m / 60)} שע׳`;
  }

  function loadClaude({ refresh = false } = {}) {
    if (state.claudeLoading) return;
    if (!refresh && state.claude && Date.now() - state.claudeAt < CLAUDE_STALE_MS) return;
    state.claudeLoading = true;
    paintClaude();
    api(`/api/judith/usage${refresh ? '?refresh=1' : ''}`)
      .then((d) => { state.claude = d; state.claudeAt = Date.now(); state.claudeError = false; })
      .catch((err) => { if (err.status !== 401) state.claudeError = true; })
      .finally(() => { state.claudeLoading = false; paintClaude(); });
  }
  function paintClaude() { document.querySelectorAll('.claude').forEach((el) => el.replaceWith(claudeCard())); }

  function claudeCard() {
    const c = state.claude;
    const row = (label, value, tone) => h('div', { class: 'claude-row' }, h('span', null, label), h('b', { class: tone ? `is-${tone}` : null }, value));
    const head = h('div', { class: 'claude-head' }, h('h3', null, 'Claude API'),
      h('button', { type: 'button', class: 'link-btn', disabled: state.claudeLoading, onclick: () => loadClaude({ refresh: true }) },
        state.claudeLoading ? 'מרענן…' : 'רענון'));
    if (!c) {
      return h('div', { class: 'claude panel' }, head, state.claudeError
        ? h('p', { class: 'claude-na' }, 'נתוני Claude אינם זמינים כרגע')
        : h('div', { class: 'sk sk-line' }));
    }
    const [stateText, stateTone] = CLAUDE_STATE[c.status.state] || [c.status.state, ''];
    const u = c.usage, b = c.budget;
    const notes = [];
    if (state.claudeError) notes.push('הרענון האחרון נכשל — מוצגים הנתונים הקודמים.');
    if (u.stale) notes.push('Anthropic לא זמין כרגע — מוצגים הנתונים האחרונים שהתקבלו.');
    if (u.anthropic_error) notes.push('Anthropic לא זמין כרגע — הנתונים לפי ספירת יהודית.');
    notes.push(u.source === 'anthropic'
      ? 'עלויות לפי Cost API של Anthropic (כל הארגון).'
      : 'עלויות לפי הטוקנים ש-Anthropic מדווח על כל שיחה של יהודית, לפי המחירון הרשמי.');
    if (u.unpriced_calls) notes.push(`${u.unpriced_calls} קריאות במודל ללא מחיר ידוע אינן כלולות בסכום.`);
    if (b) notes.push(`היתרה המשוערת היא ${usd(b.budget_usd)} שהוגדרו, פחות השימוש מאז ${fmtDate(b.since)}. קרדיט שנוסף ידנית ב-Console לא נכלל.`);
    else notes.push('יתרת קרדיט אינה זמינה דרך ה-API של Anthropic.');
    const [levelText, levelTone] = b ? CREDIT_LEVEL[b.level] : [];
    return h('div', { class: 'claude panel' }, head,
      row('סטטוס', stateText, stateTone),
      b && row('יתרה משוערת', usd(b.remaining_usd), levelTone),
      b && h('p', { class: `claude-alert is-${levelTone}` }, levelText),
      row('שימוש החודש', usd(u.month_usd)),
      row('היום', usd(u.today_usd)),
      row('קריאות API החודש', u.calls_month),
      row('קריאות API היום', u.calls_today),
      row('עודכן', h('span', { class: 'claude-time', 'data-ts': c.updated_at }, agoText(c.updated_at))),
      h('p', { class: 'claude-note' }, notes.join(' ')));
  }
  setInterval(() => document.querySelectorAll('.claude-time').forEach((el) => { el.textContent = agoText(el.dataset.ts); }), 20000);

  function breakdownBlock(rows, nameOf, emptyText) {
    if (!rows.length) return emptyState('אין עדיין נתונים', emptyText);
    return h('div', { class: 'rows panel' }, rows.map((r) => h('div', { class: 'row' },
      h('div', { class: 'row-top' }, h('span', { class: 'row-name' }, nameOf(r)), h('span', { class: 'row-share' }, pct(r.share.rate))),
      bar(r.share.rate),
      h('div', { class: 'row-stats' },
        h('span', null, h('b', null, r.leads), ' לידים'),
        h('span', null, h('b', null, r.won), ' נסגרו'),
        h('span', null, 'המרה ', h('b', null, pct(r.conversion.rate)))))));
  }

  function hoursText(hrs) {
    if (hrs < 1) return `${Math.max(1, Math.round(hrs * 60))} דק׳`;
    if (hrs < 48) return `${(Math.round(hrs * 10) / 10)} שע׳`;
    return `${Math.round(hrs / 24)} ימים`;
  }

  // Secondary metrics; a metric without enough data is simply not shown.
  function metricsBlock(d) {
    const items = [
      ['לידים HOT פתוחים', d.summary.hot_open],
      ['לידים חוזרים בתקופה', d.summary.repeat_leads],
      ['לא נסגרו', d.pipeline.lost],
      ['פתוחים מהתקופה', d.pipeline.open],
    ];
    if (d.timing.first_action.samples >= 3) items.push(['עד טיפול ראשון (חציון)', hoursText(d.timing.first_action.median_hours)]);
    if (d.timing.close.samples >= 3) items.push(['עד סגירה (חציון)', hoursText(d.timing.close.median_days * 24)]);
    return h('div', { class: 'metrics' }, items.map(([label, v]) => h('div', { class: 'metric' }, h('b', null, v), h('span', null, label))));
  }

  function block(area, title, body, more) {
    return h('section', { class: 'block', 'data-area': area },
      title && h('div', { class: 'block-head' }, h('h2', null, title), more), body);
  }

  // ══════════════════ Home ══════════════════

  function greeting() {
    const hr = new Date().getHours();
    return hr >= 5 && hr < 12 ? 'בוקר טוב' : hr >= 12 && hr < 17 ? 'צהריים טובים' : hr >= 17 && hr < 22 ? 'ערב טוב' : 'לילה טוב';
  }

  function homeSkeleton() {
    return h('div', { class: 'home-grid' },
      h('section', { class: 'greet is-plain', 'data-area': 'greet' }, h('div', { class: 'sk sk-title' }), h('div', { class: 'sk sk-line' })),
      block('attention', 'דורש תשומת לב', h('div', { class: 'attention' }, h('div', { class: 'sk sk-card' }), h('div', { class: 'sk sk-card' }))),
      block('period', null, h('div', { class: 'kpis' }, [1, 2, 3, 4].map(() => h('div', { class: 'sk sk-kpi' })))),
      block('trend', null, h('div', { class: 'sk sk-chart' })));
  }

  function renderHome() {
    const view = $('#homeView');
    const d = state.dash;
    if (!d) {
      if (state.dashError) return view.replaceChildren(h('div', { class: 'greet is-plain' }, h('h1', null, greeting())), h('div', { class: 'block' }, errorState('בדקו את החיבור ונסו שוב.', () => loadDash({ force: true }))));
      return view.replaceChildren(homeSkeleton());
    }
    const urgent = d.summary.open_now.waiting_24h > 0;
    const inAttention = new Set(d.attention.map((l) => l.id));
    const newLeads = d.recent.filter((l) => !inAttention.has(l.id)).slice(0, 4);
    const first = state.homeKey !== state.dashKey;   // entrance plays once per period, not on every refresh
    state.homeKey = state.dashKey;
    view.replaceChildren(h('div', { class: 'home-grid' + (first ? ' is-entering' : '') },
      h('section', { class: 'greet', 'data-area': 'greet' },
        liveTag(),
        h('h1', null, greeting()),
        h('p', { class: urgent ? 'is-urgent' : '' }, d.headline),
        h('div', { class: 'greet-stats' },
          h('a', { href: '#/leads', class: d.summary.open_now.new ? 'is-hot' : '', onclick: () => presetFilter('status:new') },
            h('b', null, d.summary.open_now.new), ' לטיפול'),
          h('a', { href: '#/leads', onclick: () => presetFilter('status:in_progress') }, h('b', null, d.summary.open_now.in_progress), ' בטיפול'),
          d.summary.hot_open > 0 && h('a', { href: '#/leads', class: 'is-gold', onclick: () => presetFilter('flag:hot') },
            h('b', null, d.summary.hot_open), ' HOT'),
          h('a', { href: '#/new', class: 'is-add' }, '+ ליד חדש'))),
      block('attention', 'עכשיו', attentionBlock(d.attention)),
      block('period', 'ביצועים', h('div', null, rangeControl(), kpiStrip(d))),
      block('trend', 'לידים לאורך זמן', trendChart(d.trend)),
      block('insights', 'תובנות', insightsBlock(d.insights, 3), h('a', { class: 'more', href: '#/insights' }, 'הכול')),
      block('recent', 'נכנסו לאחרונה',
        newLeads.length ? h('ul', { class: 'lrows panel' }, newLeads.map((l) => leadRow(l)))
          : emptyState('אין לידים נוספים', d.attention.length ? 'כל הלידים האחרונים מופיעים למעלה.' : 'לידים חדשים יופיעו כאן.'),
        h('a', { class: 'more', href: '#/leads' }, 'כל הלידים')),
      block('pipeline', 'המשפך', pipelineBlock(d.pipeline)),
      block('sources', 'מקורות', breakdownBlock(d.sources, (r) => sourceLabel(r.source), 'אין לידים בתקופה.'))));
  }

  // "LIVE · עודכן לפני 2 דק׳" — ticks without refetching.
  function liveTag() {
    return h('span', { class: 'live' }, h('i', { 'aria-hidden': 'true' }), 'LIVE', h('span', { class: 'live-time' }, liveText()));
  }
  function liveText() {
    if (!state.dashAt) return '';
    const m = Math.floor((Date.now() - state.dashAt) / 60000);
    return m < 1 ? ' · עודכן עכשיו' : ` · עודכן לפני ${m} דק׳`;
  }
  setInterval(() => document.querySelectorAll('.live-time').forEach((el) => { el.textContent = liveText(); }), 20000);

  // ══════════════════ Insights ══════════════════

  function renderInsights() {
    const view = $('#insightsView');
    const d = state.dash;
    const head = [h('div', { class: 'view-head' }, h('h1', { class: 'view-title' }, 'תובנות'), d && liveTag()), rangeControl()];
    if (!d) {
      if (state.dashError) return view.replaceChildren(...head, h('div', { class: 'block' }, errorState('בדקו את החיבור ונסו שוב.', () => loadDash({ force: true }))));
      return view.replaceChildren(...head, h('div', { class: 'kpis' }, [1, 2, 3, 4].map(() => h('div', { class: 'sk sk-kpi' }))),
        h('div', { class: 'block' }, h('div', { class: 'sk sk-chart' })));
    }
    view.replaceChildren(...head, kpiStrip(d),
      h('div', { class: 'insights-grid' },
        h('section', { class: 'block wide' }, h('div', { class: 'block-head' }, h('h2', null, 'מה חשוב עכשיו')), insightsBlock(d.insights, 5)),
        block('trend', 'לידים לאורך זמן', trendChart(d.trend)),
        block('pipeline', 'המשפך', pipelineBlock(d.pipeline)),
        block('sources', 'מאיפה מגיעים הלידים?', breakdownBlock(d.sources, (r) => sourceLabel(r.source), 'אין לידים בתקופה.')),
        block('services', 'מה הלקוחות מחפשים?', breakdownBlock(d.services, (r) => TYPE[r.lead_type] || r.lead_type, 'אין לידים בתקופה.')),
        block('judith', 'יהודית AI', h('div', { class: 'judith-stack' }, judithBlock(d.judith), claudeCard())),
        h('section', { class: 'block wide' }, h('div', { class: 'block-head' }, h('h2', null, 'מדדים נוספים'),
          h('span', { class: 'block-note' }, 'המרה = נסגרו ÷ לידים שנכנסו בתקופה')), metricsBlock(d))));
    loadClaude();
  }

  // ══════════════════ Lead list ══════════════════

  function prioMark(l) {
    return l.priority ? h('span', { class: `prio prio-${l.priority.level}` }, PRIO[l.priority.level]) : null;
  }

  function statusButton(l, onChange) {
    return h('button', { type: 'button', class: 'status-btn', 'data-status': l.status, 'aria-haspopup': 'dialog',
      'aria-label': `סטטוס: ${STATUS[l.status]}. שינוי סטטוס`,
      onclick: (e) => { e.preventDefault(); statusSheet(l, onChange); } }, STATUS[l.status] || l.status);
  }

  function leadCard(l) {
    const wa = waHref(l), tel = telHref(l);
    const li = h('li', { class: l.seen_at ? 'card' : 'card is-unread' });
    const render = () => li.replaceChildren(
      h('a', { class: 'card-main', href: `#/lead/${l.id}` },
        h('div', { class: 'card-top' },
          avatar(l),
          h('h3', { class: 'card-name' }, !l.seen_at && h('span', { class: 'sr-only' }, 'לא נקרא: '), l.name),
          prioMark(l)),
        h('p', { class: 'card-what' }, [typeLabel(l), whenText(l)].filter(Boolean).join(' · ')),
        h('p', { class: 'card-when' },
          h('span', null, `פנייה ${rel(l.last_submission_at)}`),
          l.event_date && l.timing && h('span', { class: 'tag tag-timing', 'data-timing': l.timing }, URGENCY[l.timing]),
          l.source === 'judith_ai' && h('span', { class: 'tag tag-judith' }, SOURCE.judith_ai),
          l.submission_count > 1 && h('span', { class: 'tag' }, `פנייה חוזרת ×${l.submission_count}`))),
      h('div', { class: 'card-foot' },
        statusButton(l, (next) => { Object.assign(l, next); render(); }),
        h('span', { class: 'spacer' }),
        h('a', { class: 'act wa' + (wa ? '' : ' is-disabled'), href: wa || undefined, target: '_blank', rel: 'noopener', 'aria-label': `WhatsApp ל${l.name}` }, icon('wa')),
        h('a', { class: 'act call' + (tel ? '' : ' is-disabled'), href: tel || undefined, 'aria-label': `התקשרות ל${l.name}` }, icon('call')),
        h('a', { class: 'act', href: `#/lead/${l.id}` }, 'פתח')));
    render();
    return li;
  }

  function listQuery(more) {
    const p = new URLSearchParams();
    const [kind, value] = state.filter.split(':');
    if (kind === 'status') p.set('status', value);
    if (kind === 'flag') p.set('flag', value);
    if (state.source) p.set('source', state.source);
    if (state.q) p.set('q', state.q);
    if (more && state.cursor) p.set('cursor', state.cursor);
    return p;
  }

  const LIST_EMPTY = {
    '': ['אין עדיין לידים', 'לידים מהאתר ומדף הליד יופיעו כאן ברגע שייכנסו.'],
    'status:new': ['הכול מטופל', 'אין לידים חדשים שמחכים לטיפול.'],
    'flag:hot': ['אין כרגע לידים דחופים', 'לידי HOT פתוחים יופיעו כאן.'],
    'flag:repeat': ['אין פניות חוזרות', 'לקוחות שפנו יותר מפעם אחת יופיעו כאן.'],
    'status:in_progress': ['אין לידים בטיפול', null],
    'status:won': ['עדיין אין לידים שנסגרו', null],
    'status:lost': ['אין לידים שלא נסגרו', null],
  };

  async function loadList({ more = false } = {}) {
    const seq = ++state.listSeq;
    const list = $('#leadList');
    if (!more && !state.leads.length) list.replaceChildren(...[1, 2, 3, 4].map(() => h('li', { class: 'sk sk-card' })));
    $('#listEmpty').hidden = true;
    $('#loadMore').disabled = true;
    try {
      const data = await api(`/api/leads?${listQuery(more)}`);
      if (seq !== state.listSeq) return; // a newer request superseded this one
      state.leads = more ? state.leads.concat(data.leads) : data.leads;
      state.cursor = data.next_cursor;
      state.listStale = false;
      if (data.counts) applyCounts(data.counts);
      list.replaceChildren(...state.leads.map(leadCard));
      if (!state.leads.length) {
        const [t, x] = state.q || state.source ? ['לא נמצאו לידים', 'נסו חיפוש או סינון אחר.'] : LIST_EMPTY[state.filter] || LIST_EMPTY[''];
        $('#listEmpty').replaceChildren(...[h('h3', null, t), x && h('p', null, x)].filter(Boolean));
        $('#listEmpty').hidden = false;
      }
      $('#loadMore').hidden = !state.cursor;
    } catch (err) {
      if (seq !== state.listSeq || err.status === 401) return;
      if (!state.leads.length) {
        list.replaceChildren();
        $('#listEmpty').replaceChildren(errorState(err.status ? 'השרת לא החזיר את הלידים.' : 'אין חיבור לאינטרנט.', () => loadList()));
        $('#listEmpty').hidden = false;
      } else toast('הרענון נכשל');
    } finally {
      $('#loadMore').disabled = false;
    }
  }

  // A shortcut from the home card straight into a filtered list.
  function presetFilter(f) {
    state.filter = f; state.q = ''; state.source = ''; state.leads = []; state.listStale = true;
    $('#search').value = '';
  }

  function syncChips() {
    document.querySelectorAll('#quickChips .chip').forEach((c) => {
      const on = c.dataset.filter === state.filter;
      c.classList.toggle('is-active', on);
      c.setAttribute('aria-pressed', String(on));
    });
    $('#sourceFilter').value = state.source;
  }

  // ══════════════════ Status changes ══════════════════

  function statusSheet(l, onChange) {
    openSheet(`סטטוס · ${l.name}`, h('div', { class: 'sheet-options' },
      Object.entries(STATUS).map(([key, label]) => h('button', { type: 'button', 'data-status': key,
        'aria-current': String(key === l.status),
        onclick: () => { closeSheet(); changeStatus(l, key, onChange); } }, label))));
  }

  /** Optimistic: the UI moves first, and moves back if the server says no.
   *  Closing a deal then asks what was closed (onDeal gets the saved lead). */
  async function changeStatus(l, status, onChange, onDeal) {
    if (l.status === status) return;
    const before = { status: l.status, priority: l.priority };
    onChange({ status, priority: status === 'won' || status === 'lost' ? null : l.priority });
    try {
      const { lead } = await api(`/api/leads/${l.id}`, { method: 'PATCH', body: { status } });
      onChange({ status: lead.status, priority: lead.priority, closed_at: lead.closed_at });
      if (lead.status === 'won') {
        toast('✓ הליד נסגר בהצלחה', { success: true });
        dealSheet(l, onDeal || ((saved) => onChange({ deal: saved.deal })));
      } else toast(`הסטטוס עודכן: ${STATUS[lead.status]}`);
      state.dash = null; state.dashKey = null; // numbers changed
      state.listStale = true;
      refreshCounts();
    } catch (err) {
      onChange(before);
      if (err.status !== 401) toast(err.status === 404 ? 'הליד כבר לא קיים' : err.status ? 'השמירה נכשלה — הסטטוס לא השתנה' : 'אין חיבור — הסטטוס לא נשמר');
    }
  }

  function refreshCounts() {
    api('/api/leads?limit=1').then((d) => applyCounts(d.counts)).catch(() => {});
  }

  // ══════════════════ פרטי הסגירה (what a closed lead booked) ══════════════════

  const DEAL_ERRORS = { deposit: 'המקדמה גבוהה מהמחיר', event_date: 'תאריך לא תקין', start_time: 'שעה לא תקינה', end_time: 'שעה לא תקינה' };

  /** The deal form, in the bottom sheet. Prefilled from the saved deal, or from what the lead asked for. */
  function dealSheet(l, onSaved) {
    const d = l.deal || { lead_type: l.lead_type, event_date: l.event_date, guests: l.companions };
    const err = {};
    const field = (label, control, name, { full } = {}) => {
      err[name] = h('span', { class: 'nf-error', role: 'alert' });
      return h('label', { class: 'nf-field' + (full ? ' is-full' : '') }, h('span', { class: 'nf-label' }, label), control, err[name]);
    };
    const options = (map, selected) => [h('option', { value: '' }, 'לא צוין'),
      ...Object.entries(map).map(([k, v]) => h('option', { value: k, selected: k === selected }, v))];
    const num = (name, max) => h('input', { name, type: 'number', inputmode: 'numeric', min: 0, max, step: 1, dir: 'ltr', value: d[name] ?? '' });

    const pkg = h('input', { name: 'package', maxlength: 300, autocomplete: 'off', value: d.package || '', placeholder: 'לדוגמה: התארגנות כלה + 4 מלוות' });
    const type = h('select', { name: 'lead_type' }, options(Object.fromEntries(Object.entries(TYPE).filter(([k]) => k !== 'unknown')), d.lead_type));
    const guests = num('guests', 50);
    const date = h('input', { name: 'event_date', type: 'date', value: d.event_date ? String(d.event_date).slice(0, 10) : '' });
    const start = h('input', { name: 'start_time', type: 'time', dir: 'ltr', value: d.start_time || '' });
    const end = h('input', { name: 'end_time', type: 'time', dir: 'ltr', value: d.end_time || '' });
    const price = num('price', 1000000), deposit = num('deposit', 1000000);
    const pay = h('select', { name: 'payment_method' }, options(PAYMENT, d.payment_method));
    const notes = h('textarea', { name: 'notes', rows: 3, maxlength: 4000 }, d.notes || '');
    const balance = h('p', { class: 'deal-balance', 'aria-live': 'polite' });
    const showBalance = () => {
      const p = price.value === '' ? null : Number(price.value), dep = deposit.value === '' ? 0 : Number(deposit.value);
      balance.textContent = p == null ? '' : `יתרה לתשלום: ${ils(p - dep)}`;
    };
    price.addEventListener('input', showBalance);
    deposit.addEventListener('input', showBalance);
    showBalance();

    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'שמירת פרטי הסגירה');
    const form = h('form', { class: 'new-form deal-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
      field('מה נסגר', pkg, 'package', { full: true }),
      h('div', { class: 'nf-row' }, field('שירות', type, 'lead_type'), field('משתתפים', guests, 'guests')),
      field('תאריך', date, 'event_date', { full: true }),
      h('div', { class: 'nf-row' }, field('משעה', start, 'start_time'), field('עד שעה', end, 'end_time')),
      h('div', { class: 'nf-row' }, field('מחיר (₪)', price, 'price'), field('מקדמה ששולמה (₪)', deposit, 'deposit')),
      balance,
      field('אמצעי תשלום', pay, 'payment_method', { full: true }),
      field('הערות', notes, 'notes', { full: true }),
      submit,
      h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: closeSheet }, l.deal ? 'ביטול' : 'אמלא אחר כך'));

    async function save() {
      Object.values(err).forEach((el) => { el.textContent = ''; });
      const deal = Object.fromEntries([pkg, type, guests, date, start, end, price, deposit, pay, notes].map((c) => [c.name, c.value]));
      submit.disabled = true;
      try {
        const { lead } = await api(`/api/leads/${l.id}`, { method: 'PATCH', body: { deal } });
        closeSheet();
        toast('✓ פרטי הסגירה נשמרו', { success: true });
        state.listStale = true;
        onSaved(lead);
      } catch (ex) {
        submit.disabled = false;
        if (ex.status === 401) return;
        if (ex.status === 400 && ex.body?.fields) {
          for (const [k, v] of Object.entries(ex.body.fields)) if (err[k]) err[k].textContent = DEAL_ERRORS[k] || (v === 'invalid' ? 'ערך לא תקין' : v);
          return;
        }
        toast(ex.status ? 'השמירה נכשלה, נסו שוב' : 'אין חיבור — הפרטים לא נשמרו');
      }
    }
    openSheet(`פרטי הסגירה · ${l.name}`, form);
  }

  /** The "פרטי הסגירה" section on the lead page: shown once it's closed, or whenever a deal was saved. */
  function dealSection(l, onEdit) {
    if (l.status !== 'won' && !l.deal) return null;
    const d = l.deal;
    const head = h('div', { class: 'section-head' }, h('h2', null, 'פרטי הסגירה'),
      d && h('button', { type: 'button', class: 'link-btn', onclick: onEdit }, 'עריכה'));
    if (!d) {
      return h('section', { class: 'section' }, head, h('div', { class: 'deal-empty' },
        h('p', null, 'עדיין לא נרשם מה נסגר ובכמה.'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: onEdit }, 'הוספת פרטי סגירה')));
    }
    const rows = [
      ['נסגר', d.package],
      ['שירות', d.lead_type && TYPE[d.lead_type]],
      ['תאריך', d.event_date && fmtDate(d.event_date)],
      ['שעות', (d.start_time || d.end_time) && [d.start_time, d.end_time].filter(Boolean).join('–'), 'ltr'],
      ['משתתפים', d.guests != null && String(d.guests)],
      ['מחיר', d.price != null && ils(d.price)],
      ['מקדמה', d.deposit != null && ils(d.deposit)],
      ['יתרה', d.price != null && ils(d.price - (d.deposit || 0)), 'deal-due'],
      ['תשלום', d.payment_method && PAYMENT[d.payment_method]],
    ].filter(([, v]) => v);
    return h('section', { class: 'section' }, head,
      rows.length ? dl(rows) : null,
      d.notes && h('p', { class: 'message deal-notes' }, d.notes),
      l.status !== 'won' && h('p', { class: 'block-note' }, 'הליד כבר לא בסטטוס "נסגר" — הפרטים נשמרו למקרה שייסגר שוב.'));
  }

  // ══════════════════ Lead detail ══════════════════

  function fieldRows(l) {
    return [
      ['שירות', [typeLabel(l), l.lead_subtype].filter(Boolean).join(' · ')],
      ['תאריך', l.event_date && whenText(l)],
      ['דחיפות', URGENCY[l.timing || l.urgency]],
      ['מלוות', l.companions != null && String(l.companions)],
      ['סוג הפקה', l.production_type],
      ['תקציב', l.budget != null && ils(l.budget)],
    ].filter(([, v]) => v);
  }
  const dl = (rows) => h('dl', { class: 'fields' }, rows.flatMap(([k, v, cls]) => [h('dt', null, k), h('dd', { class: cls }, v)]));

  function eventItem(e) {
    let title, extra;
    if (e.type === 'lead_created') {
      title = e.data?.metadata?.entered_by ? `הליד נוסף ידנית · ${sourceLabel(e.data.source)}` : `הליד התקבל · ${sourceLabel(e.data?.source)}`;
    } else if (e.type === 'repeat_submission') {
      title = `פנייה חוזרת · ${sourceLabel(e.data?.source)}`;
      const d = e.data || {};
      extra = [d.lead_type && TYPE[d.lead_type], d.event_date && fmtDate(d.event_date), d.message].filter(Boolean).join('\n');
    } else if (e.type === 'status_changed') {
      title = e.to_status === 'won' ? 'נסגר ✓' : `עבר ל"${STATUS[e.to_status] || e.to_status}"`;
    } else if (e.type === 'deal_updated') {
      title = 'פרטי הסגירה עודכנו';
      const d = e.data || {};
      extra = [d.package, d.price != null && ils(d.price)].filter(Boolean).join(' · ');
    } else {
      title = e.type;
    }
    const d = new Date(e.created_at);
    return h('li', { 'data-type': e.type, 'data-to': e.to_status || null },
      h('time', { class: 'tl-time', datetime: e.created_at, title: fmtFull(e.created_at) }, fmtHm(e.created_at)),
      h('div', { class: 'tl-body' }, title,
        h('span', { class: 'tl-day' }, `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} · ${rel(e.created_at)}`),
        extra && h('span', { class: 'tl-extra' }, extra)));
  }

  function detailSkeleton() {
    return [h('div', { class: 'sk sk-title' }), h('div', { class: 'sk sk-line' }),
      h('div', { class: 'd-actions' }, h('div', { class: 'sk sk-kpi' }), h('div', { class: 'sk sk-kpi' })),
      h('div', { class: 'section' }, h('div', { class: 'sk sk-card' }))];
  }

  async function openLead(id) {
    const view = $('#detailView');
    view.replaceChildren(backBtn(), ...detailSkeleton());
    window.scrollTo(0, 0);
    let l;
    try {
      ({ lead: l } = await api(`/api/leads/${encodeURIComponent(id)}`));
    } catch (err) {
      if (err.status === 401) return;
      view.replaceChildren(backBtn(), err.status === 404
        ? emptyState('הליד לא נמצא', 'ייתכן שהוא נמחק.')
        : errorState(err.status ? 'השרת לא החזיר את הליד.' : 'אין חיבור לאינטרנט.', () => openLead(id)));
      return;
    }
    if (location.hash !== `#/lead/${id}`) return; // navigated away meanwhile
    if (!l.seen_at) {
      api(`/api/leads/${l.id}`, { method: 'PATCH', body: { seen: true } })
        .then((r) => { setBadge(r.unread); state.listStale = true; })
        .catch(() => {});
    }
    renderLead(l);
  }

  function renderLead(l) {
    const view = $('#detailView');
    const wa = waHref(l), tel = telHref(l);
    const picker = h('div', { class: 'status-picker', role: 'group', 'aria-label': 'סטטוס' },
      Object.entries(STATUS).map(([key, label]) => h('button', {
        type: 'button', 'data-status': key, 'aria-pressed': String(key === l.status),
        onclick: () => changeStatus(l, key, (next) => {
          Object.assign(l, next);
          picker.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === l.status)));
          marks.replaceChildren(...markList().filter(Boolean));
          dealSlot.replaceChildren(dealSection(l, editDeal) || '');
          if (next.status === 'won') picker.querySelector('[data-status="won"]').classList.add('pulse');
        }, dealSaved),
      }, label)));
    // After a save, reload so the timeline shows it too; if that fails, show what the save returned.
    function dealSaved(saved) {
      api(`/api/leads/${l.id}`).then(({ lead }) => lead).catch(() => ({ ...l, ...saved, events: l.events }))
        .then((lead) => { if (location.hash === `#/lead/${l.id}`) renderLead(lead); });
    }
    const editDeal = () => dealSheet(l, dealSaved);
    const dealSlot = h('div', null, dealSection(l, editDeal));
    const markList = () => [prioMark(l),
      l.lead_score && h('span', { class: 'block-note nowrap' }, `Lead Score: ${SCORE[l.lead_score]}`),
      l.submission_count > 1 && h('span', { class: 'tag' }, `פנייה חוזרת ×${l.submission_count}`)];
    const marks = h('div', { class: 'd-marks' }, markList());

    const contact = [['טלפון', l.phone, 'ltr']];
    if (l.email) contact.push(['אימייל', h('a', { href: `mailto:${l.email}` }, l.email), 'ltr']);
    contact.push(['מקור', sourceLabel(l.source)], ['התקבל', fmtFull(l.created_at)]);
    if (l.closed_at) contact.push(['נסגר', fmtFull(l.closed_at)]);

    const fields = fieldRows(l);
    // Two columns on desktop (the request | contact and history); one stack on phones, in the same order.
    const main = [
      h('div', { class: 'd-head' }, h('div', null,
        h('h1', null, l.name),
        h('p', { class: 'd-phone ltr' }, l.phone))),
      marks,
      (wa || tel) && h('div', { class: 'd-actions' },
        wa && h('a', { class: 'btn btn-wa', href: wa, target: '_blank', rel: 'noopener' }, icon('wa'), 'WhatsApp'),
        tel && h('a', { class: 'btn btn-primary', href: tel }, icon('call'), 'התקשר')),
      picker,
      dealSlot,
      l.possible_duplicate_of && h('p', { class: 'section block-note' }, 'ייתכן שזה לקוח קיים · ',
        h('button', { type: 'button', class: 'link-btn', onclick: () => { location.hash = `#/lead/${l.possible_duplicate_of}`; } }, 'לליד הקודם')),
      fields.length && h('section', { class: 'section' }, h('h2', null, 'הפנייה'), dl(fields)),
      l.metadata?.judith_summary && h('section', { class: 'section' }, h('h2', null, 'סיכום השיחה עם יהודית'), h('p', { class: 'message' }, l.metadata.judith_summary)),
      l.message && h('section', { class: 'section' }, h('h2', null, 'הודעה'), h('p', { class: 'message' }, l.message)),
    ];
    const side = [
      h('section', { class: 'section' }, h('h2', null, 'פרטים'), dl(contact)),
      h('section', { class: 'section' }, h('h2', null, 'פעילות'),
        h('ul', { class: 'timeline' }, [...(l.events || [])].reverse().map(eventItem))),
      h('button', { type: 'button', class: 'btn btn-danger btn-block d-danger', onclick: (e) => deleteLead(l, e.currentTarget) }, 'מחיקת ליד'),
    ];
    view.replaceChildren(backBtn(), h('div', { class: 'd-grid' },
      h('div', { class: 'd-main' }, main.filter(Boolean)),
      h('div', { class: 'd-side' }, side)));
  }

  async function deleteLead(l, btn) {
    if (!window.confirm(`למחוק את הליד של ${l.name}?\nהמחיקה סופית, כולל ההיסטוריה, ואי אפשר לשחזר.`)) return;
    btn.disabled = true;
    try {
      const r = await api(`/api/leads/${l.id}`, { method: 'DELETE' });
      setBadge(r.unread);
      state.leads = []; state.listStale = true; state.dash = null; state.dashKey = null;
      toast('הליד נמחק');
      location.hash = '#/leads';
    } catch (err) {
      btn.disabled = false;
      if (err.status === 404) { toast('הליד כבר נמחק'); location.hash = '#/leads'; }
      else if (err.status !== 401) toast(err.status ? 'המחיקה נכשלה, נסו שוב' : 'אין חיבור — הליד לא נמחק');
    }
  }

  const backBtn = () => h('button', { type: 'button', class: 'back', onclick: () => {
    if (history.length > 1 && state.cameFrom) history.back(); else location.hash = '#/leads';
  } }, '→ חזרה');

  // ══════════════════ New lead (typed in by hand) ══════════════════

  const FIELD_ERRORS = { name: 'נא להזין שם', phone: 'נא להזין מספר טלפון תקין', source: 'נא לבחור מקור' };

  function renderNew() {
    const view = $('#newView');
    const submissionId = crypto.randomUUID();   // a double tap or a retry never adds the lead twice
    const today = new Date().toLocaleDateString('en-CA');
    const err = {};
    const field = (label, control, { name, hint, full } = {}) => {
      if (name) err[name] = h('span', { class: 'nf-error', role: 'alert' });
      return h('label', { class: 'nf-field' + (full ? ' is-full' : '') }, h('span', { class: 'nf-label' }, label), control, hint && h('span', { class: 'nf-hint' }, hint), name && err[name]);
    };
    const options = (map, empty) => [empty != null && h('option', { value: '' }, empty), ...Object.entries(map).map(([k, v]) => h('option', { value: k }, v))];

    const name = h('input', { name: 'name', required: true, maxlength: 120, autocomplete: 'off', enterkeyhint: 'next' });
    const phone = h('input', { name: 'phone', type: 'tel', inputmode: 'tel', dir: 'ltr', required: true, maxlength: 40, autocomplete: 'off', placeholder: '050-000-0000' });
    const source = h('select', { name: 'source', required: true }, options(MANUAL_SOURCE));
    const type = h('select', { name: 'lead_type' }, options(Object.fromEntries(Object.entries(TYPE).filter(([k]) => k !== 'unknown')), 'לא צוין'));
    const date = h('input', { name: 'event_date', type: 'date', min: today });
    const budget = h('input', { name: 'budget', type: 'number', inputmode: 'numeric', min: 0, max: 1000000, step: 1, dir: 'ltr' });
    const email = h('input', { name: 'email', type: 'email', dir: 'ltr', maxlength: 254, autocomplete: 'off' });
    const message = h('textarea', { name: 'message', rows: 4, maxlength: 4000 });
    let status = 'new';
    const picker = h('div', { class: 'status-picker', role: 'group', 'aria-label': 'סטטוס התחלתי' },
      Object.entries(STATUS).map(([key, label]) => h('button', { type: 'button', 'data-status': key, 'aria-pressed': String(key === status),
        onclick: () => { status = key; picker.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === status))); } }, label)));
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'שמירת הליד');

    const form = h('form', { class: 'new-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); save(); } },
      field('שם *', name, { name: 'name' }),
      field('טלפון *', phone, { name: 'phone' }),
      field('מאיפה הגיע הליד? *', source, { name: 'source' }),
      field('אימייל', email, { name: 'email' }),
      h('div', { class: 'nf-row' }, field('שירות', type), field('תקציב (₪)', budget)),
      field('תאריך האירוע', date, { hint: 'הדחיפות נקבעת לפי התאריך: השבוע, החודש, 3 חודשים או מעבר לזה', full: true }),
      field('הערות', message, { hint: 'מה הלקוח ביקש, מתי לחזור אליו וכו׳', full: true }),
      h('div', { class: 'nf-field is-full' }, h('span', { class: 'nf-label' }, 'סטטוס'), picker),
      submit);
    submit.classList.add('is-full');

    async function save() {
      Object.values(err).forEach((el) => { el.textContent = ''; });
      const body = {
        submission_id: submissionId, source: source.value, name: name.value, phone: phone.value, email: email.value,
        lead_type: type.value, event_date: date.value, budget: budget.value, message: message.value, status,
      };
      const local = {};
      if (name.value.trim().length < 2) local.name = 'required';
      if (phone.value.replace(/\D/g, '').length < 7) local.phone = 'required';
      if (email.value.trim() && !email.checkValidity()) local.email = 'invalid';
      if (Object.keys(local).length) return showErrors(local);
      submit.disabled = true;
      try {
        const r = await api('/api/leads/manual', { method: 'POST', body });
        state.leads = []; state.listStale = true; refreshDashLater(); refreshCounts();
        if (r.result === 'repeat') toast(`כבר יש ליד פתוח למספר הזה — הפרטים נוספו אליו (פנייה ×${r.submission_count})`);
        else toast('✓ הליד נוסף', { success: true });
        location.replace(`#/lead/${r.lead_id}`);
      } catch (ex) {
        submit.disabled = false;
        if (ex.status === 401) return;
        if (ex.status === 400 && ex.body?.fields) return showErrors(ex.body.fields);
        toast(ex.status ? 'השמירה נכשלה, נסו שוב' : 'אין חיבור — הליד לא נשמר');
      }
    }
    function showErrors(fields) {
      for (const [k, v] of Object.entries(fields)) if (err[k]) err[k].textContent = k === 'email' ? 'כתובת אימייל לא תקינה' : FIELD_ERRORS[k] || v;
      const first = form.querySelector('.nf-error:not(:empty)');
      if (first) first.closest('.nf-field').querySelector('input, select').focus();
      else toast('השמירה נכשלה, בדקו את הפרטים');
    }

    view.replaceChildren(backBtn(), h('h1', { class: 'view-title' }, 'ליד חדש'),
      h('p', { class: 'nf-intro' }, 'ליד שהגיע בטלפון, באינסטגרם, בהמלצה וכו׳. אם כבר יש ליד פתוח עם אותו מספר, הפרטים יתווספו אליו.'), form);
    window.scrollTo(0, 0);
    name.focus({ preventScroll: true });
  }

  // ══════════════════ Routing ══════════════════

  function currentRoute() {
    const m = location.hash.match(/^#\/lead\/([0-9a-f-]{36})$/i);
    if (m) return { view: 'detailView', id: m[1], tab: 'leads' };
    if (location.hash === '#/leads') return { view: 'leadsView', tab: 'leads' };
    if (location.hash === '#/insights') return { view: 'insightsView', tab: 'insights' };
    if (location.hash === '#/new') return { view: 'newView', tab: 'leads' };
    return { view: 'homeView', tab: 'home' };
  }

  let lastView = null;
  function route() {
    if (!state.authed) return;
    const r = currentRoute();
    state.cameFrom = lastView && lastView !== 'detailView';
    VIEWS.forEach((v) => { $('#' + v).hidden = v !== r.view; });
    document.querySelectorAll('.tabbar a').forEach((a) => {
      if (a.dataset.tab === r.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (r.view !== lastView && r.view !== 'detailView' && lastView !== 'detailView') window.scrollTo(0, 0);
    lastView = r.view;
    if (r.view === 'detailView') return openLead(r.id);
    if (r.view === 'newView') return renderNew();
    if (r.view === 'leadsView') { syncChips(); if (state.listStale || !state.leads.length) loadList(); return; }
    loadDash();
  }

  /** Refresh whatever is on screen (pull to refresh, push arrival, back to the app). */
  function refreshCurrent() {
    const r = currentRoute();
    if (r.view === 'detailView') return openLead(r.id);
    if (r.view === 'newView') return;   // never wipe a half-filled form
    state.listStale = true;
    if (r.view === 'leadsView') { refreshDashLater(); return loadList(); }
    return loadDash({ force: true });
  }
  function refreshDashLater() { state.dash = null; state.dashKey = null; }

  // ══════════════════ Menu ══════════════════

  function closeMenu() { $('#menu').hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); }
  function toggleMenu() {
    const open = $('#menu').hidden;
    $('#menu').hidden = !open;
    $('#menuBtn').setAttribute('aria-expanded', String(open));
    if (open) { refreshPushUi(); $('#menu button:not([hidden])').focus({ preventScroll: true }); }
  }

  // ══════════════════ Push (feature-detected; the CRM works without it) ══════════════════

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  function b64ToBytes(b64) {
    const str = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(str, (c) => c.charCodeAt(0));
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
    $('#menuInstall').hidden = !state.installPrompt || isStandalone();
    return sub;
  }

  async function enablePush() {
    closeMenu();
    if (!pushSupported()) {
      if (isIos && !isStandalone()) {
        return infoSheet('התראות באייפון ובאייפד', 'באייפון ובאייפד, התראות עובדות רק מהאפליקציה שעל מסך הבית. בספארי: כפתור השיתוף ← "הוספה למסך הבית", ואז פותחים את LeadLive מהמסך הראשי ומפעילים התראות משם.');
      }
      return infoSheet('התראות', 'הדפדפן הזה לא תומך בהתראות. אפשר להמשיך לעבוד כרגיל, או לנסות מ-Chrome, Edge או Safari מעודכן.');
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
      return infoSheet('ההתראות חסומות', 'כדי לקבל התראות צריך לאשר אותן. אפשר לשנות את זה בהגדרות הדפדפן או המכשיר עבור האתר.');
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.vapidKey) });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
      toast('התראות הופעלו ✓', { success: true });
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

  // ══════════════════ Pull to refresh (touch only, at the top of the page) ══════════════════

  function setupPullToRefresh() {
    const ptr = $('#ptr');
    let startY = null, pull = 0, busy = false;
    const reset = () => { ptr.style.transition = 'transform .25s, opacity .25s'; ptr.style.opacity = '0'; ptr.style.transform = 'translateY(-40px)'; };
    document.addEventListener('touchstart', (e) => {
      if (busy || window.scrollY > 0 || !$('#sheet').hidden || e.touches.length !== 1 || $('#app').hidden) { startY = null; return; }
      startY = e.touches[0].clientY; pull = 0; ptr.style.transition = 'none';
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      pull = Math.max(0, e.touches[0].clientY - startY);
      if (window.scrollY > 0) { startY = null; return reset(); }
      const p = Math.min(pull, 110);
      ptr.style.opacity = String(Math.min(1, p / 70));
      ptr.style.transform = `translateY(${p * 0.6 - 40}px) rotate(${p * 3}deg)`;
    }, { passive: true });
    document.addEventListener('touchend', async () => {
      if (startY == null) return;
      startY = null;
      if (pull < 80) return reset();
      busy = true;
      ptr.classList.add('is-loading');
      try { await refreshCurrent(); } finally { busy = false; ptr.classList.remove('is-loading'); reset(); }
    });
  }

  // ══════════════════ Boot ══════════════════

  async function boot() {
    let sess;
    try {
      sess = await api('/api/auth/session', { allow401: true });
    } catch {
      // Offline at launch: show the shell with the banner; retry when back online.
      $('#login').hidden = true;
      $('#app').hidden = false;
      return;
    }
    if (!sess.authenticated) return showLogin();
    state.authed = true;
    state.vapidKey = sess.vapid_public_key;
    $('#login').hidden = true;
    $('#app').hidden = false;
    route();
    refreshPushUi();
    resyncPush();
    if (currentRoute().view !== 'leadsView') refreshCounts();
  }

  function init() {
    $('#loginForm').addEventListener('submit', onLogin);
    $('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#sheet').hidden) closeSheet(); else closeMenu();
    });
    $('#menuLogout').addEventListener('click', logout);
    $('#menuNew').addEventListener('click', () => { closeMenu(); location.hash = '#/new'; });
    $('#menuRefresh').addEventListener('click', () => { closeMenu(); refreshCurrent(); });
    $('#menuPush').addEventListener('click', enablePush);
    $('#menuInstall').addEventListener('click', async () => {
      closeMenu();
      const p = state.installPrompt;
      if (!p) return;
      state.installPrompt = null;
      p.prompt();
      await p.userChoice.catch(() => {});
      refreshPushUi();
    });
    // Chrome / Edge / Android only; elsewhere the item simply never appears.
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; refreshPushUi(); });
    window.addEventListener('appinstalled', () => { state.installPrompt = null; refreshPushUi(); });

    $('#pushPrompt').addEventListener('click', (e) => {
      if (e.target.closest('[data-dismiss]')) {
        try { localStorage.setItem('casa-leads-push-dismissed', '1'); } catch {}
        $('#pushPrompt').hidden = true;
        return;
      }
      enablePush();
    });
    $('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

    $('#quickChips').addEventListener('click', (e) => {
      const c = e.target.closest('.chip'); if (!c) return;
      state.filter = c.dataset.filter; state.leads = []; syncChips(); loadList();
    });
    $('#sourceFilter').addEventListener('change', (e) => { state.source = e.target.value; state.leads = []; loadList(); });
    let searchTimer;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = e.target.value.trim(); state.leads = []; loadList(); }, 300);
    });
    $('#loadMore').addEventListener('click', () => loadList({ more: true }));

    window.addEventListener('hashchange', route);
    window.addEventListener('online', () => { setOffline(false); state.authed ? refreshCurrent() : boot(); });
    window.addEventListener('offline', () => setOffline(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.authed && !['detailView', 'newView'].includes(currentRoute().view)) refreshCurrent();
    });
    if (!navigator.onLine) setOffline(true);
    setupPullToRefresh();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/leadlive/sw.js', { scope: '/leadlive' }).catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'open' && e.data.url) {
          const hash = new URL(e.data.url, location.origin).hash;
          if (hash) location.hash = hash;
        } else if (e.data?.type === 'lead' && state.authed && !['detailView', 'newView'].includes(currentRoute().view)) {
          refreshCurrent();
        }
      });
    }
    boot();
  }

  init();
})();
