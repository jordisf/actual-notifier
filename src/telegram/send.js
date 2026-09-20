'use strict';

/**
 * Telegram report delivery (design §4/§7).
 *
 * Sends, synchronously from the cron process:
 *   1. one plain-text summary message (NO keyboard),
 *   2. one interactive message per uncategorized tx (cap:
 *      TELEGRAM_MAX_TX_MESSAGES, default 15, oldest first), each with an
 *      inline keyboard of category buttons + a dismiss row.
 *
 * Per tx (design §7 step 7b): the interaction row is inserted BEFORE the
 * send (so item_ref = base36(new id) is known for callback_data), then the
 * real tg_message_id is written back after a successful send. A failed send
 * DELETES the row again: the tx then appears only in the summary + email,
 * never silently invisible. A failed insert simply skips the tx.
 *
 * callback_data (design §4.1, <= 64 bytes):  v1:<itemRef>:[idx|-]
 *   idx = category index within the stored button rows,  "-" = dismiss.
 *
 * CI-3 (non-negotiable, tasks.md): the dismiss button (ref "-", label
 * "🚫 Sin categorizar") is FORCED onto its own final keyboard row, never
 * mixed with category buttons, regardless of row-fill state.
 *
 * Exported builders (buildKeyboard / buildSummaryText / buildTxText /
 * buildExpiryText) are reused by the replay helper and tests (T5/T7).
 */

const bot = require('./bot');
const store = require('../store');
const { log } = require('../log');

const MAX_BUTTONS_PER_ROW = 8;
const MAX_LABEL_CHARS = 97;
const MAX_CALLBACK_DATA_BYTES = 64;
const DISMISS = { ref: '-', cat_id: null, label: '🚫 Sin categorizar' };
const DEFAULT_MAX_TX = 15;

function truncateLabel(label) {
  const s = String(label || '');
  return s.length <= MAX_LABEL_CHARS ? s : `${s.slice(0, MAX_LABEL_CHARS)}…`;
}

