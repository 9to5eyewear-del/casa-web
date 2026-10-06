import { timingSafeEqual } from 'node:crypto';
import { send, header } from './http.js';
import { defaultLog } from './handlers.js';
import { reminderNotification } from './push.js';

export const REMINDER_HOURS = 24;

function authorized(req, secret) {
  const given = Buffer.from(header(req, 'authorization') || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * /api/cron/reminders — run hourly by GitHub Actions (and daily by Vercel Cron
 * as a backup). Sends one reminder per lead still 'new' 24 hours after it came
 * in. Requires Authorization: Bearer CRON_SECRET.
 */
export function createRemindersHandler(getDeps, { log = defaultLog } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return send(res, 405, { error: 'method_not_allowed' });
      }
      const deps = getDeps();
      if (!authorized(req, deps.cronSecret)) return send(res, 401, { error: 'unauthorized' });

      const due = await deps.db.claimDueReminders(REMINDER_HOURS);
      if (!due.length) return send(res, 200, { reminded: 0 });

      if (!deps.notify) {
        log.warn('reminders_without_push', { count: due.length });
        return send(res, 200, { reminded: 0, due: due.length });
      }
      const unread = await deps.db.unreadCount();
      let sent = 0;
      for (const lead of due) {
        const r = await deps.notify({ ...reminderNotification(lead), unread });
        sent += r.sent;
      }
      log.info('reminders_sent', { leads: due.length, deliveries: sent });
      return send(res, 200, { reminded: due.length, deliveries: sent });
    } catch (err) {
      log.error('reminders_error', { error: String(err && err.message || err) });
      return send(res, 500, { error: 'server_error' });
    }
  };
}
