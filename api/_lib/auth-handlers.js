import { send, readJson, clientIp, hashIp, isSameOrigin } from './http.js';
import { defaultLog, withStaff } from './handlers.js';
import {
  SESSION_COOKIE, SESSION_RENEW_AFTER_SECONDS, createSessionToken, verifySessionToken,
  sessionCookie, clearedSessionCookie, readCookie, verifyPassword,
} from './session.js';

// 5 wrong passwords per IP per 15 minutes; 50 across all IPs (one password,
// so distributed guessing is capped too). A lockout lasts at most 15 minutes,
// and a correct login clears that IP's failures.
export const LOGIN_LIMIT = { ipMax: 5, globalMax: 50, windowSeconds: 900 };

function wrap(name, log, fn) {
  return async (req, res) => {
    try {
      return await fn(req, res);
    } catch (err) {
      log.error(`${name}_error`, { method: req.method, error: String(err && err.message || err) });
      return send(res, 500, { error: 'server_error' });
    }
  };
}

function onlyMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  send(res, 405, { error: 'method_not_allowed' });
  return false;
}

/** POST /api/auth/login  { password } */
export function createLoginHandler(getDeps, { log = defaultLog, limit = LOGIN_LIMIT, now = () => Date.now() } = {}) {
  return wrap('login', log, async (req, res) => {
    if (!onlyMethods(req, res, ['POST'])) return;
    if (!isSameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    const { body, error } = readJson(req);
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (error || !password || password.length > 200) return send(res, 400, { error: 'password required' });

    const deps = getDeps();
    const ipHash = hashIp(clientIp(req), deps.ipHashKey) || 'unknown';
    const gate = await deps.db.loginGate(ipHash, limit);
    if (!gate.allowed) {
      log.warn('login_locked', { ip_hash: ipHash, retry_after_seconds: gate.retry_after_seconds });
      res.setHeader('Retry-After', String(gate.retry_after_seconds));
      return send(res, 429, { error: 'too_many_attempts', retry_after_seconds: gate.retry_after_seconds });
    }

    const ok = await verifyPassword(password, deps.passwordHash);
    await deps.db.recordLoginAttempt(ipHash, ok);
    if (!ok) {
      log.warn('login_failed', { ip_hash: ipHash });
      return send(res, 401, { error: 'invalid_password' });
    }
    log.info('login_ok', { ip_hash: ipHash });
    res.setHeader('Set-Cookie', sessionCookie(createSessionToken(deps.sessionSecret, now())));
    return send(res, 200, { ok: true });
  });
}

/** POST /api/auth/logout */
export function createLogoutHandler({ log = defaultLog } = {}) {
  return wrap('logout', log, async (req, res) => {
    if (!onlyMethods(req, res, ['POST'])) return;
    if (!isSameOrigin(req)) return send(res, 403, { error: 'forbidden' });
    res.setHeader('Set-Cookie', clearedSessionCookie());
    return send(res, 200, { ok: true });
  });
}

/** GET /api/auth/session → { authenticated, expires_at, vapid_public_key } (renews older sessions) */
export function createSessionHandler(getDeps, { log = defaultLog, now = () => Date.now() } = {}) {
  return wrap('session', log, async (req, res) => {
    if (!onlyMethods(req, res, ['GET'])) return;
    const deps = getDeps();
    const session = verifySessionToken(readCookie(req, SESSION_COOKIE), deps.sessionSecret, now());
    if (!session) return send(res, 200, { authenticated: false });

    let exp = session.exp;
    if (Math.floor(now() / 1000) - session.iat > SESSION_RENEW_AFTER_SECONDS) {
      const token = createSessionToken(deps.sessionSecret, now());
      exp = verifySessionToken(token, deps.sessionSecret, now()).exp;
      res.setHeader('Set-Cookie', sessionCookie(token));
    }
    return send(res, 200, {
      authenticated: true,
      expires_at: new Date(exp * 1000).toISOString(),
      vapid_public_key: deps.vapidPublicKey || null,
    });
  });
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function validEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1000) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** POST /api/push/subscribe { endpoint, keys: { p256dh, auth } } · DELETE { endpoint } */
export function createPushSubscribeHandler(getDeps, { log = defaultLog } = {}) {
  return wrap('push_subscribe', log, async (req, res) => {
    if (!onlyMethods(req, res, ['POST', 'DELETE'])) return;
    const deps = getDeps();
    if (!(await withStaff(deps, req, res))) return;
    if (!isSameOrigin(req)) return send(res, 403, { error: 'forbidden' });

    const { body, error } = readJson(req);
    if (error || !body || !validEndpoint(body.endpoint)) return send(res, 400, { error: 'invalid endpoint' });

    if (req.method === 'DELETE') {
      await deps.db.deletePushSubscription(body.endpoint);
      return send(res, 200, { ok: true });
    }

    const { p256dh, auth } = body.keys || {};
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || !B64URL.test(p256dh) || !B64URL.test(auth)
        || p256dh.length > 200 || auth.length > 100) {
      return send(res, 400, { error: 'invalid keys' });
    }
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 300) : null;
    await deps.db.savePushSubscription({ endpoint: body.endpoint, p256dh, auth, userAgent: ua });
    log.info('push_subscribed', {});
    return send(res, 201, { ok: true });
  });
}
