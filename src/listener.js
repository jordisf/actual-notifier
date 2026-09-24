'use strict';

/**
 * Interactive-notification listener (design §3.2/§3.4) + /report command
 * (003-telegram-report-command, contracts/commands.md).
 *
 * Long-poll loop over getUpdates({ allowed_updates: ['callback_query', 'message'] })
 * with a durable poll offset in the shared store (kv table) and exponential
 * backoff on errors. Callbacks are dispatched through handleUpdate; group
 * messages matching /report trigger runOnDemandReport (same pipeline as the
 * 20:00 cron: compute -> attachTxIds -> runReport with trigger 'telegram-command').
 * At boot (and whenever the bot token changes via .env) the /report entry is
 * registered in the client command menu via setMyCommands.
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
const { compute } = require('./report');
const { attachTxIds, runReport } = require('./reporte');
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
 * Handle one update { update_id, callback_query } or { update_id, message }.
 *
 * 003-telegram-report-command: `message` updates are routed to
 * handleMessage() which only recognizes the /report command in the
 * configured group — everything else is ignored silently (spec FR-008/FR-010).
 *
 * Uses the module-scoped store handle (set by main()/setDb, or opened
 * lazily for the offline replay driver). Never throws: all per-update
 * errors are logged so the poll loop continues.
 */
async function handleUpdate(u) {
  const db = getDb();

  const msg = u && u.message;
  if (msg && typeof msg.text === 'string') {
    await handleMessage(msg);
    return;
  }

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

// ===========================================================================
// /report group command (003-telegram-report-command, contracts/commands.md)
// ===========================================================================

/**
 * Recognition rule (contract §3): trimmed text must be exactly `/report` or
 * `/report@<botusername>`; the chat-id guard (contract §3/FR-010) is applied
 * separately in handleMessage. Deliberately does NOT depend on the bot
 * username being known (the listener does not call getMe).
 */
const REPORT_CMD_RE = /^\/report(@[A-Za-z0-9_]+)?\s*$/;

/**
 * In-process re-entrancy guard (research R8): flags on the promise of the
 * running report plus at most ONE queued follow-up (depth 1). A third
 * concurrent request is replied to but NOT queued. Process-local only — a
 * restart implies no report in flight (data-model.md).
 */
let reportInFlight = null;
let reportQueued = null; // { msg, resolve } | null
let registeredMenuToken = null; // token last used for a successful setMyCommands

/**
 * Test hook for the offline replay driver (src/dev/replay-report-cmd.js):
 * clears the in-process command queue so a scenario never inherits state from
 * a previous scenario in the same process. Production code never calls this.
 */
function resetReportCmdState() {
  reportInFlight = null;
  reportQueued = null;
}

/**
 * Test hook for the on-demand pipeline: artificial delay (ms) injected at
 * the start of each on-demand pipeline run, so the depth-1 queue behavior
 * can be exercised deterministically. Zero in production.
 */
let reportPipelineTestDelayMs = 0;
function setReportPipelineDelay(ms) {
  reportPipelineTestDelayMs = Number(ms) || 0;
}

/** Internal: the artificial pipeline delay, consumed once per on-demand run. */
async function maybeApplyPipelineDelay() {
  if (reportPipelineTestDelayMs > 0) {
    await new Promise((r) => setTimeout(r, reportPipelineTestDelayMs));
  }
}

async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  if (!REPORT_CMD_RE.test(text)) return; // free-form: ignore, no reply (FR-008)

  const group = (process.env.TELEGRAM_GROUP_ID || '').trim();
  if (!group || String(msg.chat.id) !== group) return; // not the group (FR-010)

  const from = msg.from || {};
  log('info', 'listener', '/report received', {
    chat_id: msg.chat.id,
    user_id: from.id != null ? from.id : null,
    username: from.username || null,
  });

  // Re-entrancy (R8): running + queued + this one → reply, do not queue.
  if (reportInFlight && reportQueued) {
    try {
      await bot.sendMessage(msg.chat.id, '⏳ Ya hay un reporte en curso; este no se procesará.');
    } catch (errMsg) {
      log('warn', 'listener', 'No se pudo responder al comando descartado', { err: errMsg.message });
    }
    log('info', 'listener', '/report dropped (queue full)', { chat_id: msg.chat.id });
    return;
  }

  // Send the immediate progress ack BEFORE any Actual work (research R5),
  // then hand off to the queue.
  let ackMessageId = null;
  try {
    const data = await bot.sendMessage(msg.chat.id, '⏳ Generando reporte…');
    ackMessageId = data && data.message_id != null ? data.message_id : null;
  } catch (errAck) {
    // The ack failed (token/group misconfig): still run the report — the
    // delivery itself will surface the failure in the group.
    log('warn', 'listener', 'No se pudo enviar el aviso de progreso; el reporte sigue', {
      err: errAck.message,
    });
  }

  const job = { msg, ackMessageId };
  if (!reportInFlight) {
    // Leader: start the pipeline first so its own turn can resolve at the end
    // of THIS job (not after the queue drains); the in-flight guard also
    // drains any queued follow-ups.
    const firstTurn = runOnDemandReport(job);
    reportInFlight = (async () => {
      try {
        await firstTurn;
        while (reportQueued) {
          const next = reportQueued;
          reportQueued = null;
          const resolveNext = next.resolve || (() => {});
          try {
            await runOnDemandReport(next);
          } catch (errNext) {
            log('error', 'listener', 'Reporte en cola falló', { err: errNext.message });
          } finally {
            resolveNext();
          }
        }
      } finally {
        reportInFlight = null;
      }
    })();
    return firstTurn;
  }
  // One already running: queue this one (depth 1) and wait for its turn.
  const jobDone = new Promise((resolve) => {
    reportQueued = { ...job, resolve };
  });
  return jobDone;
}

