'use strict';

/**
 * Shared report pipeline (003-telegram-report-command, research R4).
 *
 * The Telegram tail of the daily report — store row, delivery, D6 expiry,
 * retention — plus the attachTxIds prep, extracted so the cron
 * (`reporte-diario.js`) and the on-demand listener command cannot drift
 * apart in what a report *contains* (spec FR-002).
 *
 * The cron's HTML/email construction (PASO 4-5) deliberately stays in
 * `reporte-diario.js` — email is its source of truth and its exit contract
 * (email failure ⇒ process exit 1) is untouched.
 */

const actual = require('./actual');
const store = require('./store');
const bot = require('./telegram/bot');
const send = require('./telegram/send');
const { log } = require('./log');

/**
 * T4: attach the Actual tx id + account id to each report tx row so the
 * Telegram layer can persist interaction rows (write-back target). A missing
 * row is tolerated (id stays null; that tx gets no interactive message but
 * remains visible in summary + email).
 */
async function attachTxIds(handle, txRows, mesActual) {
  if (!txRows || txRows.length === 0) return txRows || [];
  const [y, m] = mesActual.split('-');
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  const primerDia = `${mesActual}-01`;
  const ultimoDia = `${mesActual}-${String(lastDay).padStart(2, '0')}`;
  const matchKey = (fecha, beneficiario, importe) =>
    `${fecha}|${beneficiario}|${importe.toFixed(2)}`;

  const byKey = new Map(txRows.map((t) => [matchKey(t.fecha, t.beneficiario, t.importe), t]));
  const accounts = await handle.api.getAccounts();
  for (const account of accounts.filter((a) => !a.offbudget && !a.closed)) {
    try {
      const txs = await handle.api.getTransactions(account.id, primerDia, ultimoDia);
      for (const t of txs) {
        if (t.is_parent) continue;
        if (t.category != null && t.category !== '') continue; // keep only uncategorized
        if (t.transfer_id != null && t.transfer_id !== '') continue;
        const importe = (t.amount || 0) / 100;
        const row = byKey.get(matchKey(t.date, t.imported_payee || t.payee_name || 'Desconocido', importe));
        if (row) {
          row.id = t.id;
          row.account_id = account.id;
        }
      }
    } catch (errTx) {
      log('warn', 'cron', `No se pudieron leer transacciones de ${account.name}: ${errTx.message}`);
    }
  }
  return [...byKey.values()];
}

/**
 * Closed category list (config): TELEGRAM_CATEGORIES is a comma-separated
 * allow-list of category NAMES (portable across budgets; names are resolved
 * to ids per delivery). Empty/unset → offer every non-income category
 * (legacy behavior). Names that do not exist in this budget are dropped
 * with a warning, never a failure.
 */
function resolveAllowlistedCategories(allCategories) {
  const raw = (process.env.TELEGRAM_CATEGORIES || '').trim();
  if (raw === '') return { categories: allCategories, missing: [] };
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const byName = new Map(allCategories.map((c) => [String(c.name).trim().toLowerCase(), c]));
  const categories = [];
  const missing = [];
  for (const name of names) {
    const hit = byName.get(name.toLowerCase());
    if (hit) categories.push(hit);
    else missing.push(name);
  }
  return { categories, missing };
}

