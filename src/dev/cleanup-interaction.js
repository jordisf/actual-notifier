'use strict';
/**
 * Dev-only companion of seed-interaction.js: removes the temp test tx
 * from Actual and marks the seeded interaction as expired so stray taps
 * are rejected.
 *
 * Usage:
 *   docker exec actual_notifier_dev node /app/src/dev/cleanup-interaction.js <item_ref>
 */

const store = require('../store');
const actual = require('../actual');

const itemRef = process.argv[2];
if (!itemRef) {
  console.error('Uso: node cleanup-interaction.js <item_ref>   (ej. "f")');
  process.exit(1);
}

async function main() {
  const db = store.open();
  const row = db.prepare('SELECT * FROM interactions WHERE item_ref = ?').get(itemRef);
  if (!row) {
    console.error(`Sin interacción para item_ref '${itemRef}'`);
    process.exit(1);
  }
  if (row.status === 'answered') {
    console.log('⚠️ Esa interacción ya fue RESPONDIDA (la tx quedó categorizada en Actual). Solo se deja el registro como expirado; no se toca la tx.');
    db.prepare(`UPDATE interactions SET status='expired' WHERE id=?`).run(row.id);
  } else {
    const { api } = await actual.open();
    try {
      await api.deleteTransaction(row.actual_tx_id);
      console.log(`Tx ${row.actual_tx_id} eliminada de Actual.`);
    } finally {
      await actual.close({ api });
    }
  }
  // Make the message non-actionable.
  db.prepare(`UPDATE interactions SET status='expired', answer_detail=COALESCE(answer_detail,'cleanup dev') || ' [cleanup]' WHERE id=?`).run(row.id);
  const fresh = db.prepare('SELECT status FROM interactions WHERE id=?').get(row.id);
  console.log(`interacciones[${row.id}] (${row.payee}) -> status='${fresh.status}'`);
  store.close(db);
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
