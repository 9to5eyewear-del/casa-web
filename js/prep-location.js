// "מיקום ההתארגנות" — asked only for bridal prep (index.html and /lead).
// One quick-search field over every city, town, moshav and kibbutz. Picking
// one shows the estimated drive from the studio in Ein Vered and its service
// zone (js/service-areas.js). Beyond the recommended zone (> 75 minutes) a
// notice offers a special check; the bride goes on with "כן, אשמח לבדוק
// אפשרות", and the lead is flagged to check availability and pricing.
//
// Mounts into every [data-prep-location] element and puts the API on it:
//   el.prepLocation.validate() → true when the step may continue (shows errors)
//   el.prepLocation.value()    → { prep_location, drive_minutes, service_zone, out_of_area }
//   el.prepLocation.summary()  → one line for the email / WhatsApp text
// data-input-class: the page's class for text inputs.

import { ORIGIN, ZONES, checkLocation, minutesText, needsCheck, prepLocationText, suggest } from './service-areas.js';

const NOTICE = 'המיקום שבחרת נמצא מחוץ לאזורי השירות המומלצים שלנו. נשמח לבדוק עבורך אפשרות מיוחדת, בהתאם לזמינות ולתמחור.';
const CONFIRM = 'כן, אשמח לבדוק אפשרות';
const CONFIRMED = '✓ מעולה, נבדוק עבורך אפשרות מיוחדת ונחזור אלייך.';

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

  const input = h('input', {
    id: `${id}-place`, type: 'search', enterkeyhint: 'search', class: inputClass, autocomplete: 'off', placeholder: 'חיפוש עיר או יישוב…',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`,
    'aria-describedby': `${id}-hint ${id}-e-place`, maxlength: 120,
  });
  const list = h('ul', { id: `${id}-list`, class: 'pl-list', role: 'listbox', 'aria-label': 'יישובים', hidden: true });
  const hint = h('p', { id: `${id}-hint`, class: 'field-hint pl-hint' });
  const placeErr = h('p', { id: `${id}-e-place`, class: 'pl-error', 'aria-live': 'polite' });
  const placeField = h('div', null,
    h('label', { for: input.id, class: 'field-label' }, 'מיקום ההתארגנות *'),
    h('div', { class: 'pl-combo' }, input, list), hint, placeErr);

  const noticeText = h('p', { tabindex: '-1' });
  const confirmBtn = h('button', { type: 'button' }, CONFIRM);
  const noticeTitle = h('strong');
  const notice = h('div', { class: 'pl-notice', role: 'status', hidden: true }, noticeTitle, noticeText, confirmBtn);

  root.classList.add('pl');
  root.replaceChildren(placeField, notice);

  // zone / minutes: of the picked locality; out: beyond the recommended zone; confirmed: she asked to check anyway.
  const st = { minutes: null, zone: null, out: false, confirmed: false, checked: '' };
  const reset = () => Object.assign(st, { minutes: null, zone: null, out: false, confirmed: false });
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
    const TAG = { special: 'מחוץ לאזור המומלץ', remote: 'מיקום מרוחק' };
    list.replaceChildren(...names.map((n, i) => h('li',
      { id: `${id}-opt${i}`, role: 'option', 'aria-selected': 'false', 'data-name': n.name, class: needsCheck(n.zone) ? 'is-far' : null },
      h('span', null, n.name),
      h('span', { class: 'pl-meta' }, minutesText(n.minutes), TAG[n.zone] && h('span', { class: 'pl-tag' }, TAG[n.zone])))));
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
    noticeTitle.textContent = `⚠️ ${ZONES[st.zone]?.label || ''}`;
    noticeText.textContent = st.confirmed ? CONFIRMED : NOTICE;
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
      Object.assign(st, { minutes: r.minutes, zone: r.zone, out: needsCheck(r.zone) });
      // "✓ נתניה · כ-20 דקות נסיעה מעין ורד · אזור שירות מומלץ"
      if (r.place) {
        const time = minutesText(r.minutes);
        hint.textContent = [`${st.out ? '' : '✓ '}${r.place.name}`, time && `${time} נסיעה מ${ORIGIN}`, !st.out && ZONES.recommended.label]
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
        setErr(placeErr, input, 'נא לבחור עיר או יישוב');
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
      const loc = input.value.trim() || null;
      return { prep_location: loc, drive_minutes: loc ? st.minutes : null, service_zone: loc ? st.zone : null, out_of_area: st.out && st.confirmed };
    },
    summary() {
      const v = this.value();
      if (!v.prep_location) return '';
      return `מיקום ההתארגנות: ${prepLocationText(v)}${v.out_of_area ? ' · לבדוק זמינות ותמחור' : ''}`;
    },
  };
  root.dispatchEvent(new CustomEvent('prep-location:ready', { bubbles: true }));
}

const style = document.createElement('style');
style.textContent = CSS;
document.head.append(style);
document.querySelectorAll('[data-prep-location]').forEach(mount);
