// Associates staff/stockist users with the warehouse they operate out of, so
// GRN, stock movements, and delivery dispatch can be scoped without relying
// solely on partner_id. Idempotent — safe to re-run.
// Run: node --env-file=.env.dev scripts/addUserWarehouse.js
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
         AND TABLE_NAME = 'users'
         AND COLUMN_NAME = 'warehouse_id'
       LIMIT 1`
    );
    if (columns.length > 0) {
      console.log('users.warehouse_id already exists — skipping');
    } else {
      await pool.query('ALTER TABLE users ADD COLUMN warehouse_id BIGINT UNSIGNED NULL AFTER partner_id');
      console.log('Added users.warehouse_id');
    }

    const [indexes] = await pool.execute(
      `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'users'
         AND INDEX_NAME = 'idx_users_warehouse'
       LIMIT 1`
    );
    if (indexes.length > 0) {
      console.log('idx_users_warehouse already exists — skipping');
    } else {
      await pool.query('ALTER TABLE users ADD INDEX idx_users_warehouse (warehouse_id)');
      console.log('Added index idx_users_warehouse');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
