// Member price columns (Sir Dino, 2026-11-24 / 2026-11-26):
//   products.member_price_eligible    TINYINT(1) NOT NULL DEFAULT 1
//     "Only for every product. Packages excluded." Every product keeps the member price (1) until Super Admin
//     unticks it on the Products form, which is how a package is excluded.
//   order_items.regular_unit_price    DECIMAL(10,2) NULL
//     The price before the member discount, saved at checkout, so "Remove member price" restores exactly what
//     the buyer would have paid that day (a discounted price rounded to the centavo cannot be reversed).
//     Orders placed before this column have NULL and are rejected instead.
// Additive and idempotent: each column is added only when missing. Dry run unless --apply.
// Usage: node --env-file=<env> scripts/addProductMemberPriceFlag.js [--apply]
const mysql = require('mysql2/promise');

const STEPS = [
  {
    table: 'products',
    column: 'member_price_eligible',
    note: 'every product keeps the member price',
    ddl: 'ALTER TABLE products ADD COLUMN member_price_eligible TINYINT(1) NOT NULL DEFAULT 1 AFTER weight_grams',
  },
  {
    table: 'order_items',
    column: 'regular_unit_price',
    note: 'price before the member discount, for "Remove member price"',
    ddl: 'ALTER TABLE order_items ADD COLUMN regular_unit_price DECIMAL(10,2) NULL AFTER unit_price',
  },
];

async function main() {
  if (!process.env.DB_NAME) throw new Error('DB_NAME is not set. Run with --env-file=<env>.');
  const apply = process.argv.includes('--apply');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });
  try {
    console.log(`Database: ${process.env.DB_NAME}  mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
    const [cols] = await conn.execute(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND ((TABLE_NAME = 'products' AND COLUMN_NAME IN ('weight_grams', 'member_price_eligible'))
           OR (TABLE_NAME = 'order_items' AND COLUMN_NAME = 'regular_unit_price'))`
    );
    const has = new Set(cols.map((c) => `${c.TABLE_NAME}.${c.COLUMN_NAME}`));
    if (!has.has('products.weight_grams')) throw new Error('Run scripts/addShippingRates.js --apply first (products.weight_grams is missing).');

    const todo = STEPS.filter((step) => !has.has(`${step.table}.${step.column}`));
    if (todo.length === 0) {
      console.log('Already up to date. Nothing to do.');
      return;
    }
    for (const step of todo) {
      console.log(`${apply ? 'run ' : 'plan'}  add ${step.table}.${step.column} (${step.note})`);
      if (apply) await conn.query(step.ddl);
    }
    if (!apply) console.log('\nDry run only. Re-run with --apply.');
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
