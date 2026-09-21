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

const MAX_LABEL_CHARS = 97;
const MAX_CALLBACK_DATA_BYTES = 64;
const DISMISS = { ref: '-', cat_id: null, label: '🚫 Sin categorizar' };
const DEFAULT_MAX_TX = 15;

// Keyboard layout (mobile): two buttons share a row when the SUM of their
// label widths fits the row budget; a long label takes the whole row by
// itself. Telegram gives every button in a row an equal share of its width
// and centers the label, which is the closest the API allows to padded
// equal-width buttons. Emoji count double (visual width).
const ROW_CHAR_BUDGET = 36;

/** Visual label width: chars, with emoji/symbols counting as 2 units. */
function labelWidth(label) {
  const s = String(label || '');
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    w += cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) || cp === 0x200d || cp === 0xfe0f ? 2 : 1;
  }
  return w;
}

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
 * Layout: two category buttons share a row only when their combined label
 * width fits ROW_CHAR_BUDGET; otherwise each takes a full-width row. This
 * keeps short names side-by-side (centered in equal cells by Telegram) and
 * lets long names stretch to the full row width instead of being squashed.
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

  // Pack two-per-row where the combined width fits; singles otherwise.
  const rows = [];
  let i = 0;
  while (i < buttons.length) {
    if (i + 1 < buttons.length && labelWidth(buttons[i].label) + labelWidth(buttons[i + 1].label) <= ROW_CHAR_BUDGET) {
      rows.push([buttons[i], buttons[i + 1]]);
      i += 2;
    } else {
      rows.push([buttons[i]]);
      i += 1;
    }
  }
  // CI-3: the dismiss button always occupies its OWN final row, full width.
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

/** Compact bank-sync line for the summary (the email keeps the full message). */
function bankSyncLine(syncMensaje) {
  const texto = String(syncMensaje || '');
  const m = texto.match(/sincronizó hace (\d+) min/);
  if (m) return `omitida (hace ${m[1]} min, umbral 60)`;
  const h = texto.match(/completada con éxito a las ([01]\d|2[0-3]):(\d{2})/);
  if (h) return `sincronizado a las ${h[1]}:${h[2]}`;
  if (/No se pudo sincronizar/.test(texto)) return 'fallo de sincronización bancaria';
  return `estado desconocido`;
}

/** '0.50' (report.js toFixed) -> '0,50' for consistent es-ES display. */
function ritmoEs(ritmoDiario) {
  return Number(ritmoDiario).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** HTML-escape user-provided text (category names) for parse_mode=HTML. */
function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Telegram has no colored text, so negative amounts are marked with a red
 * triangle + bold (parse_mode=HTML):  🔻 −9,00 €. Non-negatives stay plain.
 */
function importeHtml(euros) {
  const plain = formatImporte(euros);
  return euros < 0 ? `🔻 <b>${plain}</b>` : plain;
}

/**
 * Value line indent for the two-line item layout: the amount starts well to
 * the right of the category-name start, below the emoji's right edge
 * (mobile fonts are proportional, so a roomy indent is the safe bet).
 */
const VALUE_INDENT = '        '; // 8 spaces

/**
 * Plain-text summary message (design §4.4 — informational, NO keyboard):
 * title, month, compact bank sync state, uncategorized count, and one
 * item per category for consumption balances and overspends. Subsections
 * are separated by blank lines. Every category item uses a fixed two
 * mobile-safe line: the name alone on the first line, the value indented
 * on the second, so a long category name can never cause a ragged wrap.
 * Negative amounts are highlighted (🔻 + bold) — the output is sent with
 * parse_mode=HTML, so category names are HTML-escaped.
 * Per-tx interactive messages are sent separately below this summary, so
 * the summary itself only carries the count.
 */
function buildSummaryText({ mesActual, syncMensaje, txList, datosConsumo, categoriasNegativas }) {
  const lines = [];
  lines.push(`📊 Reporte diario — ${mesLabel(mesActual)}`);
  lines.push('');
  lines.push(`🔄 Banco: ${bankSyncLine(syncMensaje)}`);
  lines.push('');
  lines.push(`🔍 Pendientes sin categorizar: ${txList.length}`);
  lines.push('');

  for (const c of datosConsumo || []) {
    lines.push(`🛒 ${htmlEscape(c.nombre)}`);
    lines.push(`${VALUE_INDENT}${importeHtml(c.saldo)} (${ritmoEs(c.ritmoDiario)} €/día)`);
  }
  if (datosConsumo && datosConsumo.length > 0) {
    lines.push('');
  }
  for (const cn of categoriasNegativas || []) {
    lines.push(`⚠️ Sobregasto: ${htmlEscape(cn.nombre)}`);
    lines.push(`${VALUE_INDENT}${importeHtml(cn.saldo)}`);
  }
  return lines.join('\n');
}

/** Per-tx interactive message text (design §4.4). index/total optional.
 * Layout (mobile-safe blocks, blank line between each):
 *   header / date · payee / Importe: X (cuenta) / "Toca la categoría:"
 */
function buildTxText(tx, index, total) {
  const head =
    index != null ? `🔍 ${index} de ${total} · Sin categorizar` : '🔍 Sin categorizar';
  return [
    head,
    '',
    `${formatDia(tx.fecha)} · ${tx.beneficiario}`,
    '',
    `Importe: ${formatImporte(tx.importe)} (${tx.cuenta})`,
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
    datosConsumo,
    categoriasNegativas,
  });
  // parse_mode: 'HTML' so negative amounts render bold. The builder escapes
  // every user-provided piece (category names), so the markup is ours only.
  await bot.sendMessage(chatId, summaryText, undefined, 'HTML');
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
