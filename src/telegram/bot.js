'use strict';

/**
 * Minimal Telegram Bot API client over Node 20 global fetch (design §3.1).
 *
 * Zero new runtime deps (P9): v1 needs exactly four endpoints
 * (sendMessage, answerCallbackQuery, editMessageText, getUpdates).
 *
 * TELEGRAM_DRY_RUN=true short-circuits every call: the would-be call is
 * logged and a fake-but-valid result is returned (sendMessage gets
 * message_id = -1, which flows into the store's tg_message_id column).
 */

const { log } = require('../log');

const API_BASE_DEFAULT = 'https://api.telegram.org';

function isDryRun() {
  return process.env.TELEGRAM_DRY_RUN === 'true';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiUrl(method) {
  const base = (process.env.TELEGRAM_API_BASE || API_BASE_DEFAULT).replace(/\/+$/, '');
  return `${base}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

/** Fake results so the dry-run path behaves like real API payloads. */
function dryResult(method, params) {
  if (method === 'sendMessage') {
    return { message_id: -1, chat: { id: params && params.chat_id } };
  }
  return true;
}

/** One POST to a Bot API method. 429 is reported retryable; other non-ok throw with body. */
async function callOnce(method, url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => null);
    const retryAfter = (body && body.parameters && body.parameters.retry_after) || 1;
    const err = new Error(`Telegram ${method} rate limited (HTTP 429)`);
    err.retryable = true;
    err.retryAfterMs = Number(retryAfter) * 1000;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Telegram ${method} failed: HTTP ${res.status} ${text}`.trim());
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (data && data.ok === false) {
    throw new Error(`Telegram ${method} failed: ${data.description || 'unknown error'}`);
  }
  return data;
}

/**
 * POST to one Bot API method and return its `result`.
 * HTTP 429: honors `parameters.retry_after`, waits once, retries once, then throws.
 * Non-ok responses throw with the API body text.
 * Exported for the long-poll listener (S4).
 */
async function request(method, params) {
  if (isDryRun()) {
    log('info', 'telegram', `DRY-RUN: ${method} no enviado (log only)`, { method });
    return dryResult(method, params);
  }
  const url = apiUrl(method);
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const data = await callOnce(method, url, params);
      return data && data.result !== undefined ? data.result : true;
    } catch (err) {
      lastError = err;
      if (err && err.retryable && attempt === 1) {
        log('warn', 'telegram', `429 rate limit; esperando ${err.retryAfterMs}ms y reintento único`, { method });
        await sleep(err.retryAfterMs);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/** Send a text message. `replyMarkup` is the inline keyboard object (optional);
 * `parseMode` (optional) is forwarded as parse_mode when set (e.g. 'HTML').
 */
async function sendMessage(chatId, text, replyMarkup, parseMode) {
  const params = { chat_id: chatId, text };
  if (replyMarkup) params.reply_markup = replyMarkup;
  if (parseMode) params.parse_mode = parseMode;
  return request('sendMessage', params);
}

/** Ack a callback query (spinner end + optional alert text). */
async function answerCallbackQuery(callbackQueryId, text, showAlert) {
  const params = { callback_query_id: callbackQueryId };
  if (text) params.text = text;
  if (showAlert) params.show_alert = true;
  return request('answerCallbackQuery', params);
}

/** Edit an outbot message's text (confirmation edits, expiry footer). */
async function editMessageText(chatId, messageId, text) {
  return request('editMessageText', { chat_id: chatId, message_id: messageId, text });
}

/** Long-poll for updates (used by the listener, S4). */
async function getUpdates(params) {
  return request('getUpdates', params || {});
}

module.exports = {
  request,
  sendMessage,
  answerCallbackQuery,
  editMessageText,
  getUpdates,
};
