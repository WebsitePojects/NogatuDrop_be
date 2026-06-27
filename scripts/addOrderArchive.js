// Order Archive: "delete" in the UI must NOT destroy data — it archives the
// order so it leaves the active list but its record (and revenue) stays forever
// for accurate calculations. This adds the archive flag/timestamp. Idempotent.
// Reports intentionally DO NOT filter on is_archived, so archived orders keep
// counting in totals. Run: node --env-file=.env.dev scripts/addOrderArchive.js
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
    ['is_archived', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['archived_at', 'TIMESTAMP NULL DEFAULT NULL'],
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
