'use strict';

/**
 * SQLite persistence for notification state (design §5).
 *
 * better-sqlite3 is already compiled in the image (transitive dep of
 * @actual-app/api) — no new runtime dependency (P9).
 *
 * File: $DATA_DIR/notifier.db (DATA_DIR default /app/data, mkdir recursive).
 * One open connection per process; DDL is idempotent (CREATE ... IF NOT EXISTS).
 * WAL + busy_timeout=5000 + foreign_keys=ON (design §5).
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR_DEFAULT = '/app/data';

const DDL = `
CREATE TABLE IF NOT EXISTS reports (
  id                     INTEGER PRIMARY KEY,
  run_at                 TEXT NOT NULL UNIQUE,
  sync_ok                INTEGER NOT NULL,
  sync_message           TEXT,
  tx_uncategorized_count INTEGER NOT NULL,
  email_sent             INTEGER NOT NULL DEFAULT 0,
  telegram_summary_sent  INTEGER NOT NULL DEFAULT 0,
  telegram_tx_sent       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interactions (
  id                 INTEGER PRIMARY KEY,
  report_id          INTEGER NOT NULL REFERENCES reports(id),
  item_ref           TEXT NOT NULL UNIQUE,
  action_kind        TEXT NOT NULL DEFAULT 'categorize',
  actual_tx_id       TEXT NOT NULL,
  account_id         TEXT,
  account_name       TEXT NOT NULL,
  tx_date            TEXT NOT NULL,
  payee              TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  button_rows_json   TEXT NOT NULL,
  tg_chat_id         INTEGER NOT NULL,
  tg_message_id      INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  answered_by_id     INTEGER,
  answered_by_name   TEXT,
  chosen_ref         TEXT,
  actual_category_id TEXT,
  answer_detail      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_interactions_status ON interactions(status, report_id);

CREATE TABLE IF NOT EXISTS answers (
  id             INTEGER PRIMARY KEY,
  interaction_id INTEGER NOT NULL REFERENCES interactions(id),
  user_id        INTEGER,
  username       TEXT,
  callback_id    TEXT,
    outcome        TEXT NOT NULL,
    detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function open(dataDir) {
  const dir = dataDir || process.env.DATA_DIR || DATA_DIR_DEFAULT;
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'notifier.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  return db;
}

// --- reports ---------------------------------------------------------------

function insertReport(db, { run_at, sync_ok, sync_message, tx_uncategorized_count, email_sent = 0, telegram_summary_sent = 0, telegram_tx_sent = 0 }) {
  const r = db
    .prepare(
      `INSERT INTO reports (run_at, sync_ok, sync_message, tx_uncategorized_count, email_sent, telegram_summary_sent, telegram_tx_sent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(run_at, sync_ok ? 1 : 0, sync_message, tx_uncategorized_count, email_sent ? 1 : 0, telegram_summary_sent ? 1 : 0, telegram_tx_sent ? 1 : 0);
  return r.lastInsertRowid;
}

// --- interactions ----------------------------------------------------------

function base36(n) {
  return Number(n).toString(36);
}

/**
 * Insert one interaction. item_ref = base36 of the new row id (design §4.1:
 * base36 of the id, used in callback_data). The insert is done in a single
 * transaction so id and item_ref are consistent.
 */
function insertInteraction(db, { report_id, action_kind = 'categorize', actual_tx_id, account_id = null, account_name, tx_date, payee, amount_cents, button_rows_json, tg_chat_id, tg_message_id }) {
  const tx = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO interactions (report_id, item_ref, action_kind, actual_tx_id, account_id, account_name, tx_date, payee, amount_cents, button_rows_json, tg_chat_id, tg_message_id)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(report_id, action_kind, actual_tx_id, account_id, account_name, tx_date, payee, amount_cents, button_rows_json, tg_chat_id, tg_message_id);
    const id = r.lastInsertRowid;
    db.prepare(`UPDATE interactions SET item_ref = ? WHERE id = ?`).run(base36(id), id);
    return id;
  });
  return tx();
}

function getInteraction(db, id) {
  return db.prepare(`SELECT * FROM interactions WHERE id = ?`).get(id);
}

function findInteractionByItemRef(db, itemRef) {
  return db.prepare(`SELECT * FROM interactions WHERE item_ref = ?`).get(itemRef);
}

/**
 * D3 first-answer-wins (design §5.3, byte-for-byte): guarded UPDATE + changes()
 * check. Loser re-reads the winner's row via getInteraction.
 */
function claimAnswer(db, id, tgUserId, username, actionRef) {
  const r = db
    .prepare(
      `UPDATE interactions
          SET status = 'answered', answered_by_id = ?, answered_by_name = ?,
              chosen_ref = ?, answered_at = datetime('now')
        WHERE id = ? AND status = 'pending'`,
    )
    .run(tgUserId, username, actionRef, id);
  return { won: r.changes === 1, row: getInteraction(db, id) };
}

function recordApplied(db, id, categoryId, detail) {
  return db
    .prepare(`UPDATE interactions SET actual_category_id = ?, answer_detail = ? WHERE id = ?`)
    .run(categoryId, detail, id);
}

function rollbackToPending(db, id, detail) {
  return db
    .prepare(
      `UPDATE interactions SET status = 'pending',
          answered_by_id = NULL, answered_by_name = NULL,
          chosen_ref = NULL, answered_at = NULL, answer_detail = ?
        WHERE id = ?`,
    )
    .run(detail, id);
}

// --- answers (append-only audit log) ----------------------------------------

function logAnswer(db, interactionId, { user_id = null, username = null, callback_id = null }, outcome, detail = null) {
  return db
    .prepare(
      `INSERT INTO answers (interaction_id, user_id, username, callback_id, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(interactionId, user_id, username, callback_id, outcome, detail);
}

// --- kv ----------------------------------------------------------------------

function kvGet(db, key) {
  const row = db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
  return row ? row.value : null;
}

function kvSet(db, key, value) {
  return db
    .prepare(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, String(value));
}

// --- expiry & retention -------------------------------------------------------

/**
 * D6 expiry (design §9 step 1): flip pending rows of reports strictly older
 * than beforeReportId to 'expired' (store-first, guarded UPDATE).
 * Returns the just-expired rows so the caller can best-effort edit their
 * Telegram messages (design §9 step 2).
 */
function expirePreviousPending(db, beforeReportId) {
  const justExpired = db
    .prepare(`SELECT * FROM interactions WHERE status = 'pending' AND report_id < ?`)
    .all(beforeReportId);
  db.prepare(
    `UPDATE interactions SET status = 'expired'
      WHERE status = 'pending' AND report_id < ?`,
  ).run(beforeReportId);
  return justExpired;
}

/**
 * design §5.1 retention: one pass per daily delivery — purge answers older
 * than 90 days and answers whose interaction no longer exists.
 */
function answersRetentionSweep(db) {
  const r = db
    .prepare(
      `DELETE FROM answers
        WHERE created_at < datetime('now', '-90 day')
           OR interaction_id NOT IN (SELECT id FROM interactions)`,
    )
    .run();
  return r.changes;
}

module.exports = {
  DATA_DIR_DEFAULT,
  open,
  close: (db) => db.close(),
  insertReport,
  insertInteraction,
  getInteraction,
  findInteractionByItemRef,
  claimAnswer,
  recordApplied,
  rollbackToPending,
  logAnswer,
  kvGet,
  kvSet,
  expirePreviousPending,
  answersRetentionSweep,
  base36,
};