/**
 * The on-demand pipeline (contract §4): compute() current-state, attachTxIds,
 * the shared runReport tail (trigger 'telegram-command'), and the empty
 * acknowledgment (FR-007) or failure edit (contract §4 step 3).
 */
async function runOnDemandReport(job) {
  const { msg, ackMessageId } = job;
  const outcome = { tag: 'failed' };
  const chatId = String(msg.chat.id);
  // Test hook: deterministic delay so the depth-1 queue behavior is observable.
  await maybeApplyPipelineDelay();
  try {
    const handle = await actual.open();
    try {
      const reporte = await compute(handle);
      const {
        syncOk, syncMensaje, mesActual,
        transaccionesSinCategorizar, datosConsumo, categoriasNegativas,
      } = reporte;

      const txList = await attachTxIds(handle, transaccionesSinCategorizar, mesActual);
      const db = getDb();
      const allCategories = await actual.getCategories(handle.api);

      const empty = txList.length === 0;
      const result = await runReport(db, {
        txList,
        chatId,
        allCategories,
        mesActual,
        syncOk,
        syncMensaje,
        datosConsumo,
        categoriasNegativas,
        emailSent: false,
        trigger: 'telegram-command',
        skipWhenEmpty: true, // empty ⇒ ack edit instead of a full report (FR-007)
        logTag: 'listener',
      });

      // US3 (FR-007): brief acknowledgment when there is nothing to report.
      if (empty) {
        outcome.tag = 'empty';
        const ackText = '✅ Reporte procesado: no hay movimientos pendientes de categorizar y todo va al día.';
        if (ackMessageId != null) {
          try {
            await bot.editMessageText(chatId, ackMessageId, ackText);
          } catch (errEdit) {
            await bot.sendMessage(chatId, ackText);
          }
        } else {
          await bot.sendMessage(chatId, ackText);
        }
      } else {
        outcome.tag = result.delivered ? 'sent' : 'failed';
      }
    } finally {
      await actual.close(handle);
    }
  } catch (err) {
    outcome.tag = 'failed';
    log('error', 'listener', 'Reporte on-demand falló', { err: err.message });
    const failText = '❌ No se pudo generar el reporte (error interno).';
    if (ackMessageId != null) {
      try {
        await bot.editMessageText(chatId, ackMessageId, failText);
      } catch (errEdit) {
        try {
          await bot.sendMessage(chatId, failText);
        } catch (errSend) {
          log('error', 'listener', 'No se pudo notificar el fallo en el grupo', {
            err: errSend.message,
          });
        }
      }
    }
  }
  log('info', 'listener', '/report outcome', {
    chat_id: msg.chat.id,
    user_id: (msg.from || {}).id != null ? msg.from.id : null,
    outcome: outcome.tag,
  });
}

/**
 * Register the bot's command menu (003-telegram-report-command, R6/contract §1).
 * Idempotent: Telegram replaces the whole menu on each call. The bot username
 * isn't needed — the menu belongs to whichever token set TELEGRAM_BOT_TOKEN.
 * Registration failure is logged and does NOT stop the poll loop.
 */
async function ensureCommandMenu() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return;
  try {
    await bot.setMyCommands([
      { command: 'report', description: 'Generar el reporte ahora' },
    ]);
    registeredMenuToken = token;
    log('info', 'listener', 'Menú de comandos registrado (setMyCommands OK)');
  } catch (err) {
    log('warn', 'listener', 'No se pudo registrar el menú de comandos; se reintentará al cambiar el token o reiniciar', {
      err: err.message,
    });
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

  // Register the /report command menu before taking over polls (T012/R6).
  // Non-blocking: a failure here only logs; the loop re-tries on token change.
  await ensureCommandMenu();

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
    // Re-register the command menu if the bot token changed via .env (T012).
    if (
      (process.env.TELEGRAM_BOT_TOKEN || '').trim() &&
      process.env.TELEGRAM_BOT_TOKEN !== registeredMenuToken
    ) {
      await ensureCommandMenu();
    }
    const offset = Number(store.kvGet(db, 'poll_offset') || 0);
    const pollTimeoutSec = Number(process.env.TELEGRAM_POLL_TIMEOUT) || POLL_TIMEOUT_SEC;
    let updates;
    try {
      updates = await bot.getUpdates({
        offset,
        timeout: pollTimeoutSec,
        allowed_updates: ['callback_query', 'message'],
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

module.exports = { handleUpdate, main, setDb, resetReportCmdState, setReportPipelineDelay };

if (require.main === module) {
  main().catch((err) => {
    log('error', 'listener', 'Listener crashed', { err: err.message });
    process.exit(1);
  });
}