'use strict';

/**
 * GET/POST /recipients (US3, FR-011).
 *
 * NOTIFICATION_EMAIL is a comma-separated list; each entry must be a
 * syntactically plausible email address (simple regex, not full RFC-5322)
 * and at least one is required before persisting (data-model.md).
 */

const fs = require('fs');
const path = require('path');

const { log } = require('../../log');
const { envGet, envSetMany } = require('../config-store');

const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'recipients.html');

// Simple, not RFC-5322-complete — good enough to catch typos (data-model.md).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function currentRecipients() {
  return envGet('NOTIFICATION_EMAIL') || '';
}

function render({ recipients, error }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const errorHtml = error ? `<p style="color:red">${escapeHtml(error)}</p>` : '';
  return template
    .replace('{{errorHtml}}', errorHtml)
    .replace('{{recipients}}', escapeHtml(recipients));
}

function register(router, ctx) {
  const { requireSession, parseBody, sendHtml, redirect } = ctx;

  router.get('/recipients', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      sendHtml(res2, 200, render({ recipients: currentRecipients() }));
    });
  });

  router.post('/recipients', (req, res) => {
    requireSession(req, res, async (req2, res2) => {
      const body = await parseBody(req2);
      const raw = typeof body.recipients === 'string' ? body.recipients : '';

      const reject = (error) => {
        sendHtml(res2, 400, render({ recipients: raw, error }));
      };

      const entries = raw.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
      if (entries.length === 0) {
        reject('At least one recipient email address is required.');
        return;
      }
      const invalid = entries.filter((e) => !EMAIL_RE.test(e));
      if (invalid.length > 0) {
        reject(`Not a valid email address: ${invalid.join(', ')}`);
        return;
      }

      const normalized = entries.join(',');
      envSetMany({ NOTIFICATION_EMAIL: normalized });
      log('info', 'panel', 'recipients updated', { count: entries.length });
      redirect(res2, '/recipients');
    });
  });
}

module.exports = { register };
