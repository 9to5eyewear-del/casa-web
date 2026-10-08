// Where Casa Mancini comes to the bride (התארגנות כלה): every locality with its
// estimated driving time from the studio in Ein Vered, and the service zone
// that time puts it in. Shared by the website forms (js/prep-location.js) and
// the lead API (api/_lib/validate.js), so both classify a location the same way.

import { PLACES as ROWS } from './service-areas.data.js';

export const ORIGIN = 'עין ורד';

// By driving time from Ein Vered. Anything but 'recommended' is a lead to
// check availability and pricing for (out_of_area).
// `en` is for the English site; LeadLive and the emails use the Hebrew.
export const ZONES = {
  recommended: { label: 'אזור שירות מומלץ', en: 'Recommended service area', max: 75 },
  special: { label: 'מחוץ לאזור המומלץ – נבדוק אפשרות מיוחדת', en: "Outside our recommended area – we'll look into a special option", max: 105 },
  remote: { label: 'מיקום מרוחק – נבדוק זמינות ותמחור חריג', en: "Remote location – we'll check availability and special pricing", max: Infinity },
  unknown: { label: 'מיקום לא זוהה – נבדוק זמינות ותמחור', en: "Location not recognized – we'll check availability and pricing" },
};
export const ZONE_IDS = new Set(Object.keys(ZONES));

export function zoneFor(minutes) {
  if (minutes == null) return 'unknown';
  return minutes <= ZONES.recommended.max ? 'recommended' : minutes <= ZONES.special.max ? 'special' : 'remote';
}

export const needsCheck = (zone) => zone !== 'recommended';

/** "כ-45 דקות" / "about 45 min" — rounded to 5 minutes, it's an estimate. */
export function minutesText(minutes, lang = 'he') {
  if (minutes == null) return null;
  const en = lang === 'en';
  if (minutes < 8) return en ? 'a few minutes' : 'כמה דקות';
  const m = Math.round(minutes / 5) * 5;
  if (m < 120) return en ? `about ${m} min` : `כ-${m} דקות`;
  const h = Math.floor(m / 60), rest = m % 60;
  return en ? `about ${h} h${rest ? ` ${rest} min` : ''}` : `כ-${h} שעות${rest ? ` ו-${rest} דקות` : ''}`;
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

/**
 * Spelling-insensitive key. Hebrew: no niqqud/punctuation, no final letters,
 * וו→ו, יי→י (קרית = קריית). English: lower case, q→k, w→v, no doubled
 * letters (Qiryat = Kiryat, Ashqelon = Ashkelon).
 */
export function placeKey(text, { spaces = false } = {}) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[^\u05D0-\u05EAa-z0-9]+/gi, spaces ? ' ' : '')
    .replace(/וו/g, 'ו').replace(/יי/g, 'י')
    .trim()
    .toLowerCase()
    .replace(/q/g, 'k').replace(/w/g, 'v').replace(/([a-z])\1+/g, '$1');
}

// { name (Hebrew, stored on the lead), en (shown on the English site), names (all searchable), minutes, estimated, zone }
const PLACES = ROWS.map(([name, en, minutes, estimated, alt]) => ({
  name, en: en || name, names: [name, en, alt].filter(Boolean), minutes, estimated: Boolean(estimated), zone: zoneFor(minutes),
}));
const BY_NAME = new Map(PLACES.map((p) => [p.name, p]));

const BY_KEY = new Map();
for (const p of PLACES) for (const n of p.names) if (!BY_KEY.has(placeKey(n))) BY_KEY.set(placeKey(n), p);
for (const [alias, name] of Object.entries(ALIASES)) if (BY_NAME.has(name)) BY_KEY.set(placeKey(alias), BY_NAME.get(name));
// For finding a locality inside a longer address ("הרצל 5, נתניה"), longest names first.
const BY_PHRASE = [...PLACES.flatMap((p) => p.names.map((n) => [n, p])), ...Object.entries(ALIASES).map(([a, n]) => [a, BY_NAME.get(n)])]
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
    // The best match among its names (Hebrew, English, CBS spelling).
    let best = 9;
    for (const n of p.names) {
      const k = placeKey(n);
      const at = k.indexOf(key);
      if (at < 0) continue;
      best = Math.min(best, at === 0 ? 0 : placeKey(n, { spaces: true }).split(' ').some((w) => w.startsWith(key)) ? 1 : 2);
    }
    if (best < 9) ranked.push([best, needsCheck(p.zone) ? 1 : 0, p.minutes ?? 999, p]);
  }
  ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return ranked.slice(0, limit).map(([, , , p]) => ({ name: p.name, en: p.en, minutes: p.minutes, zone: p.zone }));
}