/**
 * Shared steps 6-9 (003 extraction): insert the `reports` row, deliver the
 * Telegram report, run D6 expiry with best-effort footer edits, and the
 * 90-day answers retention sweep.
 *
 * @param {object}  db           open SQLite handle (caller owns open/close)
 * @param {object}  p
 * @param {Array}   p.txList            attachTxIds output (possibly empty)
 * @param {string}  p.chatId            TELEGRAM_GROUP_ID
 * @param {Array}   p.allCategories     non-income categories (handle.api resolved)
 * @param {string}  p.mesActual         'YYYY-MM'
 * @param {boolean} p.syncOk            row's sync_ok flag
 * @param {string}  p.syncMensaje       report sync-status line
 * @param {Array}   p.datosConsumo      [{nombre, saldo, ritmoDiario}]
 * @param {Array}   p.categoriasNegativas [{nombre, saldo}]
 * @param {boolean} p.emailSent         row's email_sent flag (cron: true)
 * @param {string}  p.trigger           'cron' | 'telegram-command' (row trigger)
 * @param {boolean} p.skipWhenEmpty     when true and txList is empty, skip
 *                                      sending the full report (on-demand
 *                                      path — the caller sends its own brief
 *                                      acknowledgment instead, spec FR-007)
 * @param {string}  p.logTag            log tag for this channel
 * @returns {Promise<{reportId:number, delivered:boolean, sent:number, failed:number}>}
 */
async function runReport(db, p) {
  const {
    txList, chatId, allCategories, mesActual, syncOk, syncMensaje,
    datosConsumo, categoriasNegativas,
    emailSent = false, trigger = 'cron', skipWhenEmpty = false, logTag = 'cron',
  } = p;

  const reportId = store.insertReport(db, {
    run_at: new Date().toISOString(),
    sync_ok: syncOk,
    sync_message: syncMensaje,
    tx_uncategorized_count: txList.length,
    email_sent: emailSent ? 1 : 0,
    trigger,
  });

  let delivered = false;
  let sent = 0;
  let failed = 0;

  const empty = txList.length === 0;
  if (empty && skipWhenEmpty) {
    store.setReportTelegram(db, reportId, { telegram_summary_sent: 0, telegram_tx_sent: 0 });
    log('info', logTag, 'Reporte sin movimientos pendientes; solo ack breve (sin resumen)', { reportId });
  } else {
    try {
      const { categories, missing } = resolveAllowlistedCategories(allCategories);
      if (missing.length > 0) {
        log('warn', logTag, 'TELEGRAM_CATEGORIES: nombres no encontrados en el budget; omitidos', { missing });
      }
      const result = await send.sendReport({
        db,
        chatId,
        reportId,
        txList,
        categories,
        mesActual,
        syncMensaje,
        datosConsumo,
        categoriasNegativas,
      });
      store.setReportTelegram(db, reportId, {
        telegram_summary_sent: 1,
        telegram_tx_sent: result.sent,
      });
      delivered = true;
      sent = result.sent;
      failed = result.failed;
      log('info', logTag, 'Entrega Telegram completada', {
        reportId,
        sent: result.sent,
        failed: result.failed,
      });
    } catch (errTg) {
      store.setReportTelegram(db, reportId, { telegram_summary_sent: 0, telegram_tx_sent: 0 });
      log('error', logTag, 'Entrega Telegram fallida; el run sigue en verde (correo no afectado)', {
        error: errTg.message,
      });
    }
  }

  // -------------------------------------------------------------------------
  // D6 EXPIRY (design §9 step 1): flip prior pending rows, then a
  // best-effort Telegram footer edit per just-expired message.
  // -------------------------------------------------------------------------
  const justExpired = store.expirePreviousPending(db, reportId);
  if (justExpired.length > 0) {
    log('info', logTag, 'Interacciones previas expiradas', { count: justExpired.length, reportId });
  }
  for (const row of justExpired) {
    try {
      const text = send.buildExpiryText(row) + '\n⌛ Vencido por reporte nuevo';
      await bot.editMessageText(row.tg_chat_id, row.tg_message_id, text);
    } catch (errEdit) {
      log('warn', logTag, `No se pudo editar el mensaje expirado (item_ref ${row.item_ref})`, {
        error: errEdit.message,
      });
    }
  }

  // RETENTION — 90-day answers sweep, one pass.
  const purged = store.answersRetentionSweep(db);
  if (purged > 0) {
    log('info', logTag, 'Barrido de retención completado', { purged });
  }

  return { reportId, delivered, sent, failed };
}

module.exports = { attachTxIds, resolveAllowlistedCategories, runReport };
