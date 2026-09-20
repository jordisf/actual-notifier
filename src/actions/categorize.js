'use strict';

/**
 * 'categorize' action (design §6.1) — per-invocation Actual lifecycle.
 *
 * Called by the listener AFTER a won claim. The interaction row arrives
 * with chosen_ref = the winning actionRef (set by store.claimAnswer).
 * This action opens its OWN store connection (WAL allows the concurrent
 * reader/claimer), and its OWN Actual API handle (open → update →
 * record/rollback → close) so a slow or failed write-back never holds a
 * connection from the poll process.
 *
 * Outcomes: { detail: 'applied', label } | { detail: 'dismissed' }
 *          | { detail: 'failed', retryable: boolean, error }
 * Write-back failures roll the row back to pending so the user can retry.
 */

const store = require('../store');
const actual = require('../actual');

module.exports = async function handleCategorize(row) {
  const db = store.open();
  try {
    // Dismiss: no Actual call — the tx simply stays uncategorized on the
    // server and the interaction is recorded as handled.
    if (row.chosen_ref === '-') {
      store.recordApplied(db, row.id, null, 'dismissed');
      return { detail: 'dismissed' };
    }

    // Resolve the tapped ref against the STORED button rows (design §4.1
    // trust rule — the listener already validated it, this is defense in
    // depth; a mismatch here means stored state changed, so roll back).
    const buttons = JSON.parse(row.button_rows_json || '[]').flat();
    const tapped = buttons.find((b) => b.ref === row.chosen_ref);
    if (!tapped) {
      store.rollbackToPending(db, row.id, 'unknown ref');
      return { detail: 'failed', retryable: true, error: 'unknown ref' };
    }

    // No argument on purpose (CI-2): actual.open() defaults to
    // LISTENER_DATA_DIR for the listener's isolated cache.
    const { api } = await actual.open();
    try {
      // May return the updated tx — only success matters here.
      await actual.applyCategoryChange(api, row.actual_tx_id, tapped.cat_id);
      store.recordApplied(db, row.id, tapped.cat_id, tapped.label);
      return { detail: 'applied', label: tapped.label };
    } catch (err) {
      store.rollbackToPending(db, row.id, err.message);
      return { detail: 'failed', retryable: true, error: err.message };
    } finally {
      await actual.close({ api });
    }
  } finally {
    store.close(db);
  }
};
