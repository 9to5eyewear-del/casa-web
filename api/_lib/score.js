// Server-side lead score from the structured fields only (no message NLP).
//
// A score needs a timing signal (date or urgency) and a known service type;
// without those it stays null: no score beats an unreliable one. Budget is
// just one more signal, so a close date + clear intent is HOT without it.

const URGENCY_POINTS = { this_week: 45, this_month: 35, three_months: 20, flexible: 5 };
const TYPE_POINTS = { bridal: 20, production: 15, fashion: 10, product: 10 };

function datePoints(eventDate, now) {
  const days = (Date.parse(eventDate + 'T00:00:00Z') - now.getTime()) / 86400000;
  return days < 14 ? 45 : days < 30 ? 35 : days < 90 ? 20 : 10;
}

export function scoreLead(lead, now = new Date()) {
  const hasTiming = Boolean(lead.urgency || lead.event_date);
  const typeKnown = Boolean(lead.lead_type && lead.lead_type !== 'other');
  if (!hasTiming || !typeKnown) return null;

  let score = Math.max(
    URGENCY_POINTS[lead.urgency] || 0,
    lead.event_date ? datePoints(lead.event_date, now) : 0,
  );
  score += TYPE_POINTS[lead.lead_type] || 0;

  if (lead.budget != null) score += lead.budget >= 5000 ? 15 : lead.budget >= 2000 ? 10 : 0;

  // Completeness: how much the customer bothered to tell us.
  if (lead.email) score += 5;
  if (lead.message && lead.message.length > 20) score += 5;
  if (lead.companions != null || lead.production_type || lead.lead_subtype) score += 5;

  return score >= 60 ? 'hot' : score >= 35 ? 'warm' : 'cold';
}
