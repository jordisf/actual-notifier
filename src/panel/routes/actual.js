'use strict';

/**
 * GET/POST /actual (US3, FR-010/FR-012).
 *
 * On POST, validates the submitted (not-yet-saved) connection by running
 * src/actual.js's own open()/close() handshake before persisting — a real
 * network call against the Actual server (slow but acceptable for this
 * low-traffic admin action, per tasks.md T017).
 *
 * actual.js reads ACTUAL_SERVER_URL/ACTUAL_PASSWORD/ACTUAL_SYNC_ID from
 * process.env (no parameterized entry point), so the candidate values are
 * swapped in for the duration of the validation call only, then restored
 * in `finally` — the same technique routes/telegram.js uses for the bot
 * token. The dataDir passed to open() is a fresh scratch directory under
 * the OS tmp dir (never the cron's /tmp/actual-cache or the listener's
 * LISTENER_DATA_DIR cache), removed again once the call finishes.
 *
 * ACTUAL_PASSWORD is never rendered in full — only masked, with a "Show"
 * control wired to POST /reveal/actual-password (routes/reveal.js, T019).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { log } = require('../../log');
const { envGet, envSetMany } = require('../config-store');
const actual = require('../../actual');

const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'actual.html');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskSecret(value) {
  if (!value) return '(not set)';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

function currentSettings() {
  return {
    serverUrl: envGet('ACTUAL_SERVER_URL') || '',
    syncId: envGet('ACTUAL_SYNC_ID') || '',
    password: envGet('ACTUAL_PASSWORD') || '',
  };
}

function render({ serverUrl, syncId, password, error }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const errorHtml = error ? `<p style="color:red">${escapeHtml(error)}</p>` : '';
  return template
    .replace('{{errorHtml}}', errorHtml)
    .replace('{{serverUrl}}', escapeHtml(serverUrl))
    .replace('{{syncId}}', escapeHtml(syncId))
    .replace('{{maskedPassword}}', escapeHtml(maskSecret(password)));
}

/**
 * Validate serverUrl/password/syncId with a real open()/close() handshake
 * against a scratch dataDir, restoring process.env afterward regardless of
 * outcome.
 */
async function validateActualConnection(serverUrl, password, syncId) {
  const previous = {
    ACTUAL_SERVER_URL: process.env.ACTUAL_SERVER_URL,
    ACTUAL_PASSWORD: process.env.ACTUAL_PASSWORD,
    ACTUAL_SYNC_ID: process.env.ACTUAL_SYNC_ID,
  };
  process.env.ACTUAL_SERVER_URL = serverUrl;
  process.env.ACTUAL_PASSWORD = password;
  process.env.ACTUAL_SYNC_ID = syncId;

  const scratchDir = path.join(os.tmpdir(), `actual-panel-validate-${crypto.randomBytes(8).toString('hex')}`);
  let handle;
  try {
    handle = await actual.open(scratchDir);
    await actual.close(handle);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    process.env.ACTUAL_SERVER_URL = previous.ACTUAL_SERVER_URL;
    process.env.ACTUAL_PASSWORD = previous.ACTUAL_PASSWORD;
    process.env.ACTUAL_SYNC_ID = previous.ACTUAL_SYNC_ID;
    try {
      await fs.promises.rm(scratchDir, { recursive: true, force: true });
    } catch (_) {
      // best-effort cleanup; a leftover scratch dir under /tmp is harmless
    }
  }
}

function register(router, ctx) {
  const { requireSession, parseBody, sendHtml, redirect } = ctx;

  router.get('/actual', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      sendHtml(res2, 200, render(currentSettings()));
    });
  });

  router.post('/actual', (req, res) => {
    requireSession(req, res, async (req2, res2) => {
      const body = await parseBody(req2);
      const existing = currentSettings();

      const serverUrl = typeof body.server_url === 'string' ? body.server_url.trim() : '';
      const syncId = typeof body.sync_id === 'string' ? body.sync_id.trim() : '';
      const submittedPassword = typeof body.password === 'string' ? body.password.trim() : '';
      const password = submittedPassword || existing.password;

      const reject = (error) => {
        sendHtml(res2, 400, render({ serverUrl, syncId, password, error }));
      };

      if (!serverUrl) {
        reject('Actual Budget server URL is required.');
        return;
      }
      if (!syncId) {
        reject('Actual Budget sync id is required.');
        return;
      }
      if (!password) {
        reject('Actual Budget password is required.');
        return;
      }

      const result = await validateActualConnection(serverUrl, password, syncId);
      if (!result.ok) {
        reject(`Actual Budget connection failed: ${result.error}`);
        return;
      }

      envSetMany({
        ACTUAL_SERVER_URL: serverUrl,
        ACTUAL_SYNC_ID: syncId,
        ACTUAL_PASSWORD: password,
      });
      log('info', 'panel', 'actual budget connection updated', {
        server_url: serverUrl,
        sync_id: syncId,
      });
      redirect(res2, '/actual');
    });
  });
}

module.exports = { register };
