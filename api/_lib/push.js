// Web Push to every device the owner turned notifications on for.

import { LEAD_TYPE_LABELS } from './catalog.js';

const BRAND = 'Casa Mancini';

const ddmm = (isoDate) => {
  const [, m, d] = isoDate.split('-');
  return `${d}.${m}`;
};

/** The notification for a saved submission, or null when none is due. */
export function leadNotification(lead, out) {
  const url = `/leads#/lead/${out.lead_id}`;
  const tag = `lead-${out.lead_id}`;
  if (out.result === 'created') {
    const body = [lead.name, LEAD_TYPE_LABELS[lead.lead_type], lead.event_date && ddmm(lead.event_date)]
      .filter(Boolean).join(' | ');
    return { title: `ליד חדש – ${BRAND}`, body, url, tag };
  }
  if (out.result === 'repeat') {
    return { title: `פנייה חוזרת – ${BRAND}`, body: `${lead.name} פנתה שוב · פנייה ×${out.submission_count}`, url, tag };
  }
  return null;
}

/**
 * @param webpush  the `web-push` module (or a stand-in in tests)
 * @returns notify(payload) → { sent, removed, failed }
 */
export function createNotifier({ db, webpush, vapid, log, timeoutMs = 5000 }) {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  return async function notify(payload) {
    const subs = await db.listPushSubscriptions();
    if (!subs.length) return { sent: 0, removed: 0, failed: 0 };

    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body,
        { TTL: 86400, urgency: 'high', topic: payload.tag?.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, ''), timeout: timeoutMs })));

    const ok = [], gone = [];
    let failed = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') return ok.push(subs[i].id);
      const code = r.reason?.statusCode;
      if (code === 404 || code === 410) return gone.push(subs[i].id);
      failed++;
      log.warn('push_send_failed', { subscription_id: subs[i].id, status: code ?? null, error: String(r.reason?.message || r.reason).slice(0, 200) });
    });
    if (ok.length || gone.length) await db.recordPushResults(ok, gone);
    if (gone.length) log.info('push_subscriptions_removed', { count: gone.length });
    return { sent: ok.length, removed: gone.length, failed };
  };
}
