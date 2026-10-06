// Attention priority: how much an OPEN lead needs the owner right now.
//
// Computed on read, never stored: the stored lead_score (score.js) describes
// the inquiry itself; this adds what changes with time — how fresh it is,
// whether the customer came back, how close the date is, how long it waited.
// Closed leads (won / lost) get no priority.

const HOUR = 3600000;
const DAY = 24 * HOUR;

export const WAITING_HOURS = 24;    // 'new' this long → waiting
export const DATE_SOON_DAYS = 21;   // event within this many days → date_soon
export const REPEAT_RECENT_DAYS = 7;

const SCORE_POINTS = { hot: 40, warm: 20, cold: 5 };

// Days from the start of today (Israel) to the event date; negative = past.
export function daysUntil(isoDate, now) {
  if (!isoDate) return null;
  const today = new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  return Math.round((Date.parse(isoDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY);
}

/**
 * @returns null for closed leads, else { level: 'hot'|'warm'|'cold', points, reasons[] }
 *   reasons are the attention kinds that apply, most urgent first:
 *   'waiting' | 'hot' | 'repeat' | 'date_soon'
 */
export function attentionPriority(lead, now = new Date()) {
  if (lead.status !== 'new' && lead.status !== 'in_progress') return null;
  const t = +now;
  const sinceLast = t - Date.parse(lead.last_submission_at || lead.created_at);
  const age = t - Date.parse(lead.created_at);
  const days = daysUntil(lead.event_date, t);

  let points = SCORE_POINTS[lead.lead_score] || 0;
  points += sinceLast < HOUR ? 25 : sinceLast < DAY ? 15 : sinceLast < 3 * DAY ? 5 : 0;
  if (lead.submission_count > 1) points += Math.min(15 + 5 * (lead.submission_count - 2), 25);
  if (days != null && days >= 0) points += days <= 14 ? 30 : days <= 30 ? 15 : 0;
  const waiting = lead.status === 'new' && age >= WAITING_HOURS * HOUR;
  if (lead.status === 'new') points += waiting ? 20 : 10;

  const level = points >= 60 ? 'hot' : points >= 30 ? 'warm' : 'cold';
  const reasons = [];
  if (waiting) reasons.push('waiting');
  if (level === 'hot') reasons.push('hot');
  if (lead.submission_count > 1 && sinceLast < REPEAT_RECENT_DAYS * DAY) reasons.push('repeat');
  if (days != null && days >= 0 && days <= DATE_SOON_DAYS) reasons.push('date_soon');
  return { level, points, reasons, days_to_event: days };
}

export function withPriority(lead, now) {
  return { ...lead, priority: attentionPriority(lead, now) };
}

/** The open leads worth acting on now, most urgent first. */
export function attentionList(openLeads, now = new Date(), limit = 5) {
  return openLeads
    .map((l) => withPriority(l, now))
    .filter((l) => l.priority && l.priority.reasons.length)
    .sort((a, b) => b.priority.points - a.priority.points || Date.parse(b.last_submission_at) - Date.parse(a.last_submission_at))
    .slice(0, limit);
}
