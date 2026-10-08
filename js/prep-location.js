// "מיקום ההתארגנות" — asked only for bridal prep (index.html and /lead).
// A region, then a locality with autocomplete limited to that region. A
// locality outside every service region (e.g. אשקלון) shows a notice; the
// bride can still go on by confirming, and the lead is flagged out_of_area.
//
// Mounts into every [data-prep-location] element and puts the API on it:
//   el.prepLocation.validate() → true when the step may continue (shows errors)
//   el.prepLocation.value()    → { prep_region, prep_location, out_of_area }
//   el.prepLocation.summary()  → one line for the email / WhatsApp text
// data-input-class: the page's class for text inputs / selects.

import { REGIONS, REGION_NAMES, checkLocation, isOutOfArea, suggest } from './service-areas.js';

const NOTICE = 'המיקום שבחרת נמצא מחוץ לאזורי השירות הקבועים שלנו. נשמח לבדוק עבורך אפשרות הגעה מיוחדת.';
const CONFIRM = 'בכל זאת, אני רוצה לסגור ולבדוק זמינות';
const CONFIRMED = '✓ מעולה, נבדוק עבורך אפשרות הגעה מיוחדת ונחזור אלייך.';

const CSS = `
.pl-field { margin-top: 1.1rem; }
.pl-field:first-child { margin-top: 0; }
.pl select {
  cursor: pointer; -webkit-appearance: none; appearance: none; padding-left: 2rem;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23625e51' stroke-width='1.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: left .5rem center;
}
.pl-combo { position: relative; }
.pl-list {
  position: absolute; inset-inline: 0; top: calc(100% + 4px); z-index: 30; margin: 0; padding: .3rem 0;
  list-style: none; max-height: 16rem; overflow-y: auto; background: #fff;
  border: 1px solid rgba(98,94,81,0.22); border-radius: 4px; box-shadow: 0 8px 28px rgba(47,52,48,0.14);
}
.pl-list li { padding: .65rem 1rem; font-size: .95rem; color: #2f3430; cursor: pointer; }
.pl-list li[aria-selected="true"], .pl-list li:hover { background: rgba(201,169,110,0.14); }
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
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  el.append(...kids.filter((k) => k != null));
  return el;
};

function mount(root) {
  const id = `pl${++uid}`;
  const inputClass = root.dataset.inputClass || null;
  const touch = window.matchMedia('(hover: none)').matches;

  const region = h('select', { id: `${id}-region`, class: inputClass, 'aria-describedby': `${id}-e-region` },
    h('option', { value: '' }, 'בחרי אזור'),
    ...REGIONS.map((r) => h('option', { value: r.id }, r.label)));
  const regionErr = h('p', { id: `${id}-e-region`, class: 'pl-error', 'aria-live': 'polite' });

  const input = h('input', {
    id: `${id}-place`, type: 'text', class: inputClass, autocomplete: 'off', placeholder: 'התחילי להקליד את שם היישוב',
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-list`,
    'aria-describedby': `${id}-hint ${id}-e-place`, maxlength: 120,
  });
  const list = h('ul', { id: `${id}-list`, class: 'pl-list', role: 'listbox', 'aria-label': 'יישובים', hidden: true });
  const hint = h('p', { id: `${id}-hint`, class: 'field-hint pl-hint' });
  const placeErr = h('p', { id: `${id}-e-place`, class: 'pl-error', 'aria-live': 'polite' });
  const placeField = h('div', { class: 'pl-field', hidden: true },
    h('label', { for: input.id, class: 'field-label' }, 'כתובת או יישוב *'),
    h('div', { class: 'pl-combo' }, input, list), hint, placeErr);

  const noticeText = h('p', { tabindex: '-1' });
  const confirmBtn = h('button', { type: 'button' }, CONFIRM);
  const notice = h('div', { class: 'pl-notice', role: 'status', hidden: true }, noticeText, confirmBtn);

  root.classList.add('pl');
  root.replaceChildren(
    h('div', { class: 'pl-field' }, h('label', { for: region.id, class: 'field-label' }, 'מיקום ההתארגנות *'), region, regionErr),
    placeField, notice);

  // out: the location is outside the service areas; confirmed: she chose to go on anyway.
  const st = { out: false, confirmed: false, checked: '' };
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
    const names = suggest(input.value, region.value);
    list.replaceChildren(...names.map((n, i) => h('li', { id: `${id}-opt${i}`, role: 'option', 'aria-selected': 'false' }, n)));
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
    noticeText.textContent = st.confirmed ? CONFIRMED : NOTICE;
    confirmBtn.hidden = st.confirmed;
  }

  // Where the typed location stands; runs on pick, blur and "המשך".
  function check() {
    const text = input.value.trim();
    if (st.checked === `${region.value}|${text}`) return;
    st.checked = `${region.value}|${text}`;
    st.out = false;
    st.confirmed = false;
    hint.textContent = '';
    hint.classList.remove('is-ok');
    if (text && region.value) {
      setErr(placeErr, input, '');
      const r = checkLocation(text, region.value);
      if (r.status === 'other_region') {
        // A service locality, just in another region: fix the region for her.
        region.value = r.region;
        st.checked = `${region.value}|${text}`;
        hint.textContent = `✓ ${r.place.name} (${REGION_NAMES[r.region]}) · עדכנו עבורך את האזור`;
        hint.classList.add('is-ok');
      } else if (r.status === 'in_region') {
        hint.textContent = `✓ ${r.place.name}`;
        hint.classList.add('is-ok');
      } else {
        st.out = isOutOfArea(r.status);
      }
    }
    showNotice();
  }

  // A new region starts the locality over (re-checking the old text would just switch the region back).
  region.addEventListener('change', () => {
    setErr(regionErr, region, '');
    placeField.hidden = !region.value;
    input.value = '';
    check();
    if (region.value && !touch) input.focus();
  });
  input.addEventListener('input', () => {
    st.checked = '';
    st.out = false;
    st.confirmed = false;
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
      pick(list.children[active].textContent);
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
    pick(li.textContent);
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
      if (!region.value) {
        setErr(regionErr, region, 'נא לבחור את מיקום ההתארגנות');
        region.focus();
        return false;
      }
      if (!input.value.trim()) {
        placeField.hidden = false;
        setErr(placeErr, input, 'נא לכתוב יישוב או כתובת');
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
      return { prep_region: region.value || null, prep_location: input.value.trim() || null, out_of_area: st.out && st.confirmed };
    },
    summary() {
      const v = this.value();
      if (!v.prep_location) return '';
      return `מיקום ההתארגנות: ${v.prep_location} (${REGION_NAMES[v.prep_region] || '—'})${v.out_of_area ? ' · ⚠️ מחוץ לאזור שירות' : ''}`;
    },
  };
  root.dispatchEvent(new CustomEvent('prep-location:ready', { bubbles: true }));
}

const style = document.createElement('style');
style.textContent = CSS;
document.head.append(style);
document.querySelectorAll('[data-prep-location]').forEach(mount);
