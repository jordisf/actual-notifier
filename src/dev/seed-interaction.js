'use strict';
/**
 * Dev-only: deliver ONE real interactive categorize message so the full
 * callback flow can be exercised in the dev Telegram group.
 *
 * Unlike preview-telegram.js, this registers the interaction in the real
 * notifier.db against a REAL temporary Actual transaction, so a button
 * tap actually categorizes it (and the confirmation edit uses the live
 * builder). Cleanup: the temp tx is deleted from Actual and the
 * interaction row is marked expired so stray taps are rejected.
 *
 * Run from the dev container (has ACTUAL_* and the /app/data volume):
 *   docker exec actual_notifier_dev node /app/src/dev/seed-interaction.js
 */

const path = require('path');
const fs = require('fs');
const store = require('../store');
const actual = require('../actual');
const send = require('../telegram/send');

const FIXED_CATEGORIES = [
  'Gasto Personal',
  'Farmacia y Botiquin',
  'Ocio y Restaurantes',
  'Transporte',
  'Supermercado y Alimentación',
];
const TEST_PAYEE = `Prueba manual ${new Date().toTimeString().slice(0, 8)} (delete me)`;
const AMOUNT_CENTS = -1250; // −12.50 €

function loadEnv(envPath) {
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0 && !line.trimStart().startsWith('#')) {
        const k = line.slice(0, i).trim();
        if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim();
      }
    }
  } catch {
    /* rely on environment */
  }
}
loadEnv(process.env.DOTENV_PATH || path.join(__dirname, '..', '..', '.env'));

async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_GROUP_ID) {
    throw new Error('Falta TELEGRAM_BOT_TOKEN o TELEGRAM_GROUP_ID');
  }

  // No dataDir arg: resolves LISTENER_DATA_DIR/default, same as the live
  // listener — the write-back target must see this tx.
  const { api } = await actual.open();
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  // 1. Create the temp tx on the first on-budget, non-closed account.
  const accounts = await api.getAccounts();
  const acc = accounts.find((a) => !a.offbudget && !a.closed);
  if (!acc) throw new Error('No hay cuenta on-budget activa');
  await api.addTransactions(acc.id, [
    { date: today, payee_name: TEST_PAYEE, amount: AMOUNT_CENTS },
  ]);

  // 2. Pick up that tx with production semantics (id, euros, payee).
  const txList = await actual.getUncategorizedTxs(api, month);
  const mine = txList.find((t) => t.beneficiario === TEST_PAYEE);
  if (!mine) throw new Error(`No encontré la tx de prueba (payee ${TEST_PAYEE})`);

  // 3. Category buttons = the fixed five, filtered to what exists.
  const allCats = await actual.getCategories(api);
  const categories = FIXED_CATEGORIES.map((name) => {
    const c = allCats.find((x) => x.name === name);
    return c ? { id: c.id, name: c.name } : null;
  }).filter(Boolean);
  if (categories.length === 0) throw new Error('Ninguna de las 5 fijas existe en Actual');

  // 4. Register the reports row + deliver via the real sendReport.
  const db = store.open();
  const reportId = db
    .prepare(
      `INSERT INTO reports (run_at, sync_ok, sync_message, tx_uncategorized_count, email_sent, telegram_summary_sent, telegram_tx_sent)
       VALUES (?, 1, 'Semilla de prueba (sin sincronización)', ?, 0, 1, 1)`,
    )
    .run(`seed:${Date.now()}`, txList.length)
    .lastInsertRowid;

  try {
    const res = await send.sendReport({
      db,
      chatId: process.env.TELEGRAM_GROUP_ID,
      reportId,
      txList: [mine],
      categories,
      mesActual: month,
      syncMensaje: 'Sincronización bancaria completada con éxito (seed de prueba).',
      datosConsumo: [],
      categoriasNegativas: [],
    });
    if (res.sent !== 1) throw new Error(`Envío falló: ${JSON.stringify(res)}`);
    console.log(`Listo: tx ${mine.id} en '${acc.name}', reportId=${reportId}`);
    console.log('Pulsa un botón del mensaje; luego ejecuta el cleanup (mensaje de abajo).');
  } catch (e) {
    // Compensate the temp tx on any failure and exit loud.
    try {
      await api.deleteTransaction(mine.id);
    } catch {
      /* best effort */
    }
    throw e;
  } finally {
    store.close(db);
    await actual.close({ api });
  }
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
