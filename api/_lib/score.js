// Server-side lead score. Uses the weights lead.html already used in its
// email, but only scores when the inquiry has both a timing signal (date or
// urgency) and a budget. The simple site form never has a budget, so its
// leads stay unscored: no score beats an unreliable one.

const URGENCY_POINTS = { this_week: 40, this_month: 30, three_months: 20, flexible: 10 };
const TYPE_POINTS = { bridal: 20, production: 15 };

export function scoreLead(lead, now = new Date()) {
  const hasTiming = Boolean(lead.urgency || lead.event_date);
  if (!hasTiming || lead.budget == null) return null;

  let score = URGENCY_POINTS[lead.urgency] || 0;
  if (lead.event_date) {
    const days = (Date.parse(lead.event_date + 'T00:00:00Z') - now.getTime()) / 86400000;
    score += days < 30 ? 35 : days < 90 ? 20 : 10;
  }
  score += lead.budget >= 5000 ? 25 : lead.budget >= 2000 ? 15 : 5;
  score += TYPE_POINTS[lead.lead_type] || 0;
  if (lead.message && lead.message.length > 20) score += 5;

  return score >= 60 ? 'hot' : score >= 35 ? 'warm' : 'cold';
}
