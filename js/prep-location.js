// "מיקום ההתארגנות" — asked only for bridal prep (index.html and /lead).
// One quick-search field over every city, town, moshav and kibbutz. Picking
// one shows the estimated drive from the studio in Ein Vered and its service
// zone (js/service-areas.js). Beyond the recommended zone (> 75 minutes) a
// notice explains it, with a small map of the zone around Ein Vered and her
// location (js/service-map.data.js), and invites her to the studio instead;
// she goes on with "כן, אשמח לבדוק אפשרות", and the lead is flagged to check
// availability and pricing.
//
// Mounts into every [data-prep-location] element and puts the API on it:
//   el.prepLocation.validate() → true when the step may continue (shows errors)
//   el.prepLocation.value()    → { prep_location, drive_minutes, service_zone, out_of_area }
//   el.prepLocation.summary()  → one line for the email / WhatsApp text
// data-input-class: the page's class for text inputs.
//
// It speaks the site's language itself (js/i18n.js → CasaI18n.lang, the
// 'casa:lang' event), English place names included; the lead always stores
// the Hebrew name. Its root is data-no-i18n, so the page dictionary keeps out.

import { ORIGIN, ZONES, checkLocation, minutesText, needsCheck, prepLocationText, suggest } from './service-areas.js';
import { LAND, ORIGIN_XY, VIEW, XY, ZONE } from './service-map.data.js';

const TEXT = {
  he: {
    label: 'אזור החתונה *',
    placeholder: 'חיפוש עיר או יישוב…',
    list: 'יישובים',
    required: 'נא לבחור עיר או יישוב',
    origin: ORIGIN,
    drive: (time) => `${time} נסיעה מ${ORIGIN}`,
    tags: { special: 'מחוץ לאזור המומלץ', remote: 'מיקום מרוחק' },
    noticeTitle: 'המיקום שבחרת מחוץ לאזורי השירות המומלצים שלנו',
    notice: [
      `נשמח מאוד לארח אותך אצלנו ב${ORIGIN} — אם זה מתאים לך.`,
      'המיקום שבחרת אינו מהווה מגבלה, אך אנו ממליצים לבחור באזור קרוב יותר לנוחות ביום ההתארגנות.',
    ],
    confirm: 'כן, אשמח לבדוק אפשרות',
    confirmed: '✓ תודה שעדיין בחרת בנו! בואי נמשיך בתהליך.',
    mapLabel: (place) => `מפה: אזור השירות המומלץ סביב ${ORIGIN}${place ? `, ו${place} מחוץ לו` : ''}`,
    mapZone: 'אזור שירות מומלץ',
    mapStudio: `הסטודיו ב${ORIGIN}`,
  },
  en: {
    label: 'Wedding area *',
    placeholder: 'Search for a city or town…',
    list: 'Places',
    required: 'Please choose a city or town',
    origin: 'Ein Vered',
    drive: (time) => `${time} drive from Ein Vered`,
    tags: { special: 'Outside recommended area', remote: 'Remote location' },
    noticeTitle: 'The location you chose is outside our recommended service areas',
    notice: [
      "We'd love to host you here in Ein Vered — if that works for you.",
      "Your location isn't a limitation, but for an easier getting-ready day we recommend choosing somewhere closer.",
    ],
    confirm: "Yes, I'd like to check",
    confirmed: "✓ Thank you for still choosing us! Let's continue.",
    mapLabel: (place) => `Map: the recommended service area around Ein Vered${place ? `, and ${place} outside it` : ''}`,
    mapZone: 'Recommended service area',
    mapStudio: 'The studio in Ein Vered',
  },
};
const lang = () => (window.CasaI18n && window.CasaI18n.lang === 'en' ? 'en' : 'he');
const T = () => TEXT[lang()];
// A place as she sees it: its English name on the English site.
const shown = (p) => (lang() === 'en' ? p.en || p.name : p.name);

