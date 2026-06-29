// GRN completion inserts inventory rows without a batch number when none was
// entered on the receipt. Some deployments created inventories.batch_number as
// NOT NULL with no default, so the insert 500s with
// "Field 'batch_number' doesn't have a default value". Batch is optional
// metadata (inventory identity is product + warehouse), so make it nullable.
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
      `SELECT IS_NULLABLE, COLUMN_TYPE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'inventories'
         AND COLUMN_NAME = 'batch_number'
       LIMIT 1`
    );
    if (columns.length === 0) {
      console.log('inventories.batch_number does not exist — nothing to do');
      return;
    }
    if (columns[0].IS_NULLABLE !== 'YES') {
      const type = columns[0].COLUMN_TYPE || 'VARCHAR(100)';
      await pool.query(`ALTER TABLE inventories MODIFY COLUMN batch_number ${type} NULL DEFAULT NULL`);
      console.log('inventories.batch_number is now nullable');
    } else {
      console.log('inventories.batch_number is already nullable');
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
