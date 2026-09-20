/**
 * One-shot seeder for the actual-notifier dev environment.
 *
 * Creates a DETERMINISTIC "dev-budget" on the Actual Budget server whose
 * accounts, categories, budget amounts and transactions produce known,
 * documented reporting outcomes for src/reporte-diario.js. Idempotent: it
 * exits if dev-budget already exists. To RESET: stop the stack, delete
 * actual-budget/.actual-data/ and re-run the seeder.
 *
 * Usage (from the repo root):
 *   docker compose -f actual-budget/docker-compose.yml up -d actual-budget
 *   docker compose -f actual-budget/docker-compose.yml run --rm seed
 *
 * ---------------------------------------------------------------------------
 * DOCUMENTED EXPECTED STATE (current month = M, previous month = M-1)
 *
 * Monitored categories (match CATEGORIAS_OBJETIVO in src/reporte-diario.js)
 * -> expected current-month balance (budget - spent, with carryover):
 *   Gasto Personal            12.00 - 12.00 + 5.00 (M-1 carryover) = 5.00
 *   Farmacia y Botiquin       20.00 - (0.40 direct + 0.40 split + 1.90) = 17.30
 *   Supermercado y Alimentación 70.00 - (2.10 split + 19.00 direct) = 48.90
 *   Ocio y Restaurantes       17.00 - (12.00 + 14.00 credit card) = -9.00
 *   Transporte                50.00 - 50.00                      = 0.00
 *
 * Non-monitored expense categories -> expected balances:
 *   Renta                     95.00 - 0.00 (rent is a leg-less transfer) = 95.00
 *   Internet y Telefono       40.00 - 40.00                               = 0.00
 *   Suscripciones             10.00 - (9.00 + 8.50)                       = -7.50  OVERSPEND
 *
 * Paso 2 (uncategorized, current month, on-budget) MUST contain EXACTLY:
 *   Cuenta Nomina     "Nomina empresa"   +195.00  (income, no category)
 *   Cuenta Corriente  "Compra suelta"     -15.00  (plain untagged expense)
 *   Excluded on purpose: the rent transfer (both legs carry transfer_id),
 *   the split parent (is_parent + transfer_id), the split children
 *   (transfer_id), and the cash purchase (off-budget account).
 *
 * Paso 3 negative sweep (non-monitored) MUST contain EXACTLY:
 *   Suscripciones (-7.50).
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const api = require('@actual-app/api');

const BUDGET_NAME = 'dev-budget';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function monthOffset(n) {
  // Anchor on the real current month so M is always "this month" and M-1
  // is always a valid, recent month (dates before 1970 are rejected).
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 7);
}

function day(month, d) {
  return `${month}-${String(d).padStart(2, '0')}`;
}

async function findBudget(name) {
  const budgets = await api.getBudgets();
  return budgets.find(b => b.name === name);
}

async function findTransactionId(accountId, date, amount, payeeName) {
  const transactions = await api.getTransactions(accountId, date, date);
  const transaction = transactions.find(
    candidate =>
      candidate.amount === amount &&
      (candidate.imported_payee === payeeName || candidate.payee_name === payeeName),
  );
  if (!transaction) {
    throw new Error(`transaction not found: ${accountId} ${date} ${amount} ${payeeName}`);
  }
  return transaction.id;
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

async function seed() {
  const dataDir = path.join(__dirname, 'dev-cache');
  fs.mkdirSync(dataDir, { recursive: true });

  await api.init({
    dataDir,
    serverURL: process.env.ACTUAL_URL,
    password: process.env.ACTUAL_PASSWORD,
  });

  const existing = await findBudget(BUDGET_NAME);
  if (existing) {
    console.log(
      `[seed] ${BUDGET_NAME} already exists (${existing.id}). Nothing to do.\n` +
        'To RESET dev data: stop the stack, delete actual-budget/.actual-data/ and re-run.',
    );
    await api.shutdown();
    return;
  }

  const M = monthOffset(0);
  const M1 = monthOffset(-1);

  await api.runImport(BUDGET_NAME, async () => {
    // ---- Accounts ----------------------------------------------------------
    const checking = await api.createAccount(
      { name: 'Cuenta Corriente', onbudget: true },
      500000,
    );
    const payroll = await api.createAccount(
      { name: 'Cuenta Nómina', onbudget: true },
      0,
    );
    const credit = await api.createAccount(
      { name: 'Tarjeta Crédito', onbudget: true },
      0,
    );
    const cash = await api.createAccount(
      { name: 'Caja', offbudget: true },
      15000,
    );

    // ---- Categories --------------------------------------------------------
    const gIncome = await api.createCategoryGroup({
      name: 'Ingresos',
      is_income: true,
    });
    const gExpense = await api.createCategoryGroup({
      name: 'Gastos',
      is_income: false,
    });

    const cat = {
      nomina: await api.createCategory({
        name: 'Nómina',
        group_id: gIncome,
        is_income: true,
      }),
      gastoPersonal: await api.createCategory({
        name: 'Gasto Personal',
        group_id: gExpense,
      }),
      farmacia: await api.createCategory({
        name: 'Farmacia y Botiquin',
        group_id: gExpense,
      }),
      supermercado: await api.createCategory({
        name: 'Supermercado y Alimentación',
        group_id: gExpense,
      }),
      ocio: await api.createCategory({
        name: 'Ocio y Restaurantes',
        group_id: gExpense,
      }),
      transporte: await api.createCategory({
        name: 'Transporte',
        group_id: gExpense,
      }),
      renta: await api.createCategory({
        name: 'Renta',
        group_id: gExpense,
      }),
      internet: await api.createCategory({
        name: 'Internet y Teléfono',
        group_id: gExpense,
      }),
      suscripciones: await api.createCategory({
        name: 'Suscripciones',
        group_id: gExpense,
      }),
    };

    // ---- Current month budget (cents) + carryover on the 5 monitored --------
    await api.setBudgetAmount(M, cat.gastoPersonal, 1200);
    await api.setBudgetAmount(M, cat.farmacia, 2000);
    await api.setBudgetAmount(M, cat.supermercado, 7000);
    await api.setBudgetAmount(M, cat.ocio, 1700);
    await api.setBudgetAmount(M, cat.transporte, 5000);
    await api.setBudgetAmount(M, cat.renta, 95000);
    await api.setBudgetAmount(M, cat.internet, 4000);
    await api.setBudgetAmount(M, cat.suscripciones, 1000);
    for (const id of [
      cat.gastoPersonal,
      cat.farmacia,
      cat.supermercado,
      cat.ocio,
      cat.transporte,
    ]) {
      await api.setBudgetCarryover(M, id, true);
    }

    // M-1: Gasto Personal budget 12.00, spent 7.00 -> 5.00 carryover.
    // M spends 12.00, leaving 5.00 available in the current month.
    await api.setBudgetAmount(M1, cat.gastoPersonal, 1200);

    // ---- M-1 transactions ---------------------------------------------------
    await api.addTransactions(checking, [
      {
        date: day(M1, 3),
        amount: -700,
        payee_name: 'Mercado local',
        category: cat.gastoPersonal,
      },
    ]);
    await api.addTransactions(payroll, [
      {
        date: day(M1, 15),
        amount: 14000,
        payee_name: 'Trabajo freelance',
        category: cat.nomina,
      },
    ]);

    // ---- M: payroll (uncategorized income -> expected uncategorized #1) -----
    await api.addTransactions(payroll, [
      { date: day(M, 1), amount: 19500, payee_name: 'Nómina empresa' },
    ]);

    // ---- M: checking ----------------------------------------------------------
    await api.addTransactions(checking, [
      {
        date: day(M, 2),
        amount: -1900,
        payee_name: 'Mercadona',
        category: cat.supermercado,
      },
      {
        date: day(M, 3),
        amount: -40,
        payee_name: 'Farmacia central',
        category: cat.farmacia,
      },
      {
        date: day(M, 4),
        amount: -1200,
        payee_name: 'Restaurante El Fogon',
        category: cat.ocio,
      },
      {
        date: day(M, 5),
        amount: -5000,
        payee_name: 'Gasolinera Repsol',
        category: cat.transporte,
      },
      {
        date: day(M, 5),
        amount: -4000,
        payee_name: 'Proveedora Internet',
        category: cat.internet,
      },
      {
        date: day(M, 6),
        amount: -900,
        payee_name: 'Streaming X',
        category: cat.suscripciones,
      },
      // Expected uncategorized #2 (plain untagged current-month expense).
      { date: day(M, 7), amount: -1500, payee_name: 'Compra suelta' },
      {
        date: day(M, 10),
        amount: -1200,
        payee_name: 'Regalo familiar',
        category: cat.gastoPersonal,
      },
      {
        date: day(M, 12),
        amount: -850,
        payee_name: 'Musica Y',
        category: cat.suscripciones,
      },
      {
        date: day(M, 14),
        amount: -190,
        payee_name: 'Botiquin',
        category: cat.farmacia,
      },
    ]);

    // ---- M: credit card (on-budget) -------------------------------------------
    await api.addTransactions(credit, [
      {
        date: day(M, 8),
        amount: -1400,
        payee_name: 'Cena familiar',
        category: cat.ocio,
      },
    ]);

    // ---- M: cash, OFF-BUDGET (invisible to the report) --------------------------
    await api.addTransactions(cash, [
      { date: day(M, 9), amount: -150, payee_name: 'Compra en efectivo' },
    ]);

    // ---- Rent 50.00: internal transfer checking -> credit (excluded) ------------
    // Neither leg is categorized: invisible to the report, Renta untouched.
    await api.addTransactions(checking, [
      { date: day(M, 9), amount: -5000, payee_name: 'Alquiler piso' },
    ]);
    await api.addTransactions(credit, [
      { date: day(M, 9), amount: 5000, payee_name: 'Alquiler piso' },
    ]);
    const legMinus = await findTransactionId(
      checking,
      day(M, 9),
      -5000,
      'Alquiler piso',
    );
    const legPlus = await findTransactionId(
      credit,
      day(M, 9),
      5000,
      'Alquiler piso',
    );
    await api.updateTransaction(legMinus, { transfer_id: legPlus });
    await api.updateTransaction(legPlus, { transfer_id: legMinus });

    // ---- Split with UNCATEGORIZED parent (excluded via is_parent + transfer_id) -
    // Parent created WITHOUT transfer_id first (adding a transfer leg whose
    // siblings aren't in place yet triggers the API auto-split path, which
    // would clear the children's categories). Then link, then add children.
    await api.addTransactions(checking, [
      { date: day(M, 3), amount: -250, payee_name: 'Farmacia central' },
    ]);
    const parentTx = await findTransactionId(
      checking,
      day(M, 3),
      -250,
      'Farmacia central',
    );
    await api.updateTransaction(parentTx, { is_parent: true });
    await api.addTransactions(checking, [
      {
        date: day(M, 3),
        amount: -210,
        payee_name: 'Farmacia central',
        category: cat.supermercado,
      },
      {
        date: day(M, 3),
        amount: -40,
        payee_name: 'Farmacia central',
        category: cat.farmacia,
      },
    ]);
  });

  // ---- Publish to the server so downloadBudget(syncId) works in the notifier ---
  await api.sync();
  const budget = await findBudget(BUDGET_NAME);
  if (!budget || !budget.cloudFileId) {
    throw new Error(
      `dev-budget has no cloudFileId after sync: ${JSON.stringify(budget)}`,
    );
  }

  // Snapshot of the known-good state (exported budget zip).
  // Directory is configurable via SNAPSHOT_DIR (the container mounts
  // actual-budget/.actual-data there) with a local fallback for host runs.
  const snapshot = path.resolve(
    process.env.SNAPSHOT_DIR || path.resolve(__dirname, '..', '.actual-data'),
    'dev-budget-snapshot.zip',
  );
  const data = await api.exportBudget();
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, data);

  console.log('');
  console.log('Seed OK. Use in your dev .env:');
  console.log(
    '  ACTUAL_SERVER_URL=http://localhost:5006   (inside actual_net: http://actual-budget:5006)',
  );
  console.log(`  ACTUAL_PASSWORD=${process.env.ACTUAL_PASSWORD}`);
  console.log(`  ACTUAL_SYNC_ID=${budget.groupId || budget.cloudFileId}`);
  console.log(`  (cloudFileId: ${budget.cloudFileId}; ACTUAL_SYNC_ID must be the GROUP id)`);
  console.log(`Snapshot: ${snapshot}`);

  await api.shutdown();
}

seed().catch(err => {
  console.error('[seed] FAILED:', err);
  process.exit(1);
});
