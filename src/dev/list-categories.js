'use strict';

/**
 * Dev tool: list the budget's non-income categories (name + id), so an
 * operator can see exactly which names exist before composing the
 * TELEGRAM_CATEGORIES allow-list in .env.
 *
 * Usage (host, dev stack up):
 *   docker exec actual_notifier_dev node /app/src/dev/list-categories.js
 * Or inside any container with the same env/dataDir access.
 */

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const actual = require('../actual');

async function main() {
  const handle = await actual.open();
  try {
    const categories = await actual.getCategories(handle.api);
    if (categories.length === 0) {
      console.log('No non-income categories found in this budget.');
      return;
    }
    console.log('Non-income categories (name = exact value for TELEGRAM_CATEGORIES):');
    for (const c of categories) {
      console.log(`  ${c.name}  [${c.id}]`);
    }
    console.log(`\n${categories.length} categories. Join a subset with commas in TELEGRAM_CATEGORIES.`);
  } finally {
    await actual.close(handle);
  }
}

main().catch((err) => {
  console.error(`LIST-CATEGORIES error: ${err.message}`);
  process.exit(1);
});
