'use strict';

/**
 * Interactive-notification listener (design §3.2/§3.4).
 *
 * Long-poll loop over getUpdates({ allowed_updates: ['callback_query'] })
 * with a durable poll offset in the shared store (kv table) and exponential
 * backoff on errors. Each callback is dispatched through handleUpdate:
 *
 *   1. parse callback_data  v1:<itemRef>:<actionRef>
 *   2. resolve the interaction row (SQLite only — fast)
 *   3. fast status handling: duplicate / expired / claim (guarded UPDATE)
 *   4. EXACTLY ONE answerCallbackQuery per callback, ALWAYS before any
 *      slow Actual API work ("early" = after the sub-ms SQLite claim)
 *   5. for a won claim: ACTION_REGISTRY[<action_kind>](fresh row), then
 *      confirm/fail back via editMessageText (never a 2nd answerCallback).
 *
 * Store: same DATA_DIR as the cron process — that is the point of the
 * shared SQLite file. One listener process per deployment (compose).
 *
 * Exports { handleUpdate, main }; `node src/listender.js` (i.e. when run
 * directly) starts the loop. `handleUpdate(db, update)` is consumed by
 * the offline replay driver (src/dev/replay-callback.js) without network.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// NO override: the compose environment is authoritative for this service.
dotenv.config();

const store = require('./store');
const actual = require('./actual');
const bot = require('./telegram/bot');
const send = require('./telegram/send');
const { log } = require('./log');
const { ACTION_REGISTRY } = require('./actions');

const POLL_TIMEOUT_SEC = 30;
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30000;

// Panel-editable Telegram settings (specs/001-config-webapp FR-007): re-read
// on every poll iteration so a config-panel save applies within one cycle,
// with no restart. bot.js's apiUrl() already reads TELEGRAM_BOT_TOKEN from
// process.env per call, so refreshing it here is enough for token changes;
// TELEGRAM_GROUP_ID/TELEGRAM_CATEGORIES aren't consumed by this loop today
// but are kept in sync for consistency and any future in-process use.
const RELOADABLE_TELEGRAM_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_GROUP_ID', 'TELEGRAM_CATEGORIES', 'TELEGRAM_POLL_TIMEOUT'];

/**
 * Re-read only the 4 keys above straight from .env into process.env.
 * Deliberately NOT dotenv.config({override:true}): that would reload every
 * key (ACTUAL_*, DATA_DIR...) each iteration, disturbing unrelated listener
 * behavior. A missing/unreadable .env is tolerated — process.env keeps
 * whatever it already had.
 */
function reloadTelegramEnv() {
  let text;
  try {
    text = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  } catch {
    return;
  }
  for (const key of RELOADABLE_TELEGRAM_KEYS) {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    if (m) process.env[key] = m[1].replace(/\r$/, '');
  }
}

/**
 * Module-scoped store handle. main() opens it at boot via setDb(); the
 * offline replay driver (src/dev/replay-callback.js) may install its own,
 * and getDb() opens one lazily when neither has run.
 */
