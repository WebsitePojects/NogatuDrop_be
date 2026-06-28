// Add destination coordinate columns to orders so public orders can carry the
// buyer's pinned delivery location (lat/lng). Idempotent — safe to re-run.
// These coordinates are sensitive personal data: they are returned ONLY to the
// rider magic-link and authenticated office views, never on public tracking.
// Run: node --env-file=.env.dev scripts/addOrderDestinationCoords.js
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
    ['customer_lat', 'DECIMAL(10,7) NULL'],
    ['customer_lng', 'DECIMAL(10,7) NULL'],
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
