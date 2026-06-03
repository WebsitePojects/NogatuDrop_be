const fs = require('node:fs/promises');
const path = require('node:path');

const pool = require('../src/config/db');

const criticalTables = [
  'users',
  'orders',
  'order_items',
  'inventories',
  'settlements',
  'delivery_tracking',
  'stock_movements',
];

async function getTableCounts() {
  const counts = {};

  for (const table of criticalTables) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    counts[table] = Number(rows[0]?.total || 0);
  }

  return counts;
}

async function getSampleReferences() {
  const [orderRows] = await pool.query(
    'SELECT order_number FROM orders WHERE is_deleted = 0 ORDER BY id DESC LIMIT 3'
  );
  const [userRows] = await pool.query(
    'SELECT email FROM users WHERE is_deleted = 0 ORDER BY id ASC LIMIT 5'
  );

  return {
    recent_order_numbers: orderRows.map((row) => row.order_number),
    sample_user_emails: userRows.map((row) => row.email),
  };
}

async function run() {
  const snapshot = {
    captured_at: new Date().toISOString(),
    counts: await getTableCounts(),
    references: await getSampleReferences(),
  };

  const outputPath =
    process.env.BASELINE_OUTPUT ||
    path.resolve(process.cwd(), 'operational-baseline.json');

  await fs.writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({ outputPath, snapshot }, null, 2));
}

run()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode || 0);
  });
