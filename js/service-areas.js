// Where Casa Mancini comes to the bride (התארגנות כלה): every locality with its
// estimated driving time from the studio in Ein Vered, and the service zone
// that time puts it in. Shared by the website forms (js/prep-location.js) and
// the lead API (api/_lib/validate.js), so both classify a location the same way.

import { PLACES as ROWS } from './service-areas.data.js';

export const ORIGIN = 'עין ורד';

// By driving time from Ein Vered. Anything but 'recommended' is a lead to
// check availability and pricing for (out_of_area).
export const ZONES = {
  recommended: { label: 'אזור שירות מומלץ', max: 75 },
  special: { label: 'מחוץ לאזור המומלץ – נבדוק אפשרות מיוחדת', max: 105 },
  remote: { label: 'מיקום מרוחק – נבדוק זמינות ותמחור חריג', max: Infinity },
  unknown: { label: 'מיקום לא זוהה – נבדוק זמינות ותמחור' },
};
export const ZONE_IDS = new Set(Object.keys(ZONES));

export function zoneFor(minutes) {
  if (minutes == null) return 'unknown';
  return minutes <= ZONES.recommended.max ? 'recommended' : minutes <= ZONES.special.max ? 'special' : 'remote';
}

export const needsCheck = (zone) => zone !== 'recommended';

/** "כ-45 דקות" — rounded to 5 minutes, it's an estimate. */
export function minutesText(minutes) {
  if (minutes == null) return null;
  if (minutes < 8) return 'כמה דקות';
  const m = Math.round(minutes / 5) * 5;
  if (m < 120) return `כ-${m} דקות`;
  const h = Math.floor(m / 60), rest = m % 60;
  return `כ-${h} שעות${rest ? ` ו-${rest} דקות` : ''}`;
}

/** "אשקלון · כ-90 דקות מעין ורד · מחוץ לאזור המומלץ…" — for notifications, the calendar, emails. */
export function prepLocationText(lead) {
  if (!lead.prep_location) return null;
  const time = minutesText(lead.drive_minutes);
  return [lead.prep_location, time && `${time} מ${ORIGIN}`, ZONES[lead.service_zone]?.label].filter(Boolean).join(' · ');
}

// What people type for places the CBS list spells differently.
const ALIASES = {
  'תל אביב': 'תל אביב - יפו', 'יפו': 'תל אביב - יפו', 'ת"א': 'תל אביב - יפו',
  'מודיעין': 'מודיעין-מכבים-רעות', 'מכבים': 'מודיעין-מכבים-רעות', 'רעות': 'מודיעין-מכבים-רעות',
  'ראשון': 'ראשון לציון', 'ראשל"צ': 'ראשון לציון', 'פ"ת': 'פתח תקווה', 'ב"ש': 'באר שבע',
  'קדימה': 'קדימה-צורן', 'צורן': 'קדימה-צורן', 'יהוד': 'יהוד-מונוסון',
  'פרדס חנה': 'פרדס חנה-כרכור', 'כרכור': 'פרדס חנה-כרכור', 'בנימינה': 'בנימינה-גבעת עדה',
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

// { name, minutes, estimated, zone }
const PLACES = ROWS.map(([name, minutes, estimated]) => ({ name, minutes, estimated: Boolean(estimated), zone: zoneFor(minutes) }));
const BY_NAME = new Map(PLACES.map((p) => [p.name, p]));

const BY_KEY = new Map();
for (const p of PLACES) if (!BY_KEY.has(placeKey(p.name))) BY_KEY.set(placeKey(p.name), p);
for (const [alias, name] of Object.entries(ALIASES)) if (BY_NAME.has(name)) BY_KEY.set(placeKey(alias), BY_NAME.get(name));
// For finding a locality inside a longer address ("הרצל 5, נתניה"), longest names first.
const BY_PHRASE = [...PLACES.map((p) => [p.name, p]), ...Object.entries(ALIASES).map(([a, n]) => [a, BY_NAME.get(n)])]
  .filter(([, p]) => p)
  .map(([n, p]) => [` ${placeKey(n, { spaces: true })} `, p])
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

/** Where a typed location stands: { place, minutes, zone }; zone 'unknown' when it isn't a locality we know. */
export function checkLocation(text) {
  const place = findPlace(text);
  return place ? { place, minutes: place.minutes, zone: place.zone } : { place: null, minutes: null, zone: 'unknown' };
}

/**
 * Quick search over every locality: best match first; at the same match,
 * the recommended area before the rest, then the closer one.
 */
export function suggest(text, limit = 8) {
  const key = placeKey(text);
  if (!key) return [];
  const ranked = [];
  for (const p of PLACES) {
    const k = placeKey(p.name);
    const at = k.indexOf(key);
    if (at < 0) continue;
    const wordStart = at === 0 || placeKey(p.name, { spaces: true }).split(' ').some((w) => w.startsWith(key));
    ranked.push([at === 0 ? 0 : wordStart ? 1 : 2, needsCheck(p.zone) ? 1 : 0, p.minutes ?? 999, p]);
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return ranked.slice(0, limit).map(([, , , p]) => ({ name: p.name, minutes: p.minutes, zone: p.zone }));
}
