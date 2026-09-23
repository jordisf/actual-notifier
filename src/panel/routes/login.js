'use strict';

/**
 * GET/POST /login, GET/POST /set-password, POST /logout.
 *
 * Login state lives entirely in the kv table (data-model.md Panel
 * Credentials): panel_username, panel_password_hash, panel_login_failures,
 * panel_lockout_until. Bootstrap (no password set yet) is FR-003; lockout
 * after repeated failures is FR-015.
 */

const { log } = require('../../log');
const { kvGet, kvSet } = require('../config-store');
const { renderAuthPage } = require('../layout');
const auth = require('../auth');

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLoginForm({ bootstrap, error }) {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  if (bootstrap) {
    return renderAuthPage({
      title: 'Panel login',
      body: `<div class="card">
  <h1>Welcome</h1>
  <p>No password has been set yet. Click below to log in and set one now.</p>
  ${errorHtml}
  <form method="post" action="/login">
    <div class="actions"><button type="submit">Log in</button></div>
  </form>
</div>`,
    });
  }
  return renderAuthPage({
    title: 'Panel login',
    body: `<div class="card">
  <h1>Log in</h1>
  ${errorHtml}
  <form method="post" action="/login">
    <label>Username <input type="text" name="username" autocomplete="username" required></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <div class="actions"><button type="submit">Log in</button></div>
  </form>
</div>`,
  });
}

function renderSetPasswordForm({ currentUsername, error }) {
  const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return renderAuthPage({
    title: 'Set panel credentials',
    body: `<div class="card">
  <h1>Set your username and password</h1>
  ${errorHtml}
  <form method="post" action="/set-password">
    <label>Username <input type="text" name="username" value="${escapeHtml(currentUsername || '')}" required></label>
    <label>New password <input type="password" name="password" autocomplete="new-password" required></label>
    <label>Confirm password <input type="password" name="confirm" autocomplete="new-password" required></label>
    <div class="actions"><button type="submit">Save</button></div>
  </form>
</div>`,
  });
}

function isLockedOut(db) {
  const until = kvGet(db, 'panel_lockout_until');
  if (!until) return false;
  const untilMs = Date.parse(until);
  return Number.isFinite(untilMs) && untilMs > Date.now();
}

function register(router, ctx) {
  const { db, requireSession, issueSession, clearSessionCookie, parseBody, sendHtml, redirect } = ctx;

  router.get('/login', (req, res) => {
    const bootstrap = !kvGet(db, 'panel_password_hash');
    sendHtml(res, 200, renderLoginForm({ bootstrap }));
  });

  router.post('/login', async (req, res) => {
    const body = await parseBody(req);
    const passwordHash = kvGet(db, 'panel_password_hash');

    if (!passwordHash) {
      // FR-003: exactly one no-password bootstrap login, forced into /set-password next.
      issueSession(res, { bootstrap: true });
      log('info', 'panel', 'login succeeded (bootstrap)', {});
      redirect(res, '/set-password');
      return;
    }

    if (isLockedOut(db)) {
      sendHtml(res, 423, renderLoginForm({ bootstrap: false, error: 'Too many failed attempts. Try again later.' }));
      return;
    }

    const attemptedUsername = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const actualUsername = kvGet(db, 'panel_username');

    if (attemptedUsername !== actualUsername || !auth.verifyPassword(password, passwordHash)) {
      const failures = Number(kvGet(db, 'panel_login_failures') || '0') + 1;
      kvSet(db, 'panel_login_failures', String(failures));
      log('warn', 'panel', 'login failed', { username: attemptedUsername });

      if (failures >= LOCKOUT_THRESHOLD) {
        const lockoutUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
        kvSet(db, 'panel_lockout_until', lockoutUntil);
        log('warn', 'panel', 'lockout triggered', { username: attemptedUsername, lockout_until: lockoutUntil });
      }

      sendHtml(res, 401, renderLoginForm({ bootstrap: false, error: 'Invalid username or password.' }));
      return;
    }

    kvSet(db, 'panel_login_failures', '0');
    issueSession(res, { bootstrap: false });
    log('info', 'panel', 'login succeeded', { username: attemptedUsername });
    redirect(res, '/');
  });

  router.get('/set-password', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      const currentUsername = kvGet(db, 'panel_username');
      sendHtml(res2, 200, renderSetPasswordForm({ currentUsername }));
    });
  });

  router.post('/set-password', (req, res) => {
    requireSession(req, res, async (req2, res2) => {
      const body = await parseBody(req2);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const confirm = typeof body.confirm === 'string' ? body.confirm : '';

      if (!username || !password) {
        sendHtml(res2, 400, renderSetPasswordForm({ currentUsername: username, error: 'Username and password are required.' }));
        return;
      }
      if (password !== confirm) {
        sendHtml(res2, 400, renderSetPasswordForm({ currentUsername: username, error: 'Passwords do not match.' }));
        return;
      }

      kvSet(db, 'panel_username', username);
      kvSet(db, 'panel_password_hash', auth.hashPassword(password));
      kvSet(db, 'panel_login_failures', '0');
      kvSet(db, 'panel_lockout_until', '');

      // clears the bootstrap-forced flag by replacing it with a normal session
      issueSession(res2, { bootstrap: false });
      log('info', 'panel', 'credentials updated', { username });
      redirect(res2, '/');
    });
  });

  router.post('/logout', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      clearSessionCookie(res2);
      redirect(res2, '/login');
    });
  });
}

module.exports = { register };
