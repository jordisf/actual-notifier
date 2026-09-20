'use strict';

/**
 * Actual Budget API lifecycle wrapper (design §2/§6/§10).
 *
 * Every process owns its own dataDir working copy:
 *  - cron:    /tmp/actual-cache          (existing, holds bank-sync throttle marker)
 *  - listener: LISTENER_DATA_DIR (default /tmp/actual-listener-cache)
 * Never conflate with the SQLite DATA_DIR (/app/data). CI-2.
 */

const fs = require('fs');
const api = require('@actual-app/api');

const LISTENER_DATA_DIR_DEFAULT = '/tmp/actual-listener-cache';

/**
 * Resolve the dataDir for a process.
 * cron passes '/tmp/actual-cache' explicitly (behavior unchanged);
 * the listener passes nothing and gets LISTENER_DATA_DIR or its default.
 */
function resolveDataDir(dataDir) {
  const dir = dataDir || process.env.LISTENER_DATA_DIR || LISTENER_DATA_DIR_DEFAULT;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * api.init against ACTUAL_SERVER_URL/ACTUAL_PASSWORD + download ACTUAL_SYNC_ID.
 * Returns { api }.
 */
async function open(dataDir) {
  const dir = resolveDataDir(dataDir);
  await api.init({
    dataDir: dir,
    serverURL: process.env.ACTUAL_SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
  });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
  return { api, dataDir: dir };
}

/**
 * api.shutdown. Safe to call once per open().
 */
async function close(handle) {
  const { api: a } = handle && handle.api ? handle : { api: handle };
  await a.shutdown();
}

/**
 * Uncategorized transactions of `month` ('YYYY-MM') on on-budget, non-closed
 * accounts — VERBATIM semantics from reporte-diario.js step 2:
 *  - exclude parents (split), exclude transfers on both fields
 *  - category null or empty
 *  - amount converted cents → euros
 * Adds id / account_id so the Telegram layer can address the tx.
 */
async function getUncategorizedTxs(a, month) {
  const [y, m] = month.split('-');
  const lastDay = new Date(Number(y), Number(m), 0).getDate();
  const firstDay = `${month}-01`;
  const lastDayStr = `${month}-${String(lastDay).padStart(2, '0')}`;

  const rows = [];
  const accounts = await a.getAccounts();
  const onBudget = accounts.filter((acc) => !acc.offbudget && !acc.closed);

  for (const account of onBudget) {
    try {
      const txs = await a.getTransactions(account.id, firstDay, lastDayStr);
      for (const t of txs) {
        if (t.is_parent) continue;
        if (t.category == null || t.category === '') {
          if (t.transfer_id == null || t.transfer_id === '') {
            rows.push({
              id: t.id,
              account_id: account.id,
              cuenta: account.name,
              fecha: t.date,
              beneficiario: t.imported_payee || t.payee_name || 'Desconocido',
              importe: (t.amount || 0) / 100,
            });
          }
        }
      }
    } catch (errTx) {
      // Same leniency as the monolith: per-account read failure does not sink the run.
      // eslint-disable-next-line no-console
      console.warn(`No se pudieron leer transacciones de ${account.name}: ${errTx.message}`);
    }
  }
  return rows;
}

/**
 * Non-income categories with ids (design §2). Income categories are
 * meaningless as categorization targets for expenses.
 */
async function getCategories(a) {
  const all = await a.getCategories();
  return all
    .filter((c) => !c.is_income)
    .map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Write a category onto a transaction.
 *
 * T0-confirmed (CI-1, @actual-app/api 26.9.0, package ^26.8.1):
 *   updateTransaction(id: string, fields: Partial<TransactionEntity>)
 * with fields.category = the category ID. The call returns the resulting
 * transaction(s): a single entity, or a transfer pair ({id, transfer_id}),
 * or a categorized pair ({id, category}).
 */
async function applyCategoryChange(a, txId, categoryId) {
  return a.updateTransaction(txId, { category: categoryId });
}

module.exports = { open, close, getUncategorizedTxs, getCategories, applyCategoryChange, LISTENER_DATA_DIR_DEFAULT };
