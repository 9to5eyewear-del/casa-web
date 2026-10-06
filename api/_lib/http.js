import { createHmac } from 'node:crypto';

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const MAX_BODY_CHARS = 20_000;

// Vercel parses JSON bodies onto req.body (and throws on malformed JSON when
// it's read). Text bodies (e.g. from sendBeacon) arrive as strings.
export function readJson(req) {
  let body;
  try {
    body = req.body;
  } catch {
    return { error: 'invalid_json' };
  }
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_CHARS) return { error: 'too_large' };
    try { body = JSON.parse(body); } catch { return { error: 'invalid_json' }; }
  } else if (body && JSON.stringify(body).length > MAX_BODY_CHARS) {
    return { error: 'too_large' };
  }
  return { body: body ?? null };
}

export function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Vercel sets x-forwarded-for itself, so the first entry is the real client.
export function clientIp(req) {
  const fwd = header(req, 'x-forwarded-for');
  return (fwd && fwd.split(',')[0].trim()) || header(req, 'x-real-ip') || req.socket?.remoteAddress || null;
}

export function hashIp(ip, key) {
  return ip ? createHmac('sha256', key).update(ip).digest('hex').slice(0, 32) : null;
}

// Browsers always send Origin on cross-site POSTs; reject those. Requests
// without Origin (server-to-server) are allowed and still rate limited.
export function isSameOrigin(req) {
  const origin = header(req, 'origin');
  if (!origin) return true;
  const host = header(req, 'x-forwarded-host') || header(req, 'host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function query(req) {
  if (req.query) return req.query;
  return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
}
