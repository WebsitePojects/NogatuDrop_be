// Schema for management round 4 (2026-10-08):
//   orders.payment_covered_total     the order total the buyer's receipts cover. When staff raise the delivery
//                                    fee after a receipt, total_amount > payment_covered_total = money still owed.
//   order_payment_proofs             every receipt a buyer uploads (first payment and extra payments), kept for
//                                    review. UNIQUE (order_id, covers_total): one receipt per total, so a double
//                                    submit cannot record two.
//   order_fee_adjustments            who changed an order's delivery fee, from what to what, and why.
//   stockist_territories             provinces and cities a Stockist serves for store orders. UNIQUE
//                                    (area_type, area_code): one Stockist per area, so routing is never a tie.
// Plus one data step: receipts uploaded before this change are recorded as covering their order's total.
//
// Additive and idempotent: each step checks information_schema first. Dry run unless --apply.
// Usage: node --env-file=.env.prod scripts/addFeeReceiptTerritorySchema.js [--apply]
const mysql = require('mysql2/promise');

async function columnExists(pool, table, column) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function tableExists(pool, table) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [table]
  );
  return rows.length > 0;
}

const CREATE_TABLES = {
  order_payment_proofs: `CREATE TABLE order_payment_proofs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNSIGNED NOT NULL,
    proof_url VARCHAR(500) NOT NULL,
    covers_total DECIMAL(15,2) NOT NULL,
    kind ENUM('payment','additional') NOT NULL DEFAULT 'payment',
    uploaded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_order_payment_proofs_total (order_id, covers_total),
    CONSTRAINT fk_order_payment_proofs_order FOREIGN KEY (order_id) REFERENCES orders (id)
  )`,
  order_fee_adjustments: `CREATE TABLE order_fee_adjustments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNSIGNED NOT NULL,
    old_shipping_fee DECIMAL(15,2) NOT NULL,
    new_shipping_fee DECIMAL(15,2) NOT NULL,
    old_total DECIMAL(15,2) NOT NULL,
    new_total DECIMAL(15,2) NOT NULL,
    reason VARCHAR(255) NOT NULL,
    adjusted_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_order_fee_adjustments_order (order_id),
    CONSTRAINT fk_order_fee_adjustments_order FOREIGN KEY (order_id) REFERENCES orders (id),
    CONSTRAINT fk_order_fee_adjustments_user FOREIGN KEY (adjusted_by) REFERENCES users (id)
  )`,
  stockist_territories: `CREATE TABLE stockist_territories (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    partner_id BIGINT UNSIGNED NOT NULL,
    area_type ENUM('province','city') NOT NULL,
    area_code CHAR(9) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_stockist_territories_area (area_type, area_code),
    KEY idx_stockist_territories_partner (partner_id),
    CONSTRAINT fk_stockist_territories_partner FOREIGN KEY (partner_id) REFERENCES partners (id),
    CONSTRAINT fk_stockist_territories_user FOREIGN KEY (created_by) REFERENCES users (id)
  )`,
};

// Receipts uploaded before this change: the receipt covered the total at that time, which is still the
// total because nothing could change it yet. INSERT IGNORE + the unique key make re-runs a no-op.
const BACKFILL_COVERED = `UPDATE orders SET payment_covered_total = total_amount
  WHERE payment_proof_url IS NOT NULL AND payment_covered_total IS NULL`;
const BACKFILL_PROOFS = `INSERT IGNORE INTO order_payment_proofs (order_id, proof_url, covers_total, kind, uploaded_at)
  SELECT id, payment_proof_url, total_amount, 'payment', COALESCE(payment_proof_uploaded_at, NOW())
  FROM orders WHERE payment_proof_url IS NOT NULL`;

/** Lists the DDL still needed. Names come from the constants above, never from input. */
async function plannedStatements(pool) {
  const statements = [];
  if (!(await columnExists(pool, 'orders', 'payment_covered_total'))) {
    statements.push('ALTER TABLE orders ADD COLUMN payment_covered_total DECIMAL(15,2) NULL AFTER payment_proof_uploaded_at');
  }
  for (const [table, ddl] of Object.entries(CREATE_TABLES)) {
    if (!(await tableExists(pool, table))) statements.push(ddl);
  }
  return statements;
}

async function backfillCounts(pool) {
  if (!(await columnExists(pool, 'orders', 'payment_covered_total'))) {
    const [[row]] = await pool.query('SELECT COUNT(*) n FROM orders WHERE payment_proof_url IS NOT NULL');
    return { covered: Number(row.n), proofs: Number(row.n) };
  }
  const [[covered]] = await pool.query('SELECT COUNT(*) n FROM orders WHERE payment_proof_url IS NOT NULL AND payment_covered_total IS NULL');
  const proofs = (await tableExists(pool, 'order_payment_proofs'))
    ? (await pool.query(`SELECT COUNT(*) n FROM orders o WHERE o.payment_proof_url IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM order_payment_proofs p WHERE p.order_id = o.id)`))[0][0].n
    : (await pool.query('SELECT COUNT(*) n FROM orders WHERE payment_proof_url IS NOT NULL'))[0][0].n;
  return { covered: Number(covered.n), proofs: Number(proofs) };
}

async function main() {
  if (!process.env.DB_NAME) throw new Error('DB_NAME is not set. Run with --env-file=<.env.dev|.env.prod>.');
  const apply = process.argv.includes('--apply');
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });
  try {
    const statements = await plannedStatements(pool);
    const pending = await backfillCounts(pool);
    console.log(`Database: ${process.env.DB_NAME}  mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
    if (statements.length === 0 && pending.covered === 0 && pending.proofs === 0) {
      console.log('Nothing to do — schema already up to date.');
      return;
    }
    for (const sql of statements) {
      console.log(`${apply ? 'run ' : 'plan'}  ${sql.split('\n')[0]}`);
      if (apply) await pool.query(sql);
    }
    console.log(`${apply ? 'run ' : 'plan'}  record earlier receipts: ${pending.covered} order totals, ${pending.proofs} receipt rows`);
    if (apply) {
      await pool.query(BACKFILL_COVERED);
      await pool.query(BACKFILL_PROOFS);
    }
    if (!apply) console.log('\nDry run only. Re-run with --apply to make these changes.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('ERR', error.message);
    process.exit(1);
  });
}

module.exports = { plannedStatements };