let dbHandle = null;
function setDb(db) {
  dbHandle = db;
}
function getDb() {
  if (!dbHandle) dbHandle = store.open();
  return dbHandle;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse callback_data `v1:<itemRef>:<actionRef>`.
 * itemRef is a base36 id (alnum); actionRef is a category index or '-'.
 * Returns { itemRef, actionRef } or null when malformed.
 */
function parseCallbackData(data) {
  if (typeof data !== 'string') return null;
  const m = /^v1:([0-9a-zA-Z]+):([0-9]+|-)$/.exec(data);
  return m ? { itemRef: m[1], actionRef: m[2] } : null;
}

/** Single answerCallbackQuery per callback; failures are logged, not thrown. */
async function ack(callbackQueryId, text) {
  try {
    await bot.answerCallbackQuery(callbackQueryId, text, true);
  } catch (err) {
    log('error', 'listener', 'answerCallbackQuery failed', {
      err: err.message,
    });
  }
}

/** Map a callback identity to the answers-log shape ({user_id, username, callback_id}). */
function answerer(cb, from) {
  return {
    user_id: from.id != null ? from.id : null,
    username: from.username || null,
    callback_id: cb.id,
  };
}

/**
 * Confirmation / failure texts (design §4.4). Reuses the stored per-tx
 * header via buildExpiryText and formatImporte through it. The HH:MM
 * comes from the stored answered_at (UTC, written by claimAnswer).
 */
function buildResultText(row, result) {
  const base = send.buildExpiryText(row);
  const hhmm =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(row.answered_at || '')
      ? row.answered_at.slice(11, 16)
      : new Date().toTimeString().slice(0, 5);

  if (result.detail === 'dismissed') {
    return `${base}\n\n✅ → Sin categorizar (dejado pendiente)`;
  }
  const who = row.answered_by_name ? `@${row.answered_by_name}` : 'anónimo';
  return `${base}\n\n✅ → ${result.label}\nRespondido por ${who} · ${hhmm}`;
}

/**
 * Handle one update { update_id, callback_query }.
 *
 * Uses the module-scoped store handle (set by main()/setDb, or opened
 * lazily for the offline replay driver). Never throws: all per-update
 * errors are logged so the poll loop continues.
 */
async function handleUpdate(u) {
  const db = getDb();
  const cb = u && u.callback_query;
  if (!cb || !cb.id) return;
  const from = cb.from || {};

  // 1. Malformed callback_data → reject immediately.
  const parsed = parseCallbackData(cb.data);
  if (!parsed) {
    log('error', 'listener', 'Malformed callback_data', { data: cb.data });
    await ack(cb.id, '❌ Comando inválido');
    return;
  }

  // 2. Resolve the interaction (SQLite only).
  const row = store.findInteractionByItemRef(db, parsed.itemRef);
  const who = answerer(cb, from);
  if (!row) {
    await ack(cb.id, '❌ Desconocido (el botón ya no es válido)');
    return;
  }

  // 3. Fast status handling (SQLite only, sub-ms).
  let claimRow = null;
  if (row.status === 'answered') {
    store.logAnswer(db, row.id, who, 'duplicate', 'already answered');
    await ack(cb.id, `⚠️ Ya respondido por ${row.answered_by_name}`);
    return;
  }
  if (row.status === 'expired') {
    store.logAnswer(db, row.id, who, 'expired', 'report expired');
    await ack(cb.id, '⌛ Reporte expirado');
    return;
  }

  // status === 'pending' → guarded claim (design §3.4).
  const claim = store.claimAnswer(db, row.id, who.user_id, who.username, parsed.actionRef);
  if (!claim.won) {
    // The loser sees the winner's row (re-read after the guarded UPDATE).
    store.logAnswer(db, row.id, who, 'duplicate', `lost claim to ${claim.row.answered_by_name}`);
    await ack(cb.id, `⚠️ Ya respondido por ${claim.row.answered_by_name}`);
    return;
  }
  claimRow = claim.row;

  // TRUST RULE §4.1: validate the tapped ref against the STORED button
  // rows — never trust the callback payload beyond ref identity.
  let buttons;
  try {
    buttons = JSON.parse(claimRow.button_rows_json);
  } catch {
    buttons = [];
  }
  const tapped = (buttons || []).flat().find((b) => b.ref === parsed.actionRef);
  if (!tapped) {
    log('error', 'listener', 'Unknown button ref claimed', {
      item_ref: parsed.itemRef,
      actionRef: parsed.actionRef,
    });
    store.logAnswer(db, claimRow.id, who, 'rejected', `unknown ref ${parsed.actionRef}`);
    // Keep the retry surface alive: roll back so a valid button still works.
    store.rollbackToPending(db, claimRow.id, `rejected unknown ref ${parsed.actionRef}`);
    await ack(cb.id, '❌ Botón no válido');
    return;
  }

  // 4. The ONE ack for this callback — after the fast SQLite phase, BEFORE
  //    any slow Actual API lifecycle work.
  await ack(cb.id, '⏳ Procesando…');

  // 5. Slow phase: action + message edit. Own try/catch; any unexpected
  //    error rolls a won claim back to pending so the user can retry.
  try {
    const handler = ACTION_REGISTRY[claimRow.action_kind || 'categorize'];
    if (!handler) throw new Error(`no action handler for '${claimRow.action_kind}'`);

    const result = await handler(claimRow);

    if (result.detail === 'applied' || result.detail === 'dismissed') {
      const fresh = store.getInteraction(db, claimRow.id);
      store.logAnswer(db, claimRow.id, who, 'applied', result.detail);
      // Dry-run tolerance: tg_message_id === -1 is still edited as-is
      // (dry-run bot logs it); no special-casing.
      await bot.editMessageText(
        claimRow.tg_chat_id,
        claimRow.tg_message_id,
        buildResultText(fresh || claimRow, result),
      );
      log('info', 'listener', 'Callback applied', {
        item_ref: parsed.itemRef,
        detail: result.detail,
      });
    } else if (result.retryable) {
      // The action already rolled the row back to pending on write-back
      // failure; surface the warning in the edited message only (the single
      // answerCallbackQuery above is the only ack for this callback).
      store.logAnswer(db, claimRow.id, who, 'failed', result.error || 'write-back failed');
      await bot.editMessageText(
        claimRow.tg_chat_id,
        claimRow.tg_message_id,
        `${send.buildExpiryText(claimRow)}\n\n⚠️ No se pudo guardar en Actual: ${result.error}\nPulsa de nuevo para reintentar.`,
      );
      log('warn', 'listener', 'Callback failed, back to pending', {
        item_ref: parsed.itemRef,
        err: result.error,
      });
    } else {
      store.logAnswer(db, claimRow.id, who, 'failed', result.error || 'non-retryable failure');
      log('error', 'listener', 'Callback failed (non-retryable)', {
        item_ref: parsed.itemRef,
        err: result.error,
      });
    }
  } catch (err) {
    log('error', 'listener', 'Unexpected error handling callback', {
      item_ref: parsed.itemRef,
      err: err.message,
    });
    store.rollbackToPending(db, claimRow.id, `unexpected: ${err.message}`);
    store.logAnswer(db, claimRow.id, who, 'failed', `unexpected: ${err.message}`);
  }
}

/**
 * Long-poll main loop (design §3.2):
 *  - offset persisted in kv('poll_offset') AFTER each batch is processed;
 *  - empty batch resets backoff; getUpdates errors double backoff (cap 30 s);
 *  - per-update try/catch so one bad callback never stalls the loop.
 */
async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.ACTUAL_SERVER_URL) {
    log('error', 'listener', 'TELEGRAM_BOT_TOKEN/ACTUAL_SERVER_URL missing; listener cannot run');
    process.exit(1);
  }

  // Module-scoped store handle: main() opens it at boot; the offline replay
  // driver can also set it via setDb(), or handleUpdate opens one lazily.
  const db = store.open();
  setDb(db);

  let stopped = false;
  const onSignal = (sig) => {
    if (stopped) return;
    stopped = true;
    log('info', 'listener', `Shutting down (${sig})`);
    try {
      store.close(db);
    } catch (err) {
      log('error', 'listener', 'Error closing store', { err: err.message });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  log('info', 'listener', 'Listener started', {
    offset: Number(store.kvGet(db, 'poll_offset') || 0),
  });

  let backoff = BACKOFF_INITIAL_MS;
  for (;;) {
    if (stopped) return;
    reloadTelegramEnv();
    const offset = Number(store.kvGet(db, 'poll_offset') || 0);
    const pollTimeoutSec = Number(process.env.TELEGRAM_POLL_TIMEOUT) || POLL_TIMEOUT_SEC;
    let updates;
    try {
      updates = await bot.getUpdates({
        offset,
        timeout: pollTimeoutSec,
        allowed_updates: ['callback_query'],
      });
    } catch (err) {
      log('error', 'listener', 'getUpdates error', { err: err.message, backoff });
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      await sleep(backoff);
      continue;
    }
    backoff = BACKOFF_INITIAL_MS;

    if (!Array.isArray(updates) || updates.length === 0) continue;

    let maxSeen = offset;
    for (const u of updates) {
      try {
        await handleUpdate(u);
      } catch (err) {
        log('error', 'listener', 'Update handling error', {
          update_id: u && u.update_id,
          err: err.message,
        });
      }
      if (u && typeof u.update_id === 'number' && u.update_id > maxSeen) {
        maxSeen = u.update_id;
      }
    }
    // Persist the offset only AFTER the whole batch has been processed.
    if (maxSeen >= offset) {
      store.kvSet(db, 'poll_offset', String(maxSeen + 1));
    }
  }
}

module.exports = { handleUpdate, main };

if (require.main === module) {
  main().catch((err) => {
    log('error', 'listener', 'Listener crashed', { err: err.message });
    process.exit(1);
  });
}
