'use strict';

/**
 * Offline callback replay driver (design §3.4 / §12A targets).
 *
 * Replays a synthetic callback_query through the SAME handleUpdate path
 * the live listener uses — no Telegram network calls are made:
 * handleUpdate answers the callback against the (dry-run) bot module and
 * edits the stored message id (which dry-run logs instead of sending).
 *
 * WARNING: with a real category ref the categorize action calls the REAL
 * dev Actual API (applyCategoryChange) and writes on the shared store.
 * Use only against the dev deployment. --dismiss / '-' is fully offline
 * (no Actual call, no network at all).
 *
 * Usage (DATA_DIR must point at the notifier db):
 *   node src/dev/replay-callback.js [--item-ref=<ref>] [--status=pending]
 *                                   [--ref=<idx|-] | --dismiss]
 *
 * Picks the first matching interaction, replays it, then prints the row's
 * resulting status/answer_detail plus the tail of its answers log.
 */

const path = require('path');

// Load .env like the other entrypoints (DATA_DIR etc.), no override.
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const store = require('../store');
const { log } = require('../log');
const { handleUpdate } = require('../listener');

function parseArgs(argv) {
  const opts = { itemRef: null, status: null, chosenRef: null, dismiss: false };
  for (const arg of argv) {
    if (arg.startsWith('--item-ref=')) opts.itemRef = arg.slice('--item-ref='.length);
    else if (arg.startsWith('--status=')) opts.status = arg.slice('--status='.length);
    else if (arg.startsWith('--ref=')) opts.chosenRef = arg.slice('--ref='.length);
    else if (arg === '--dismiss') opts.dismiss = true;
  }
  return opts;
}

function flattenButtons(row) {
  try {
    return JSON.parse(row.button_rows_json || '[]').flat();
  } catch {
    return [];
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = store.open();
  try {
    // 1. Find candidate interaction(s).
    const stmt = db.prepare(
      `SELECT * FROM interactions
       WHERE 1=1
         AND (? IS NULL OR item_ref = ?)
         AND (? IS NULL OR status = ?)
       ORDER BY id DESC`,
    );
    const found = stmt.all(opts.itemRef, opts.itemRef, opts.status, opts.status);
    if (found.length === 0) {
      console.log('REPLAY no matching interaction found');
      process.exit(1);
    }
    const row = found[0];

    // 2. Pick the ref to replay: explicit --ref / --dismiss, else the first
    //    category index ("0") from the stored button rows.
    const buttons = flattenButtons(row);
    let chosen = opts.chosenRef;
    if (opts.dismiss) chosen = '-';
    if (chosen == null) chosen = buttons.length > 0 ? buttons[0].ref : '-';

    // 3. Build the synthetic update (mirrors the live getUpdates shape).
    const offsetNow = Number(store.kvGet(db, 'poll_offset') || 0);
    const ts = Date.now();
    const update = {
      update_id: offsetNow + ts,
      callback_query: {
        id: `replay-${ts}`,
        data: `v1:${row.item_ref}:${chosen}`,
        from: { id: 123456789, first_name: 'Replay', username: 'replay_bot' },
      },
    };

    // 4. Replay through the real dispatcher (no Telegram polling involved;
    //    answerCallbackQuery/editMessageText go through the bot module,
    //    which is dry-run in the dev container).
    await handleUpdate(update);

    // 5. Report: re-read the row + answers tail.
    const after = store.getInteraction(db, row.id);
    const tail = db
      .prepare(
        `SELECT outcome, detail, created_at FROM answers
         WHERE interaction_id = ? ORDER BY id DESC LIMIT 3`,
      )
      .all(row.id)
      .map((a) => `${a.outcome}${a.detail ? `(${a.detail})` : ''}`)
      .join(', ');
    console.log(
      `REPLAY item_ref=${row.item_ref} ref=${chosen} → status=${after.status} answer_detail=${after.answer_detail || '-'} last_answer_outcome=[${tail}]`,
    );
    log('info', 'listener', 'Replay finished', {
      item_ref: row.item_ref,
      ref: chosen,
      status: after.status,
    });
  } finally {
    store.close(db);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error(`REPLAY error: ${err.message}`);
    process.exit(1);
  });
}
