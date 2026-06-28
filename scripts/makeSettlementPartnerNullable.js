// Legacy public orders were intentionally created against the unowned main
// warehouse. Their settlements are company-direct and therefore have no
// Stockist owner. New public orders use nearest-capable Stockist fulfillment,
// but this nullable column keeps historical payment verification operable.
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
      `SELECT IS_NULLABLE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'settlements'
         AND COLUMN_NAME = 'partner_id'
       LIMIT 1`
    );
    if (columns.length === 0) throw new Error('settlements.partner_id does not exist');
    if (columns[0].IS_NULLABLE !== 'YES') {
      await pool.query('ALTER TABLE settlements MODIFY COLUMN partner_id BIGINT UNSIGNED NULL');
      console.log('settlements.partner_id is now nullable');
    } else {
      console.log('settlements.partner_id is already nullable');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
