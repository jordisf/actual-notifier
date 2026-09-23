'use strict';

/**
 * GET/POST /telegram (US2, FR-006/FR-007/FR-008/FR-012).
 *
 * Bot token is never rendered in full here — only masked, with a "Show"
 * control wired to POST /reveal/telegram-bot-token (routes/reveal.js).
 * The bot-token input starts empty by design (never pre-filled with the
 * secret); submitting it blank means "keep the currently stored token".
 */

const fs = require('fs');
const path = require('path');

const { log } = require('../../log');
const { envGet, envSetMany } = require('../config-store');
const bot = require('../../telegram/bot');

const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'telegram.html');

const MIN_POLL_TIMEOUT = 1;
const MAX_POLL_TIMEOUT = 300;

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
    botToken: envGet('TELEGRAM_BOT_TOKEN') || '',
    groupId: envGet('TELEGRAM_GROUP_ID') || '',
    categories: envGet('TELEGRAM_CATEGORIES') || '',
    pollTimeout: envGet('TELEGRAM_POLL_TIMEOUT') || '30',
  };
}

function render({ botToken, groupId, categories, pollTimeout, error }) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const errorHtml = error ? `<p style="color:red">${escapeHtml(error)}</p>` : '';
  return template
    .replace('{{errorHtml}}', errorHtml)
    .replace('{{maskedToken}}', escapeHtml(maskSecret(botToken)))
    .replace('{{groupId}}', escapeHtml(groupId))
    .replace('{{categories}}', escapeHtml(categories))
    .replace('{{pollTimeout}}', escapeHtml(pollTimeout));
}

/**
 * Validate a candidate token/group id against the real Telegram Bot API,
 * reusing bot.js's generic request() — no new Telegram client (FR-008).
 * TELEGRAM_DRY_RUN is honored automatically: bot.js's own isDryRun() check
 * inside request() short-circuits both calls into a fake-but-valid result.
 * bot.js has no parameterized-token entry point (apiUrl() always reads
 * process.env.TELEGRAM_BOT_TOKEN), so the candidate token is swapped in
 * for the duration of this call only, then restored in `finally`.
 */
async function validateTelegramCredentials(token, groupId) {
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = token;
  try {
    await bot.request('getMe');
    await bot.request('getChat', { chat_id: groupId });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = previousToken;
  }
}

function register(router, ctx) {
  const { requireSession, parseBody, sendHtml, redirect } = ctx;

  router.get('/telegram', (req, res) => {
    requireSession(req, res, (req2, res2) => {
      sendHtml(res2, 200, render(currentSettings()));
    });
  });

  router.post('/telegram', (req, res) => {
    requireSession(req, res, async (req2, res2) => {
      const body = await parseBody(req2);
      const existing = currentSettings();

      const clear = body.clear_telegram === 'on';
      const submittedToken = typeof body.bot_token === 'string' ? body.bot_token.trim() : '';
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      const categories = typeof body.categories === 'string' ? body.categories.trim() : '';
      const pollTimeoutRaw = typeof body.poll_timeout === 'string' ? body.poll_timeout.trim() : '';
      const pollTimeout = Number(pollTimeoutRaw);

      const reject = (error) => {
        sendHtml(res2, 400, render({
          botToken: existing.botToken,
          groupId,
          categories,
          pollTimeout: pollTimeoutRaw || existing.pollTimeout,
          error,
        }));
      };

      if (!Number.isInteger(pollTimeout) || pollTimeout < MIN_POLL_TIMEOUT || pollTimeout > MAX_POLL_TIMEOUT) {
        reject(`Poll timeout must be a whole number between ${MIN_POLL_TIMEOUT} and ${MAX_POLL_TIMEOUT} seconds.`);
        return;
      }

      // Blank field = keep the current token (it is never pre-filled with the secret).
      let botToken = clear ? '' : (submittedToken || existing.botToken);
      let finalGroupId = clear ? '' : groupId;

      if (botToken && !finalGroupId) {
        reject('A group id is required when a bot token is set (or check "disable Telegram" to clear both).');
        return;
      }
      if (!botToken && finalGroupId) {
        reject('A bot token is required when a group id is set (or check "disable Telegram" to clear both).');
        return;
      }

      if (botToken) {
        const result = await validateTelegramCredentials(botToken, finalGroupId);
        if (!result.ok) {
          reject(`Telegram validation failed: ${result.error}`);
          return;
        }
      }

      envSetMany({
        TELEGRAM_BOT_TOKEN: botToken,
        TELEGRAM_GROUP_ID: finalGroupId,
        TELEGRAM_CATEGORIES: categories,
        TELEGRAM_POLL_TIMEOUT: String(pollTimeout),
      });
      log('info', 'panel', 'telegram settings updated', {
        group_id: finalGroupId || null,
        categories_count: categories ? categories.split(',').length : 0,
        poll_timeout: pollTimeout,
      });
      redirect(res2, '/telegram');
    });
  });
}

module.exports = { register };
