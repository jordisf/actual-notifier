'use strict';

/**
 * GET/POST /smtp, POST /smtp/test (US3, FR-009/FR-012).
 *
 * POST /smtp never trusts an earlier /smtp/test call: it re-runs the exact
 * same test-send against the submitted values as part of the same request,
 * and only persists on a passing result (no session flag / AJAX handshake —
 * plain full-page form posts, per tasks.md T016).
 *
 * SMTP_PASS is never rendered in full — only masked, with a "Show" control
 * wired to POST /reveal/smtp-password (routes/reveal.js, T019).
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const { log } = require('../../log');
const { envGet, envSetMany } = require('../config-store');

const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'smtp.html');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskSecret(value) {
  if (!value) return '(not set)';
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

function currentSettings() {
  const port = envGet('SMTP_PORT') || '465';
  const rawSecure = envGet('SMTP_SECURE');
  // Mirrors src/reporte-diario.js's own defaulting: explicit SMTP_SECURE wins,
  // otherwise deduce from port 465.
  const secure = rawSecure !== null ? rawSecure === 'true' : Number(port) === 465;
  return {
    host: envGet('SMTP_HOST') || '',
    port,
    secure,
    user: envGet('SMTP_USER') || '',
    pass: envGet('SMTP_PASS') || '',
  };
}

function render({ host, port, secure, user, pass, error, notice }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const errorHtml = error ? `<p style="color:red">${escapeHtml(error)}</p>` : '';
  const noticeHtml = notice ? `<p style="color:green">${escapeHtml(notice)}</p>` : '';
  return template
    .replace('{{errorHtml}}', errorHtml)
    .replace('{{noticeHtml}}', noticeHtml)
    .replace('{{host}}', escapeHtml(host))
    .replace('{{port}}', escapeHtml(port))
    .replace('{{secureChecked}}', secure ? 'checked' : '')
    .replace('{{user}}', escapeHtml(user))
    .replace('{{maskedPass}}', escapeHtml(maskSecret(pass)));
}

/** Parse submitted form fields; blank password = keep the currently stored one. */
function parseSubmitted(body, existing) {
  const host = typeof body.smtp_host === 'string' ? body.smtp_host.trim() : '';
  const portRaw = typeof body.smtp_port === 'string' ? body.smtp_port.trim() : '';
  const port = Number(portRaw || existing.port);
  const secure = body.smtp_secure === 'on';
  const user = typeof body.smtp_user === 'string' ? body.smtp_user.trim() : '';
  const submittedPass = typeof body.smtp_pass === 'string' ? body.smtp_pass.trim() : '';
  const pass = submittedPass || existing.pass;
  return { host, port, portRaw, secure, user, pass };
}

function validate(values) {
  if (!values.host) return 'SMTP host is required.';
  if (!Number.isInteger(values.port) || values.port < 1 || values.port > 65535) {
    return 'SMTP port must be a whole number between 1 and 65535.';
  }
  if (!values.user) return 'SMTP user is required.';
  if (!values.pass) return 'SMTP password is required.';
  return null;
}

function buildTransporter(values) {
  return nodemailer.createTransport({
    host: values.host,
    port: values.port,
    secure: values.secure,
    auth: {
      user: values.user,
      pass: values.pass.replace(/\s+/g, ''),
    },
  });
}

/**
 * Send a clearly-marked test email using the submitted (not-yet-saved)
 * values, to a currently configured NOTIFICATION_EMAIL recipient, or the
 * submitted SMTP_USER as a fallback destination if none are configured yet.
 */
async function sendTestEmail(values) {
  const recipients = (envGet('NOTIFICATION_EMAIL') || '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const to = recipients[0] || values.user;
  if (!to) {
    throw new Error('No destination email available (configure a recipient, or provide an SMTP user as fallback).');
  }
  const transporter = buildTransporter(values);
  const info = await transporter.sendMail({
    from: `"actual-notifier panel" <${values.user}>`,
    to,
    subject: '[actual-notifier] SMTP configuration test',
    text: 'This is a test email sent from the actual-notifier configuration panel to verify SMTP settings.',
  });
  return { messageId: info.messageId, to };
}

function register(router, ctx) {
  const { requireSession, parseBody, sendHtml, redirect } = ctx;

  router.get('/smtp', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      sendHtml(res2, 200, render(currentSettings()));
    });
  });

  router.post('/smtp/test', (req, res) => {
    requireSession(req, res, async (req2, res2) => {
      const body = await parseBody(req2);
      const existing = currentSettings();
      const values = parseSubmitted(body, existing);

      const renderValues = { host: values.host, port: values.portRaw || String(values.port), secure: values.secure, user: values.user, pass: values.pass };

      const error = validate(values);
      if (error) {
        sendHtml(res2, 400, render(Object.assign({}, renderValues, { error })));
        return;
      }

      try {
        const result = await sendTestEmail(values);
        sendHtml(res2, 200, render(Object.assign({}, renderValues, {
          notice: `Test email sent to ${result.to} (id: ${result.messageId}). Settings not saved yet — click Save to persist.`,
        })));
      } catch (err) {
        sendHtml(res2, 400, render(Object.assign({}, renderValues, { error: `Test email failed: ${err.message}` })));
      }
    });
  });

  router.post('/smtp', (req, res) => {
    requireSession(req, res, async (req2, res2) => {
      const body = await parseBody(req2);
      const existing = currentSettings();
      const values = parseSubmitted(body, existing);

      const renderValues = { host: values.host, port: values.portRaw || String(values.port), secure: values.secure, user: values.user, pass: values.pass };

      const error = validate(values);
      if (error) {
        sendHtml(res2, 400, render(Object.assign({}, renderValues, { error })));
        return;
      }

      // POST /smtp never trusts a prior /smtp/test call: re-run the same
      // test-send against these exact submitted values before persisting.
      let testResult;
      try {
        testResult = await sendTestEmail(values);
      } catch (err) {
        sendHtml(res2, 400, render(Object.assign({}, renderValues, {
          error: `SMTP test failed, settings not saved: ${err.message}`,
        })));
        return;
      }

      envSetMany({
        SMTP_HOST: values.host,
        SMTP_PORT: String(values.port),
        SMTP_SECURE: values.secure ? 'true' : 'false',
        SMTP_USER: values.user,
        SMTP_PASS: values.pass,
      });
      log('info', 'panel', 'smtp settings updated', {
        host: values.host,
        port: values.port,
        secure: values.secure,
        user: values.user,
        test_message_id: testResult.messageId,
      });
      redirect(res2, '/smtp');
    });
  });
}

module.exports = { register };
