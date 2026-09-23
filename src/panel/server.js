'use strict';

/**
 * Minimal HTTP server for the config panel (research.md: no framework).
 *
 * Router: array-based method+path dispatch with simple `:param` segments.
 * Cookie parsing: hand-rolled (no external lib).
 * requireSession: session-guard wrapper — redirects to /login when the
 * session cookie is missing, invalid, or expired (contracts/routes.md).
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const querystring = require('querystring');

const auth = require('./auth');

const SESSION_COOKIE_NAME = 'panel_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h working session (spec.md Assumptions: "several hours")
const MAX_BODY_BYTES = 1024 * 1024; // 1MiB — plenty for form posts, guards against abuse

// --- cookies -----------------------------------------------------------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function setCookie(res, name, value, { maxAgeMs, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/'];
  if (httpOnly) parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (typeof maxAgeMs === 'number') parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  const existing = res.getHeader('Set-Cookie');
  const next = existing ? (Array.isArray(existing) ? existing : [existing]).concat(parts.join('; ')) : [parts.join('; ')];
  res.setHeader('Set-Cookie', next);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAgeMs: 0 });
}

// --- response helpers ---------------------------------------------------------

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

/** Read and parse an application/x-www-form-urlencoded body. */
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(querystring.parse(raw));
    });
    req.on('error', reject);
  });
}

// --- router ---------------------------------------------------------------------

function compilePath(path) {
  const paramNames = [];
  const pattern = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

function createRouter() {
  const routes = [];

  function add(method, path, handler) {
    routes.push({ method, ...compilePath(path), handler });
  }

  function match(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(m[i + 1]);
      });
      return { handler: route.handler, params };
    }
    return null;
  }

  return {
    get: (path, handler) => add('GET', path, handler),
    post: (path, handler) => add('POST', path, handler),
    match,
  };
}

// --- server -----------------------------------------------------------------------

function createServer(db) {
  const secret = auth.getOrCreateSessionSecret(db);
  const router = createRouter();

  // sessionId is prefixed 'boot_'/'sess_' to carry the bootstrap flag without
  // changing the fixed 'sessionId.expiryEpoch.hmacHex' cookie format or
  // adding a server-side session store (research.md: stateless signed cookie).
  function issueSession(res, { bootstrap = false } = {}) {
    const prefix = bootstrap ? 'boot_' : 'sess_';
    const sessionId = prefix + crypto.randomBytes(16).toString('hex');
    const expiryEpoch = Date.now() + SESSION_TTL_MS;
    const cookieValue = auth.signSession(sessionId, expiryEpoch, secret);
    setCookie(res, SESSION_COOKIE_NAME, cookieValue, { maxAgeMs: SESSION_TTL_MS });
    return { sessionId, expiryEpoch };
  }

  function requireSession(req, res, handler) {
    const cookies = parseCookies(req);
    const session = auth.verifySession(cookies[SESSION_COOKIE_NAME], secret);
    if (!session) {
      redirect(res, '/login');
      return;
    }
    const pathname = (req.url || '').split('?')[0];
    const isBootstrap = session.sessionId.startsWith('boot_');
    if (isBootstrap && pathname !== '/set-password' && pathname !== '/logout') {
      redirect(res, '/set-password');
      return;
    }
    handler(req, res, Object.assign({}, session, { isBootstrap }));
  }

  const ctx = {
    db,
    requireSession,
    issueSession,
    clearSessionCookie: (res) => clearCookie(res, SESSION_COOKIE_NAME),
    parseBody,
    sendHtml,
    redirect,
  };

  require('./routes/login').register(router, ctx);
  require('./routes/dashboard').register(router, ctx);
  require('./routes/telegram').register(router, ctx);
  require('./routes/smtp').register(router, ctx);
  require('./routes/actual').register(router, ctx);
  require('./routes/recipients').register(router, ctx);
  require('./routes/schedule').register(router, ctx);
  require('./routes/reveal').register(router, ctx);

  // Panel stylesheet — served session-guarded (contracts/routes.md).
  const cssPath = path.join(__dirname, 'static', 'panel.css');
  router.get('/static/panel.css', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      const css = fs.readFileSync(cssPath, 'utf8');
      res2.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(css),
      });
      res2.end(css);
    });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const found = router.match(req.method, url.pathname);
    if (!found) {
      sendHtml(res, 404, '<h1>Not found</h1>');
      return;
    }
    try {
      await found.handler(req, res, found.params);
    } catch (err) {
      sendHtml(res, 500, '<h1>Internal error</h1>');
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });

  return server;
}

module.exports = {
  createServer,
  parseCookies,
  setCookie,
  clearCookie,
  sendHtml,
  redirect,
  parseBody,
  SESSION_COOKIE_NAME,
};
