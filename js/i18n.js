/* Hebrew ⇄ English for the whole site. Loaded in <head> on every page.
 *
 * The pages are written in Hebrew; js/i18n/en.json maps every Hebrew string
 * (as the browser shows it) to its English, translated with AI by
 * scripts/i18n.mjs. In English this swaps the text in place — page text,
 * placeholders, aria-labels, titles, alt text, the <title> and meta tags —
 * flips the page to LTR, and keeps translating whatever the page's scripts
 * add later (errors, steps, Judith's buttons). Switching back restores the
 * Hebrew exactly, without a reload, so a half-filled form keeps its answers.
 *
 * The choice is remembered (localStorage) and can be set by ?lang=en|he.
 * Language buttons: any [data-lang-toggle] element. Elements with
 * [data-no-i18n] (and everything inside) are never touched.
 *
 *   CasaI18n.lang          'he' | 'en'
 *   CasaI18n.set(lang)
 *   CasaI18n.t(hebrew)     the English in English mode, else the Hebrew
 *   window 'casa:lang'     event after each switch ({ detail: { lang } })
 */
(function () {
  'use strict';

  const STORE = 'casa_lang';
  const DICT_URL = '/js/i18n/en.json';
  const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  const META = 'meta[name="description"], meta[property="og:title"], meta[property="og:description"], meta[property="og:image:alt"], meta[name="twitter:title"], meta[name="twitter:description"]';
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  // Its text is what she typed; only its attributes (placeholder) are ours.
  const SKIP_TEXT = { TEXTAREA: 1 };
  const HEBREW = /[\u0590-\u05FF]/;
  const html = document.documentElement;

  const read = () => { try { return localStorage.getItem(STORE); } catch (_) { return null; } };
  const write = (v) => { try { localStorage.setItem(STORE, v); } catch (_) {} };
  const param = new URLSearchParams(location.search).get('lang');
  let lang = param === 'en' || param === 'he' ? param : read() === 'en' ? 'en' : 'he';
  if (param === 'en' || param === 'he') write(param);

  // Until the English is in, the page stays hidden (never a flash of Hebrew); 2.5s at most.
  const style = document.createElement('style');
  style.textContent = [
    'html.i18n-loading body { visibility: hidden; }',
    // Stylesheets that fix the page to RTL (body { direction: rtl }) follow the language.
    'html[dir="ltr"] body { direction: ltr; }',
    'html[dir="ltr"] [style*="text-align:right"], html[dir="ltr"] [style*="text-align: right"] { text-align: left !important; }',
    // Inline "direction:rtl" boxes (dialogs) follow the page.
    'html[dir="ltr"] [style*="direction:rtl"], html[dir="ltr"] [style*="direction: rtl"] { direction: ltr !important; }',
    'html[dir="ltr"] input, html[dir="ltr"] textarea, html[dir="ltr"] select { direction: ltr; }',
    // Direction-bound icons (Material "arrow_back") point the other way.
    'html[dir="ltr"] .dir-flip { display: inline-block; transform: scaleX(-1); }',
  ].join('\n');
  document.head.appendChild(style);
  setDir(lang);
  if (lang === 'en') {
    html.classList.add('i18n-loading');
    setTimeout(() => html.classList.remove('i18n-loading'), 2500);
  }

  function setDir(l) {
    html.lang = l;
    html.dir = l === 'en' ? 'ltr' : 'rtl';
  }

  // ── Dictionary ──
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  let EN = null, HE = null, EN_PATS = [], HE_PATS = [];
  let dictPromise = null;

  function patterns(dict) {
    return Object.keys(dict).filter((k) => /\{\d+\}/.test(k)).map((k) => {
      const order = [];
      const src = k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{(\d+)\\?\}/g, (_, n) => { order.push(+n); return '(.+?)'; });
      return { re: new RegExp(`^${src}$`), order, out: dict[k], len: k.replace(/\{\d+\}/g, '').length };
    }).sort((a, b) => b.len - a.len);
  }

  function loadDict() {
    dictPromise = dictPromise || fetch(DICT_URL, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((dict) => {
        EN = dict;
        HE = {};
        for (const k in dict) if (!(dict[k] in HE)) HE[dict[k]] = k;
        EN_PATS = patterns(EN);
        HE_PATS = patterns(HE);
      });
    return dictPromise;
  }

  function lookup(text, dict, pats) {
    const k = norm(text);
    if (!k) return null;
    let v = dict[k];
    if (v == null) {
      for (const p of pats) {
        const m = k.match(p.re);
        if (!m) continue;
        v = p.out.replace(/\{(\d+)\}/g, (_, n) => { const part = m[p.order.indexOf(+n) + 1] ?? ''; return dict[norm(part)] ?? part; });
        break;
      }
    }
    if (v == null || v === k) return null;
    return text.match(/^\s*/)[0] + v + text.match(/\s*$/)[0];
  }

  const t = (s) => (lang === 'en' && EN ? (lookup(s, EN, EN_PATS) ?? s) : s);

  // ── Applying ──
  // What we replaced, so Hebrew comes back exactly: node → { he, en }, el → { attr: { he, en } }.
  const textOrig = new WeakMap();
  const attrOrig = new WeakMap();
  let everEnglish = false;

  const skipped = (el) => !el || (el.nodeType === 1 && (SKIP[el.nodeName] || el.closest('[data-no-i18n]')));
  const textSkipped = (el) => skipped(el) || (el && SKIP_TEXT[el.nodeName]);

  function doText(node) {
    const cur = node.data;
    const rec = textOrig.get(node);
    if (lang === 'en') {
      if (rec && rec.en === cur) return;
      const v = lookup(cur, EN, EN_PATS);
      if (v != null) { textOrig.set(node, { he: cur, en: v }); node.data = v; }
    } else if (rec && rec.en === cur) {
      textOrig.delete(node);
      node.data = rec.he;
    } else if (everEnglish && !rec) {
      // English a script put back after the switch. Only ever back to Hebrew
      // (← ⇄ → would otherwise flip each other forever).
      const v = lookup(cur, HE, HE_PATS);
      if (v != null && HEBREW.test(v)) node.data = v;
    }
  }

  function doAttr(el, name) {
    const cur = el.getAttribute(name);
    if (cur == null) return;
    const recs = attrOrig.get(el) || {};
    const rec = recs[name];
    if (lang === 'en') {
      if (rec && rec.en === cur) return;
      const v = lookup(cur, EN, EN_PATS);
      if (v != null) { recs[name] = { he: cur, en: v }; attrOrig.set(el, recs); el.setAttribute(name, v); }
    } else if (rec && rec.en === cur) {
      delete recs[name];
      el.setAttribute(name, rec.he);
    } else if (everEnglish && !rec) {
      const v = lookup(cur, HE, HE_PATS);
      if (v != null && HEBREW.test(v)) el.setAttribute(name, v);
    }
  }

  function doElement(el) {
    for (const a of ATTRS) if (el.hasAttribute(a)) doAttr(el, a);
  }

  function walk(root) {
    if (root.nodeType === 3) { if (!textSkipped(root.parentElement)) doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (skipped(root)) return; doElement(root); }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && (SKIP[n.nodeName] || n.hasAttribute('data-no-i18n')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 1) doElement(n);
      else if (!SKIP_TEXT[n.parentElement?.nodeName]) doText(n);
    }
  }

  function translateHead() {
    const title = document.querySelector('title');
    if (title && title.firstChild) doText(title.firstChild);
    document.querySelectorAll(META).forEach((m) => doAttr(m, 'content'));
  }

  const observer = new MutationObserver((records) => {
    if (lang !== 'en' && !everEnglish) return;
    for (const r of records) {
      if (r.type === 'characterData') { if (!textSkipped(r.target.parentElement)) doText(r.target); }
      else if (r.type === 'attributes') { if (!skipped(r.target)) doAttr(r.target, r.attributeName); }
      else r.addedNodes.forEach((n) => walk(n));
    }
  });

  // ── Language buttons ──
  function renderToggles() {
    document.querySelectorAll('[data-lang-toggle]').forEach((b) => {
      b.setAttribute('data-no-i18n', '');
      const toEn = lang !== 'en';
      b.textContent = toEn ? 'EN' : 'עב';
      b.setAttribute('lang', toEn ? 'en' : 'he');
      b.setAttribute('aria-label', toEn ? 'English' : 'עברית');
      b.setAttribute('title', toEn ? 'English' : 'עברית');
      if (!b.dataset.langBound) {
        b.dataset.langBound = '1';
        b.addEventListener('click', (e) => { e.preventDefault(); set(lang === 'en' ? 'he' : 'en'); });
      }
    });
  }

  async function set(next) {
    if (next !== 'en' && next !== 'he') return;
    write(next);
    if (next === 'en') await loadDict();
    lang = next;
    setDir(next);
    if (next === 'en') everEnglish = true;
    if (document.body) walk(document.body);
    translateHead();
    renderToggles();
    window.dispatchEvent(new CustomEvent('casa:lang', { detail: { lang } }));
  }

  const ready = (lang === 'en' ? loadDict() : Promise.resolve()).then(() => new Promise((res) => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', res, { once: true });
    else res();
  })).then(() => {
    if (lang === 'en') {
      everEnglish = true;
      walk(document.body);
      translateHead();
      window.dispatchEvent(new CustomEvent('casa:lang', { detail: { lang } }));
    }
    renderToggles();
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    html.classList.remove('i18n-loading');
  });

  window.CasaI18n = { get lang() { return lang; }, set, t, ready };
})();