const CSS = `
.pl-combo { position: relative; }
/* Search icon on the start side (right, in RTL). */
.pl-combo input {
  padding-right: 2.1rem !important;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23857f70' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-3.5-3.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right .6rem center;
}
.pl-list {
  position: absolute; inset-inline: 0; top: calc(100% + 4px); z-index: 30; margin: 0; padding: .3rem 0;
  list-style: none; max-height: 16rem; overflow-y: auto; background: #fff;
  border: 1px solid rgba(98,94,81,0.22); border-radius: 4px; box-shadow: 0 8px 28px rgba(47,52,48,0.14);
}
.pl-list li { padding: .65rem 1rem; font-size: .95rem; color: #2f3430; cursor: pointer; }
.pl-list li[aria-selected="true"], .pl-list li:hover { background: rgba(201,169,110,0.14); }
.pl-list li { display: flex; justify-content: space-between; align-items: center; gap: .5rem; }
.pl-list li.is-far { color: #78716c; }
.pl-meta { flex-shrink: 0; display: flex; align-items: center; gap: .4rem; font-size: .75rem; color: #857f70; }
.pl-tag { padding: .1rem .5rem; border-radius: 99px; font-size: .72rem; font-weight: 600; background: rgba(158,66,44,0.1); color: #9e422c; }
.pl-notice strong { display: block; margin-bottom: .25rem; font-size: .95rem; }
.pl-error { color: #9e422c; font-size: .8rem; margin-top: .35rem; }
.pl-error:empty, .pl-hint:empty { display: none; }
.pl-hint.is-ok { color: #2d6a4f; }
.pl-notice {
  margin-top: .9rem; padding: 1rem 1.1rem; border-radius: 4px; line-height: 1.6; font-size: .9rem;
  background: rgba(158,66,44,0.06); border: 1px solid rgba(158,66,44,0.28); color: #5c2a1d;
}
.pl-notice.is-confirmed { background: rgba(45,106,79,0.07); border-color: rgba(45,106,79,0.3); color: #234f3b; }
.pl-notice p { margin: 0; outline: none; }
.pl-notice p + p { margin-top: .4rem; }
.pl-notice-body { display: flex; gap: 1rem; align-items: flex-start; }
.pl-notice-text { flex: 1; min-width: 0; }
.pl-map { flex-shrink: 0; width: 7.5rem; margin: 0; }
.pl-map svg { display: block; width: 100%; height: auto; max-height: 13rem; }
.pl-map figcaption { margin-top: .4rem; font-size: .7rem; line-height: 1.45; color: #625e51; }
.pl-map figcaption span { display: flex; align-items: center; gap: .3rem; }
.pl-map figcaption i { flex-shrink: 0; width: .6rem; height: .6rem; border-radius: 50%; }
@media (max-width: 380px) { .pl-map { width: 6.25rem; } }
.pl-notice button {
  display: block; width: 100%; margin-top: .8rem; min-height: 48px; padding: .6rem 1rem; border: 0; border-radius: 4px;
  background: #433f33; color: #fef7e6; font: inherit; font-weight: 600; cursor: pointer;
}
.pl-notice button:hover { background: #625e51; }
.pl-notice button:focus-visible { outline: 2px solid #c9a96e; outline-offset: 3px; }
`;

let uid = 0;
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  el.append(...kids.filter((k) => k != null && k !== false));
  return el;
};

