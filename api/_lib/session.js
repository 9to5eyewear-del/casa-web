// Single-owner auth: one password (stored only as a scrypt hash in
// LEADS_PASSWORD_HASH) and a signed, expiring session in an HttpOnly cookie.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { header } from './http.js';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'casa_leads_session';
export const SESSION_TTL_SECONDS = 30 * 86400;
// A session older than this is re-issued (another 30 days) when the app
// opens, so the owner stays logged in as long as they use it monthly.
export const SESSION_RENEW_AFTER_SECONDS = 7 * 86400;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

export function createSessionToken(secret, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({ v: 1, iat, exp: iat + SESSION_TTL_SECONDS }));
  return `${payload}.${sign(secret, payload)}`;
}

// The expiry inside the signed token is what counts, not the cookie's.
export function verifySessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.v !== 1 || !Number.isInteger(data.exp) || data.exp <= Math.floor(now / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readCookie(req, name) {
  const raw = header(req, 'cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Returns { user } or { status, error }, the shape handlers expect.
export function createRequireSession(secret, now = () => Date.now()) {
  return async function requireSession(req) {
    const session = verifySessionToken(readCookie(req, SESSION_COOKIE), secret, now());
    return session ? { user: { id: 'owner', email: null }, session } : { status: 401, error: 'unauthorized' };
  };
}

// ── Password hashing (scrypt, stored as scrypt:N:r:p:salt:hash, no shell-special characters) ──

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64url(salt), b64url(hash)].join(':');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').trim().split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new Error('LEADS_PASSWORD_HASH is malformed');
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}
