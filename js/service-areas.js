// Where Casa Mancini comes to the bride (התארגנות כלה): the service regions
// and their localities. Shared by the website forms (js/prep-location.js) and
// the lead API (api/_lib/validate.js), so both decide "out of area" the same way.

import { REGION_PLACES, OUTSIDE_PLACES } from './service-areas.data.js';

// `label` on the forms, `name` in LeadLive.
export const REGIONS = [
  { id: 'sharon', label: 'בשרון', name: 'השרון' },
  { id: 'shfela', label: 'בשפלה', name: 'השפלה' },
  { id: 'south', label: 'בדרום', name: 'הדרום' },
  { id: 'north', label: 'בצפון', name: 'הצפון' },
  { id: 'center', label: 'במרכז', name: 'המרכז' },
  { id: 'jerusalem', label: 'ירושלים והסביבה', name: 'ירושלים והסביבה' },
  { id: 'emek_hefer', label: 'עמק חפר', name: 'עמק חפר' },
  { id: 'hadera', label: 'חדרה והסביבה', name: 'חדרה והסביבה' },
];
export const REGION_IDS = new Set(REGIONS.map((r) => r.id));
export const REGION_NAMES = Object.fromEntries(REGIONS.map((r) => [r.id, r.name]));

/** "נתניה (השרון) · מחוץ לאזור שירות" — for notifications, the calendar, emails. */
export function prepLocationText(lead) {
  if (!lead.prep_location) return null;
  const region = REGION_NAMES[lead.prep_region];
  return `${lead.prep_location}${region ? ` (${region})` : ''}${lead.out_of_area ? ' · ⚠️ מחוץ לאזור שירות' : ''}`;
}

// What people type for places the CBS list spells differently.
const ALIASES = {
  'תל אביב': 'תל אביב - יפו', 'יפו': 'תל אביב - יפו', 'ת"א': 'תל אביב - יפו',
  'מודיעין': 'מודיעין-מכבים-רעות', 'מכבים': 'מודיעין-מכבים-רעות', 'רעות': 'מודיעין-מכבים-רעות',
  'ראשון': 'ראשון לציון', 'ראשל"צ': 'ראשון לציון', 'פ"ת': 'פתח תקווה', 'ב"ש': 'באר שבע',
  'קדימה': 'קדימה-צורן', 'צורן': 'קדימה-צורן', 'יהוד': 'יהוד-מונוסון',
  'נצרת עילית': 'נוף הגליל', 'כוכב יאיר': 'כוכב יאיר-צור יגאל', 'צור יגאל': 'כוכב יאיר-צור יגאל',
};

const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

/** Spelling-insensitive key: no niqqud/punctuation, no final letters, וו→ו, יי→י (קרית = קריית). */
export function placeKey(text, { spaces = false } = {}) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[֑-ׇ]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[^א-תa-z0-9]+/gi, spaces ? ' ' : '')
    .replace(/וו/g, 'ו').replace(/יי/g, 'י')
    .trim()
    .toLowerCase();
}

// name → { name, regions: [ids] }; outside places have no regions.
const PLACES = new Map();
const add = (name, region) => {
  const p = PLACES.get(name) || { name, regions: [] };
  if (region && !p.regions.includes(region)) p.regions.push(region);
  PLACES.set(name, p);
};
for (const [region, names] of Object.entries(REGION_PLACES)) names.forEach((n) => add(n, region));
OUTSIDE_PLACES.forEach((n) => add(n, null));

const BY_KEY = new Map();
for (const p of PLACES.values()) if (!BY_KEY.has(placeKey(p.name))) BY_KEY.set(placeKey(p.name), p);
for (const [alias, name] of Object.entries(ALIASES)) if (PLACES.has(name)) BY_KEY.set(placeKey(alias), PLACES.get(name));
// For finding a locality inside a longer address ("הרצל 5, נתניה"), longest names first.
const BY_PHRASE = [...BY_KEY.entries()]
  .map(([, p]) => p)
  .filter((p, i, all) => all.indexOf(p) === i)
  .flatMap((p) => [p.name, ...Object.keys(ALIASES).filter((a) => ALIASES[a] === p.name)].map((n) => [` ${placeKey(n, { spaces: true })} `, p]))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * The locality a typed text refers to: an exact name (any spelling / alias),
 * else a locality named inside a longer address. null when none is known.
 */
export function findPlace(text) {
  const key = placeKey(text);
  if (!key) return null;
  if (BY_KEY.has(key)) return BY_KEY.get(key);
  const padded = ` ${placeKey(text, { spaces: true })} `;
  const hit = BY_PHRASE.find(([phrase]) => phrase.trim().length >= 3 && padded.includes(phrase));
  return hit ? hit[1] : null;
}

/**
 * Where a typed location stands against the chosen region:
 *   in_region     the locality is in that region
 *   other_region  it's in another service region (`region` = that one)
 *   outside       a known locality outside every service region (e.g. אשקלון)
 *   unknown       not a locality we know — treated as outside the service areas
 */
export function checkLocation(text, regionId) {
  const place = findPlace(text);
  if (!place) return { status: 'unknown', place: null, region: null };
  if (!place.regions.length) return { status: 'outside', place, region: null };
  if (place.regions.includes(regionId)) return { status: 'in_region', place, region: regionId };
  return { status: 'other_region', place, region: place.regions[0] };
}

export const isOutOfArea = (status) => status === 'outside' || status === 'unknown';

/** Autocomplete: the region's localities matching what was typed, best first. */
export function suggest(text, regionId, limit = 8) {
  const key = placeKey(text);
  const names = REGION_PLACES[regionId];
  if (!key || !names) return [];
  const ranked = [];
  for (const name of names) {
    const k = placeKey(name);
    const at = k.indexOf(key);
    if (at < 0) continue;
    const wordStart = at === 0 || placeKey(name, { spaces: true }).split(' ').some((w) => w.startsWith(key));
    ranked.push([at === 0 ? 0 : wordStart ? 1 : 2, k.length, name]);
  }
  return ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map((r) => r[2]);
}