function mount(root) {
  const id = `pl${++uid}`;
  const inputClass = root.dataset.inputClass || null;
  root.setAttribute('data-no-i18n', '');

  const input = h('input', {
    id: `${id}-place`, type: 'search', enterkeyhint: 'search', class: inputClass, autocomplete: 'off',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`,
    'aria-describedby': `${id}-hint ${id}-e-place`, maxlength: 120,
  });
  const list = h('ul', { id: `${id}-list`, class: 'pl-list', role: 'listbox', hidden: true });
  const hint = h('p', { id: `${id}-hint`, class: 'field-hint pl-hint' });
  const placeErr = h('p', { id: `${id}-e-place`, class: 'pl-error', 'aria-live': 'polite' });
  const label = h('label', { for: input.id, class: 'field-label' });
  const placeField = h('div', null, label, h('div', { class: 'pl-combo' }, input, list), hint, placeErr);

  const noticeText = h('div', { class: 'pl-notice-text', tabindex: '-1' });
  const map = h('figure', { class: 'pl-map' });
  const confirmBtn = h('button', { type: 'button' });
  const noticeTitle = h('strong');
  const notice = h('div', { class: 'pl-notice', role: 'status', hidden: true },
    noticeTitle, h('div', { class: 'pl-notice-body' }, noticeText, map), confirmBtn);

  root.classList.add('pl');
  root.replaceChildren(placeField, notice);

  // place: the picked locality; zone / minutes: its zone and drive time; out: beyond the recommended zone; confirmed: she asked to check anyway.
  const st = { place: null, minutes: null, zone: null, out: false, confirmed: false, checked: '' };
  const reset = () => Object.assign(st, { place: null, minutes: null, zone: null, out: false, confirmed: false });
  let active = -1;

  const setErr = (el, field, msg) => {
    el.textContent = msg;
    field.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };

  function closeList() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function renderList() {
    const names = suggest(input.value);
    // Every locality is offered, with its drive time; beyond the recommended zone it's tagged.
    const tags = T().tags;
    list.replaceChildren(...names.map((n, i) => h('li',
      { id: `${id}-opt${i}`, role: 'option', 'aria-selected': 'false', 'data-name': shown(n), class: needsCheck(n.zone) ? 'is-far' : null },
      h('span', null, shown(n)),
      h('span', { class: 'pl-meta' }, minutesText(n.minutes, lang()), tags[n.zone] && h('span', { class: 'pl-tag' }, tags[n.zone])))));
    active = -1;
    if (!names.length || document.activeElement !== input) return closeList();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function highlight(i) {
    const items = [...list.children];
    if (!items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((li, j) => li.setAttribute('aria-selected', String(j === active)));
    input.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  }

  function pick(name) {
    input.value = name;
    closeList();
    check();
  }

  function showNotice() {
    notice.hidden = !st.out;
    notice.classList.toggle('is-confirmed', st.confirmed);
    noticeTitle.hidden = st.confirmed;
    noticeTitle.textContent = `⚠️ ${T().noticeTitle}`;
    confirmBtn.textContent = T().confirm;
    noticeText.replaceChildren(...(st.confirmed ? [T().confirmed] : T().notice).map((t) => h('p', null, t)));
    map.hidden = st.confirmed || !st.out;
    if (!map.hidden) map.replaceChildren(...serviceMap(st.place));
    confirmBtn.hidden = st.confirmed;
  }

  // Where the typed location stands; runs on pick, blur and "המשך".
  function check() {
    const text = input.value.trim();
    if (st.checked === text) return;
    st.checked = text;
    reset();
    hint.textContent = '';
    hint.classList.remove('is-ok');
    if (text) {
      setErr(placeErr, input, '');
      const r = checkLocation(text);
      Object.assign(st, { place: r.place, minutes: r.minutes, zone: r.zone, out: needsCheck(r.zone) });
      // "✓ נתניה · כ-20 דקות נסיעה מעין ורד · אזור שירות מומלץ"
      if (r.place) {
        const time = minutesText(r.minutes, lang());
        const ok = lang() === 'en' ? ZONES.recommended.en : ZONES.recommended.label;
        hint.textContent = [`${st.out ? '' : '✓ '}${shown(r.place)}`, time && T().drive(time), !st.out && ok]
          .filter(Boolean).join(' · ');
        hint.classList.toggle('is-ok', !st.out);
      }
    }
    showNotice();
  }

  input.addEventListener('input', () => {
    st.checked = '';
    reset();
    hint.textContent = '';
    showNotice();
    if (input.getAttribute('aria-invalid') === 'true' && input.value.trim()) setErr(placeErr, input, '');
    renderList();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && active >= 0) {
      // Picks the option; the page's own Enter (next step) waits for the next press.
      e.preventDefault();
      e.stopPropagation();
      pick(list.children[active].dataset.name);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeList();
    }
  });
  // mousedown, so the pick lands before the input's blur closes the list.
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    e.preventDefault();
    pick(li.dataset.name);
  });
  input.addEventListener('blur', () => {
    closeList();
    if (input.value.trim()) check();
  });
  confirmBtn.addEventListener('click', () => {
    st.confirmed = true;
    showNotice();
    noticeText.focus(); // the button is gone; keep focus in the notice
  });

  root.prepLocation = {
    validate() {
      if (!input.value.trim()) {
        setErr(placeErr, input, T().required);
        input.focus();
        return false;
      }
      check();
      if (st.out && !st.confirmed) {
        confirmBtn.focus();
        return false;
      }
      return true;
    },
    value() {
      check();
      // The Hebrew name of a known locality (what the team reads), else what she typed.
      const loc = st.place ? st.place.name : input.value.trim() || null;
      return { prep_location: loc, drive_minutes: loc ? st.minutes : null, service_zone: loc ? st.zone : null, out_of_area: st.out && st.confirmed };
    },
    summary() {
      const v = this.value();
      if (!v.prep_location) return '';
      return `אזור החתונה: ${prepLocationText(v)}${v.out_of_area ? ' · לבדוק זמינות ותמחור' : ''}`;
    },
  };
  // The fixed texts, in the site's language; on a switch, a picked place takes its name in the new one.
  function renderTexts() {
    label.textContent = T().label;
    input.placeholder = T().placeholder;
    list.setAttribute('aria-label', T().list);
    if (placeErr.textContent) placeErr.textContent = T().required;
    if (st.place) input.value = shown(st.place);
    st.checked = '';
    if (input.value.trim()) check(); else showNotice();
    if (!list.hidden) renderList();
  }
  renderTexts();
  window.addEventListener('casa:lang', renderTexts);
  root.dispatchEvent(new CustomEvent('prep-location:ready', { bubbles: true }));
}

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
let mapUid = 0;

// The recommended zone around the studio, and her locality on it. The view
// frames the zone and the pin, so a far place zooms out and a near one stays big.
function serviceMap(place) {
  const pin = place && XY[place.name];
  const id = `plmap${++mapUid}`;
  // Bounding box of the zone path's points, plus the pin.
  const nums = ZONE.match(/-?\d+(\.\d+)?/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  if (pin) xs.push(pin[0]), ys.push(pin[1] - 10); // the pin stands above its point
  const pad = 12;
  let x0 = Math.max(0, Math.min(...xs) - pad), x1 = Math.min(VIEW[0], Math.max(...xs) + pad);
  const y0 = Math.max(0, Math.min(...ys) - pad), y1 = Math.min(VIEW[1], Math.max(...ys) + pad);
  // Never narrower than 3/5 of its height, so the coast still reads as a coast.
  const minW = (y1 - y0) * 0.6;
  if (x1 - x0 < minW) {
    const grow = (minW - (x1 - x0)) / 2;
    x0 = Math.max(0, x0 - grow);
    x1 = Math.min(VIEW[0], x1 + grow);
  }
  const k = (y1 - y0) / 100; // marks keep their size at any zoom
  const el = svg('svg', { viewBox: `${x0} ${y0} ${x1 - x0} ${y1 - y0}`, role: 'img',
    'aria-label': T().mapLabel(pin ? shown(place) : null) });
  // A mask, not a clipPath, so its stroke closes the seams between the land's parts.
  const mask = svg('mask', { id, maskUnits: 'userSpaceOnUse', x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  mask.append(svg('path', { d: LAND, fill: '#fff', stroke: '#fff', 'stroke-width': 1.2 * k, 'stroke-linejoin': 'round' }));
  el.append(
    mask,
    svg('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 3 * k, fill: '#e6eef0' }), // the sea
    svg('path', { d: LAND, fill: '#ece6d8', stroke: '#ece6d8', 'stroke-width': 1.2 * k, 'stroke-linejoin': 'round' }),
    svg('path', { d: ZONE, 'fill-rule': 'evenodd', fill: 'rgba(45,106,79,0.28)', stroke: '#2d6a4f', 'stroke-width': 0.9 * k, 'stroke-dasharray': `${2.5 * k} ${1.5 * k}`, mask: `url(#${id})` }),
    svg('circle', { cx: ORIGIN_XY[0], cy: ORIGIN_XY[1], r: 3 * k, fill: '#433f33', stroke: '#fff', 'stroke-width': k }),
  );
  if (pin) {
    // A map pin whose tip sits on the place.
    const [x, y] = pin, r = 3.6 * k;
    el.append(svg('path', {
      d: `M${x} ${y}c${-r * 0.4} ${-r * 1.2} ${-r} ${-r * 1.5} ${-r} ${-r * 2.4}a${r} ${r} 0 1 1 ${2 * r} 0c0 ${r * 0.9} ${-r * 0.6} ${r * 1.2} ${-r} ${r * 2.4}z`,
      fill: '#9e422c', stroke: '#fff', 'stroke-width': 0.8 * k,
    }));
  }
  const key = (color, text) => h('span', null, h('i', { style: `background:${color}` }), text);
  return [el, h('figcaption', null,
    key('rgba(45,106,79,0.45)', T().mapZone),
    key('#433f33', T().mapStudio),
    pin && key('#9e422c', shown(place)))];
}

const style = document.createElement('style');
style.textContent = CSS;
document.head.append(style);
document.querySelectorAll('[data-prep-location]').forEach(mount);
