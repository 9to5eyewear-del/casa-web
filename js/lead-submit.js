/* Sends an inquiry to the Casa Mancini lead system (/api/leads, the source of
 * truth) and to Web3Forms (backup email) in parallel, under one submission_id
 * so the two can be matched. It counts as received if either accepted it.
 *
 *   const { ok } = await CasaLeads.submit({ lead: {...}, web3: {...} });
 */
(function () {
  'use strict';

  const API = '/api/leads';
  const WEB3 = 'https://api.web3forms.com/submit';
  const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  async function postJson(url, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      return { ok: res.ok, status: res.status, out: await res.json().catch(() => ({})) };
    } finally {
      clearTimeout(timer);
    }
  }

  function tracking() {
    const params = new URLSearchParams(location.search);
    const meta = { page: location.pathname };
    if (document.referrer) meta.referrer = document.referrer;
    UTM.forEach((k) => { const v = params.get(k); if (v) meta[k] = v; });
    return meta;
  }

  async function submit({ lead, web3 }) {
    const submissionId = uuid();

    const toApi = postJson(API, Object.assign({}, lead, { submission_id: submissionId, metadata: tracking() }), 12000)
      .then((r) => r.ok && r.out.ok === true, () => false);

    const toEmail = postJson(WEB3, Object.assign({}, web3, {
      subject: `${web3.subject} · ${submissionId.slice(0, 8)}`,
      message: `${web3.message}\nמזהה פנייה: ${submissionId}`,
      botcheck: '',
    }), 15000).then((r) => r.ok && r.out.success === true, () => false);

    const [db, email] = await Promise.all([toApi, toEmail]);
    // The server logs its own failures (lead_db_save_failed etc.) by submission_id.
    if (!db) console.warn('[CasaLeads] not saved to the lead system', submissionId, { email });
    return { ok: db || email, db, email, submissionId };
  }

  window.CasaLeads = { submit };
})();
