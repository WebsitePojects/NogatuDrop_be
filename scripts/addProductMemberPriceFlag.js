// Member price eligibility per product (Sir Dino, 2026-11-24): "Only for every product. Packages excluded."
//   products.member_price_eligible  TINYINT(1) NOT NULL DEFAULT 1
// Every product keeps the member price (1) until Super Admin unticks it on the Products form, which is how a
// package is excluded. Additive and idempotent. Dry run unless --apply.
// Usage: node --env-file=<env> scripts/addProductMemberPriceFlag.js [--apply]
const mysql = require('mysql2/promise');

const DDL = `ALTER TABLE products
  ADD COLUMN member_price_eligible TINYINT(1) NOT NULL DEFAULT 1 AFTER weight_grams`;

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
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME IN ('weight_grams', 'member_price_eligible')`
    );
    const names = cols.map((c) => c.COLUMN_NAME);
    if (!names.includes('weight_grams')) throw new Error('Run scripts/addShippingRates.js --apply first (products.weight_grams is missing).');
    if (names.includes('member_price_eligible')) {
      console.log('Already up to date. Nothing to do.');
      return;
    }
    console.log(`${apply ? 'run ' : 'plan'}  add products.member_price_eligible (every product keeps the member price)`);
    if (apply) await conn.query(DDL);
    else console.log('\nDry run only. Re-run with --apply.');
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