function truncate(s, n) {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/**
 * Build the keyboard rows for one interaction.
 *
 * categories: [{ id, name }] (non-income, from actual.getCategories).
 * itemRef:    base36 interaction id (goes into callback_data).
 *
 * Returns { rows, keyboard }:
 *   rows     — storage form for button_rows_json:
 *              [[{ref, cat_id, label}, ...], ..., [{ref:'-', ...}]]
 *   keyboard — Telegram inline_keyboard payload (array of button arrays).
 */
function buildKeyboard(categories, itemRef) {
  const buttons = (categories || []).map((c, i) => ({
    ref: String(i),
    cat_id: c.id,
    label: truncateLabel(c.name),
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += MAX_BUTTONS_PER_ROW) {
    rows.push(buttons.slice(i, i + MAX_BUTTONS_PER_ROW));
  }
  // CI-3: the dismiss button always occupies its OWN final row.
  rows.push([{ ref: DISMISS.ref, cat_id: DISMISS.cat_id, label: DISMISS.label }]);

  const keyboard = rows.map((row) =>
    row.map((btn) => {
      const callback_data = `v1:${itemRef}:${btn.ref}`;
      if (Buffer.byteLength(callback_data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
        throw new Error(`callback_data exceeds ${MAX_CALLBACK_DATA_BYTES} bytes: ${callback_data}`);
      }
      return { text: btn.label, callback_data };
    }),
  );
  return { rows, keyboard };
}

/** '2026-09-20' -> '20/09' */
function formatDia(dateStr) {
  return `${String(dateStr).slice(8, 10)}/${String(dateStr).slice(5, 7)}`;
}

/** euros number -> '−34,20 €' (U+2212 for negatives). */
function formatImporte(euros) {
  const sign = euros < 0 ? '−' : '';
  return `${sign}${Math.abs(euros).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/** 'YYYY-MM' -> '20/09/2026' */
function mesLabel(mesActual) {
  const d = new Date(`${mesActual}-01T12:00:00`);
  return d.toLocaleDateString('es-ES');
}

/**
 * Plain-text summary message (design §4.4 — informational, NO keyboard):
 * title, month, bank sync state, uncategorized count + tx list
 * (date · payee · amount · account), consumption and overspend lines.
 * When the per-tx cap is hit, the omitted count is noted here.
 */
function buildSummaryText({ mesActual, syncMensaje, txList, capped, datosConsumo, categoriasNegativas }) {
  const lines = [];
  lines.push(`📊 Reporte diario — ${mesLabel(mesActual)}`);
  lines.push(`🔄 Banco: ${truncate(syncMensaje || 'estado desconocido', 120)}`);

  const total = txList.length;
  const omitted = total - capped.length;
  if (total > 0) {
    const botonNota = omitted > 0 ? ` → ${capped.length} mensajes con botones (${omitted} omitidos, solo en este resumen)` : ` → ${capped.length} mensaje${capped.length === 1 ? '' : 's'} debajo con botones`;
    lines.push(`🔍 Pendientes sin categorizar: ${total}${botonNota}`);
    for (const tx of capped) {
      lines.push(`   ${formatDia(tx.fecha)} · ${tx.beneficiario} (${formatImporte(tx.importe)}) · ${tx.cuenta}`);
    }
    if (omitted > 0) {
      for (const tx of txList.slice(capped.length)) {
        lines.push(`   ${formatDia(tx.fecha)} · ${tx.beneficiario} (${formatImporte(tx.importe)}) · ${tx.cuenta} — sin botones`);
      }
    }
  } else {
    lines.push('🔍 Pendientes sin categorizar: 0');
  }

  for (const c of datosConsumo || []) {
    lines.push(`🛒 ${c.nombre}: ${formatImporte(c.saldo)} (${c.ritmoDiario} €/día)`);
  }
  for (const cn of categoriasNegativas || []) {
    lines.push(`⚠️ Sobregasto: ${cn.nombre} ${formatImporte(cn.saldo)}`);
  }
  return lines.join('\n');
}

/** Per-tx interactive message text (design §4.4). index/total optional. */
function buildTxText(tx, index, total) {
  const head =
    index != null ? `🔍 ${index} de ${total} · Sin categorizar` : '🔍 Sin categorizar';
  return [
    head,
    `${formatDia(tx.fecha)} · ${tx.beneficiario} (${tx.cuenta})`,
    `Importe: ${formatImporte(tx.importe)}`,
    '',
    'Toca la categoría:',
  ].join('\n');
}

/**
 * Rebuild a per-tx message text from a stored interactions row (used by the
 * expiry footer pass in reporte-diario.js — best-effort cosmetics only).
 * The delivery-time "N de M" position is not stored, so it is omitted here.
 */
function buildExpiryText(row) {
  return buildTxText(
    {
      fecha: row.tx_date,
      beneficiario: row.payee,
      cuenta: row.account_name,
      importe: (row.amount_cents || 0) / 100,
    },
    undefined,
  );
}

/**
 * Deliver the full Telegram report for one cron run.
 *
 * opts: {
 *   db,           — opened store handle (src/store.js)
 *   chatId,       — TELEGRAM_GROUP_ID
 *   reportId,     — numeric id of the reports row for this run
 *   txList,       — getUncategorizedTxs rows: {id, account_id, cuenta, fecha, beneficiario, importe}
 *   categories,   — getCategories rows: {id, name} (non-income)
 *   mesActual,    — 'YYYY-MM' (from the report)
 *   syncMensaje,  — bank sync status line
 *   datosConsumo, — [{nombre, saldo, ritmoDiario}]
 *   categoriasNegativas — [{nombre, saldo}]
 * }
 *
 * Returns { reportId, sent, failed } (sent/failed count interactive tx messages;
 * a summary failure throws and is contained by the caller).
 */
async function sendReport({ db, chatId, reportId, txList, categories, mesActual, syncMensaje, datosConsumo, categoriasNegativas }) {
  const cap = Math.max(1, parseInt(process.env.TELEGRAM_MAX_TX_MESSAGES || String(DEFAULT_MAX_TX), 10) || DEFAULT_MAX_TX);
  const sorted = [...txList].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  const capped = sorted.slice(0, cap);
  const omitted = sorted.length - capped.length;

  // 1. Summary message (no keyboard). A failure here throws — the whole
  //    Telegram block is contained by the caller (email already went out).
  const summaryText = buildSummaryText({
    mesActual,
    syncMensaje,
    txList: sorted,
    capped,
    datosConsumo,
    categoriasNegativas,
  });
  await bot.sendMessage(chatId, summaryText);
  log('info', 'cron', 'Resumen Telegram enviado (sin botones)', { omitted });

  let sent = 0;
  let failed = 0;

  // 1b. No categories resolved (TELEGRAM_CATEGORIES allow-list matched
  //     nothing in this budget): deliver the summary only — an interactive
  //     message with no category buttons has no purpose. Summary above
  //     still went out, and the email always has the full tx list.
  if (!categories || categories.length === 0) {
    log('warn', 'cron', 'Sin categorías para ofrecer; solo se envió el resumen (teclado vacío)');
    return { reportId, sent: 0, failed: 0 };
  }

  // 2. One interactive message per tx (oldest first, capped).
  for (let i = 0; i < capped.length; i += 1) {
    const tx = capped[i];

    // 2a. Insert first so item_ref (base36 id) exists for callback_data.
    let id;
    try {
      id = store.insertInteraction(db, {
        report_id: reportId,
        actual_tx_id: tx.id,
        account_id: tx.account_id || null,
        account_name: tx.cuenta,
        tx_date: tx.fecha,
        payee: tx.beneficiario,
        amount_cents: Math.round(tx.importe * 100),
        button_rows_json: '[]', // real rows written right after the send
        tg_chat_id: Number(chatId),
        tg_message_id: -1, // placeholder until the send succeeds
      });
    } catch (errInsert) {
      failed += 1;
      log('error', 'cron', `No se pudo guardar la interacción; mensaje omitido (visible en resumen y correo)`, {
        tx: tx.beneficiario,
        error: errInsert.message,
      });
      continue;
    }

    const itemRef = store.base36(id);
    const { rows, keyboard } = buildKeyboard(categories, itemRef);
    const text = buildTxText(tx, i + 1, capped.length);

    try {
      // 2b. Send, then pin the real message id + button rows.
      const data = await bot.sendMessage(chatId, text, { inline_keyboard: keyboard });
      store.setInteractionDelivery(db, id, {
        tg_message_id: data.message_id,
        button_rows_json: JSON.stringify(rows),
      });
      sent += 1;
      log('info', 'cron', 'Mensaje interactivo enviado', {
        item_ref: itemRef,
        tx: tx.beneficiario,
        tg_message_id: data.message_id,
      });
    } catch (errSend) {
      // 2c. Send failed: remove the orphan row so the store stays truthful.
      try {
        store.deleteInteraction(db, id);
      } catch (errDelete) {
        log('warn', 'cron', `Fallo al limpiar interacción huérfana (id=${id})`, { error: errDelete.message });
      }
      failed += 1;
      log('error', 'cron', `Envío interacción falló; mensaje omitido (visible en resumen y correo)`, {
        item_ref: itemRef,
        tx: tx.beneficiario,
        error: errSend.message,
      });
    }
  }

  return { reportId, sent, failed };
}

module.exports = {
  buildKeyboard,
  buildSummaryText,
  buildTxText,
  buildExpiryText,
  sendReport,
  formatImporte,
};
