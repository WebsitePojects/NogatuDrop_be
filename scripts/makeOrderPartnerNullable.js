// Public orders ship directly from the main warehouse and are NOT owned by any
// Stockist, so orders.partner_id must allow NULL. The FK to partners still holds
// for non-null values. Idempotent. Run before deploying the public-order change:
//   node --env-file=.env.prod scripts/makeOrderPartnerNullable.js
const mysql = require('mysql2/promise');

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nogatu_ncdms',
  });
  const [c] = await pool.execute(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'partner_id'`
  );
  if (c[0] && c[0].IS_NULLABLE === 'YES') {
    console.log('orders.partner_id already nullable — nothing to do');
  } else {
    await pool.execute('ALTER TABLE orders MODIFY COLUMN partner_id BIGINT UNSIGNED NULL');
    console.log('orders.partner_id is now NULLable (public orders carry no Stockist)');
  }
  await pool.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
