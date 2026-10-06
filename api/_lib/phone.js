// Normalizes a phone number to digits-only E.164 without the "+", so every
// spelling of the same Israeli number matches:
//   054-678-7179, 0546787179, +972546787179, 972546787179 → 972546787179
// Returns null when the number can't be recognized.

const ISRAELI = /^972(?:5\d|7\d|[23489])\d{7}$/;
const INTERNATIONAL = /^[1-9]\d{7,14}$/;

export function normalizePhone(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const explicitIntl = /^(\+|00)/.test(s);
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);

  if (d.startsWith('9720')) d = '972' + d.slice(4); // +972 054…
  if (d.startsWith('972')) return ISRAELI.test(d) ? d : null;
  if (explicitIntl) return INTERNATIONAL.test(d) ? d : null;

  const il = '972' + d.replace(/^0/, '');
  return ISRAELI.test(il) ? il : null;
}
