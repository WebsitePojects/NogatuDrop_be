// Adds goods_receipts.client_ref + UNIQUE index uq_grn_client_ref, the duplicate-safety
// mechanism behind POST /grn/quick-receive (see src/services/stockReceiving.js).
// Idempotent — safe to re-run. Mirrors sql/grn_quick_receive_2026_10_02.sql.
// Run: node --env-file=.env.dev scripts/addGrnClientRef.js
const mysql = require('mysql2/promise');

async function main() {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nogatu_ncdms',
  });

  try {
    const [columns] = await pool.execute(
      `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'goods_receipts'
         AND COLUMN_NAME = 'client_ref'
       LIMIT 1`
    );
    if (columns.length > 0) {
      console.log('goods_receipts.client_ref already exists — skipping');
    } else {
      await pool.query('ALTER TABLE goods_receipts ADD COLUMN client_ref VARCHAR(64) NULL AFTER notes');
      console.log('Added goods_receipts.client_ref');
    }

    const [indexes] = await pool.execute(
      `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'goods_receipts'
         AND INDEX_NAME = 'uq_grn_client_ref'
       LIMIT 1`
    );
    if (indexes.length > 0) {
      console.log('uq_grn_client_ref already exists — skipping');
    } else {
      await pool.query('ALTER TABLE goods_receipts ADD UNIQUE INDEX uq_grn_client_ref (client_ref)');
      console.log('Added unique index uq_grn_client_ref');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
