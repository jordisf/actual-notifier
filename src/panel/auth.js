'use strict';

/**
 * Panel auth (data-model.md Panel Credentials / Session):
 *  - hashPassword/verifyPassword: crypto.scrypt salted hash, 'salt:hash' hex format.
 *  - signSession/verifySession: HMAC-signed session cookie, no server-side session store.
 *  - getOrCreateSessionSecret: persisted once via the kv table (survives restarts).
 *
 * The stored hash, the session secret, and cookie values must never be logged.
 */

const crypto = require('crypto');
const { kvGet, kvSet } = require('./config-store');

const SCRYPT_KEYLEN = 64;
const SESSION_SECRET_KV_KEY = 'panel_session_secret';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** cookie format: sessionId.expiryEpoch.hmacHex */
function signSession(sessionId, expiryEpoch, secret) {
  const payload = `${sessionId}.${expiryEpoch}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${hmac}`;
}

function verifySession(cookieValue, secret) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return null;
  const [sessionId, expiryEpochStr, hmacHex] = parts;
  const expiryEpoch = Number(expiryEpochStr);
  if (!sessionId || !Number.isFinite(expiryEpoch)) return null;

  const expected = crypto.createHmac('sha256', secret).update(`${sessionId}.${expiryEpoch}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(hmacHex, 'hex');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) return null;
  if (expiryEpoch < Date.now()) return null;

  return { sessionId, expiryEpoch };
}

/** Read the persisted session secret, generating and storing it once on first boot. */
function getOrCreateSessionSecret(db) {
  let secret = kvGet(db, SESSION_SECRET_KV_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    kvSet(db, SESSION_SECRET_KV_KEY, secret);
  }
  return secret;
}

module.exports = {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  getOrCreateSessionSecret,
};
