'use strict';

/**
 * Offline /report command replay driver (003-telegram-report-command, T016).
 *
 * Feeds synthetic `message` update objects through the SAME handleUpdate path
 * the live listener uses — no getUpdates, no Telegram network calls when
 * TELEGRAM_DRY_RUN=true (set it like: TELEGRAM_DRY_RUN=true node src/dev/replay-report-cmd.js).
 *
 * Scenarios (--case=):
 *   valid    bare /report in the configured group  → full pipeline runs
 *   suffix   /report@<botusername> form             → recognized (contract §3)
 *   freetext free-form message                      → ignored, no reply (FR-008)
 *   wrongchat /report from another chat id          → ignored (FR-010)
 *   failure  /report with ACTUAL unreachable       → failure edit (contract §4)
 *   queue    three rapid /report in flight         → first runs, second is
 *            queued and also runs, third is replied "ya hay un reporte en
 *            curso" and dropped (contract §5). Expects the listener logs to
 *            show two "/report outcome" lines and one DRY-RUN drop reply.
 *
 * The empty path (nothing pending → acknowledgment edit) is data-dependent;
 * it is covered by the live quickstart (T015). This driver covers it whenever
 * the dev data happens to have zero pending items (outcome tag "empty").
 *
 * `valid`/`suffix`/`failure`/`queue` DO reach the real (dev) Actual stack and
 * write reports rows in the shared notifier.db — use only against the dev
 * deployment (same warning as replay-callback.js). The pipeline outcome is read from the
 * listener logs ("listener ... /report outcome { outcome: ... }"); the driver
 * below also prints which scenario it fed.
 *
 * Usage (DATA_DIR must point at the notifier db):
 *   TELEGRAM_DRY_RUN=true node src/dev/replay-report-cmd.js --case=valid
 *   node src/dev/replay-report-cmd.js --case=wrongchat
 */

const path = require('path');

// Load .env like the other entrypoints (DATA_DIR, TELEGRAM_GROUP_ID etc.), no override.
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const store = require('../store');
const { handleUpdate, setDb, resetReportCmdState } = require('../listener');

function buildMessage(text, chatId) {
  return {
    message_id: Math.floor(Math.random() * 1_000_000),
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'group', title: 'Replay Group' },
    from: { id: 999888777, first_name: 'Replay', username: 'replay_user' },
    text,
  };
}

/** Build the synthetic update object handleUpdate consumes ({update_id, message}). */
function buildUpdate(msg) {
  return { update_id: Date.now(), message: msg };
}

async function main() {
  const argv = process.argv.slice(2);
  const caseArg = argv.find((a) => a.startsWith('--case='));
  const scenario = caseArg ? caseArg.slice('--case='.length) : null;
  if (!['valid', 'suffix', 'freetext', 'wrongchat', 'failure', 'queue'].includes(scenario)) {
    console.log('REPLAY-REPORT: --case=valid|suffix|freetext|wrongchat|failure|queue required');
    process.exit(1);
  }

  const group = (process.env.TELEGRAM_GROUP_ID || '').trim();
  if (!group) {
    console.log('REPLAY-REPORT: TELEGRAM_GROUP_ID missing in .env; cannot build a matching chat id');
    process.exit(1);
  }

  // Scenario setup.
  if (scenario === 'failure') {
    // Kill the Actual API handle before the pipeline opens it → compute throws.
    process.env.ACTUAL_SERVER_URL = 'http://127.0.0.1:1'; // unreachable
  }

  const db = store.open();
  try {
    // Same boot sequence as main(): module-scoped db for the pipeline.
    setDb(db);
    // Isolate queue/re-entrancy state from any prior scenario in this process.
    resetReportCmdState();

    const chatId = scenario === 'wrongchat' ? String(Number(group) + 1) : group;
    let text;
    switch (scenario) {
      case 'valid':
        text = '/report';
        break;
      case 'suffix':
        text = '/report@dev_finjb_bot';
        break;
      case 'freetext':
        text = 'buenas noches, ¿todo en orden?';
        break;
      case 'wrongchat':
      case 'queue':
      case 'failure':
        text = '/report';
        break;
    }

    const update = buildUpdate(buildMessage(text, chatId));

    if (scenario === 'queue') {
      // Depth-1 queue (contract §5): u1 starts the pipeline (real compute is
      // slow enough that u2 lands while in flight), u2 must be QUEUED and run
      // after u1, u3 must be replied "ya hay un reporte en curso" and dropped.
      const u1 = buildUpdate(buildMessage(text, chatId));
      const u2 = buildUpdate(buildMessage(text, chatId));
      const u3 = buildUpdate(buildMessage(text, chatId));
      await handleUpdate(u1); // schedules the in-flight job and returns early
      const p2 = handleUpdate(u2); // queued → awaits its own turn
      const p3 = handleUpdate(u3); // queue full → immediate drop reply, resolves fast
      await Promise.all([p2, p3]);
      console.log(
        'REPLAY-REPORT queue: expected TWO "/report outcome" lines, one DRY-RUN sendMessage "Ya hay un reporte en curso"',
      );
      return;
    }

    console.log(
      `REPLAY-REPORT case=${scenario} chat_id=${chatId} text=${JSON.stringify(text)} → feeding handleUpdate`,
    );

    // handleUpdate never throws per-update (errors are logged inside).
    await handleUpdate(update);

    // The real outcome ("sent" | "empty" | "failed") is emitted by the listener
    // right after the pipeline: log('info', 'listener', '/report outcome', { outcome }).
    // For freetext/wrongchat there is NO outcome line at all — that silence IS
    // the expected result (no reply, no pipeline).
    console.log(
      scenario === 'freetext' || scenario === 'wrongchat'
        ? 'REPLAY-REPORT expected: no "/report outcome" log line (ignored, no reply)'
        : 'REPLAY-REPORT look for: "listener /report outcome" with outcome tag (sent/empty/failed)',
    );
  } finally {
    store.close(db);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error(`REPLAY-REPORT error: ${err.message}`);
    process.exit(1);
  });
}
