// Member discount audit fields on orders: which Nogatu member username claimed a
// discount and the % applied (verified live against the MLM bridge at checkout).
// Idempotent. Run: node --env-file=.env.dev scripts/addOrderMemberFields.js
const mysql = require('mysql2/promise');

async function columnExists(pool, table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0].n > 0;
}

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nogatu_ncdms',
  });

  const cols = [
    ['member_username', 'VARCHAR(64) NULL'],
    ['member_discount_pct', 'DECIMAL(5,2) NULL'],
  ];
  for (const [name, type] of cols) {
    if (await columnExists(pool, 'orders', name)) {
      console.log(`orders.${name} already exists — skipping`);
    } else {
      await pool.execute(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
      console.log(`Added orders.${name}`);
    }
  }
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
