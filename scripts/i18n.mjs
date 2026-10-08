// The English version of the site: every Hebrew string on the pages and in
// their scripts, translated once and stored in js/i18n/en.json (js/i18n.js
// swaps them in the browser when English is chosen).
//
//   node scripts/i18n.mjs              lists Hebrew strings with no translation yet
//   node --env-file=.env.local scripts/i18n.mjs --translate
//                                      translates them with Claude and adds them to en.json
//
// tests/unit.test.js fails while any string is missing, so new Hebrew text
// on the site never ships without its English.
//
// A key is the Hebrew text as the browser shows it: whitespace collapsed,
// trimmed. ${...} in a template literal becomes {0}, {1}… and js/i18n.js
// matches it as a pattern ("שלב {0} מתוך {1}" → "Step {0} of {1}").

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
export const SOURCES = ['index.html', 'lead.html', 'policy.html', 'accessibility.html',
  'js/judith.js', 'js/judith-loader.js', 'js/lead-submit.js'];
const DICT = new URL('js/i18n/en.json', ROOT);

const HEBREW = /[֐-׿]/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rlm: '', lrm: '' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m));
export const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Pieces of markup / a string that the browser will show as separate text.
function textPieces(markup) {
  return markup
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split(/<[^>]*>/)
    .map((t) => norm(decode(t)));
}

const ATTRS = /\s(?:placeholder|aria-label|title|alt|content|data-i18n-text)\s*=\s*"([^"]*)"/g;

function fromHtml(html, keys) {
  const scripts = [];
  const body = html
    .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_, js) => { scripts.push(js); return ' '; })
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  for (const t of textPieces(body)) add(keys, t);
  for (const tag of body.match(/<[a-z][^>]*>/gi) || []) {
    for (const [, v] of tag.matchAll(ATTRS)) add(keys, norm(decode(v)));
  }
  scripts.forEach((js) => fromJs(js, keys));
}

// String literals ('…', "…", `…`) with Hebrew in them.
function fromJs(js, keys) {
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of js.matchAll(re)) {
    let s = m[1] ?? m[2] ?? m[3];
    if (!HEBREW.test(s)) continue;
    if (m[3] != null) {
      // Strings inside ${…} ("${all ? 'הכל' : …}") are text too.
      for (const [, expr] of s.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) fromJs(expr, keys);
      // ${…} → {0}, {1}… (nested braces are rare here; take the simple form)
      let i = 0;
      s = s.replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, () => `{${i++}}`);
    }
    s = s.replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1');
    // Attributes of the markup a template builds (aria-label="הגדלת תמונה: ${…}").
    for (const tag of s.match(/<[a-z][^>]*>/gi) || []) {
      for (const [, v] of tag.matchAll(ATTRS)) add(keys, renumber(norm(decode(v))));
    }
    for (const t of textPieces(s)) {
      // A piece made only of placeholders and punctuation around Hebrew stays whole.
      add(keys, renumber(t));
    }
  }
}

// After splitting on tags, placeholders restart at {0} within each piece.
function renumber(t) {
  let i = 0;
  const map = new Map();
  return t.replace(/\{(\d+)\}/g, (_, n) => { if (!map.has(n)) map.set(n, i++); return `{${map.get(n)}}`; });
}

// Code fragments (a nested template, a selector) aren't text anyone sees.
function add(keys, t) {
  if (t && HEBREW.test(t) && !/\$\{|\[aria-label=/.test(t)) keys.add(t);
}

export function extract() {
  const keys = new Set();
  for (const f of SOURCES) {
    const src = readFileSync(new URL(f, ROOT), 'utf8');
    if (f.endsWith('.html')) fromHtml(src, keys); else fromJs(src, keys);
  }
  return [...keys].sort();
}

export const loadDict = () => JSON.parse(readFileSync(DICT, 'utf8'));
export const missing = (dict = loadDict()) => extract().filter((k) => !(k in dict));

async function translate(keys) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const out = {};
  for (let i = 0; i < keys.length; i += 80) {
    const batch = keys.slice(i, i + 80);
    const msg = await client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: `You translate the website of Casa Mancini — a private Tuscan-style house in Ein Vered, Israel, for bridal preparation ("התארגנות כלה") and photo/video productions — from Hebrew to natural, warm, elegant English for international clients. Keep the brand voice: calm, boutique, personal. Hebrew addresses the reader in the feminine; English just uses "you". Keep {0}, {1}… placeholders, emoji, ₪ amounts, numbers and line breaks exactly. Short UI labels stay short. Return only a JSON object mapping each given Hebrew string to its English.`,
      messages: [{ role: 'user', content: JSON.stringify(batch, null, 1) }],
    });
    const text = msg.content.find((c) => c.type === 'text')?.text || '';
    Object.assign(out, JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
  }
  return out;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const dict = loadDict();
  const todo = missing(dict);
  if (!process.argv.includes('--translate')) {
    console.log(todo.length ? todo.join('\n') : 'Every Hebrew string has an English translation.');
    process.exit(todo.length ? 1 : 0);
  }
  if (!todo.length) { console.log('Nothing to translate.'); process.exit(0); }
  const added = await translate(todo);
  const merged = { ...dict, ...added };
  writeFileSync(DICT, JSON.stringify(Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b, 'he'))), null, 1) + '\n');
  console.log(`Added ${Object.keys(added).length} translations; ${missing(merged).length} still missing.`);
}
