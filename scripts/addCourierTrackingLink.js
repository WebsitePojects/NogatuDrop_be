// Lets an order shipped by Grab or Lalamove carry the "share tracking" link staff paste from the courier's
// app (management, 2026-10-29), next to the waybill used for J&T/LBC/Flash:
//   delivery_tracking.courier_tracking_link  VARCHAR(500) NULL  (share links run longer than a waybill)
//
// Additive and idempotent: runs only when the column is missing. Dry run by default.
// Run: node --env-file=<env> scripts/addCourierTrackingLink.js [--apply]
const mysql = require('mysql2/promise');

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.DB_NAME) throw new Error('DB_NAME is not set. Run with --env-file=<env>.');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME,
  });
  try {
    console.log(`Database: ${process.env.DB_NAME}  mode: ${apply ? 'APPLY' : 'dry run'}`);
    const [cols] = await conn.execute(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'delivery_tracking'`
    );
    if (cols.length === 0) throw new Error('delivery_tracking does not exist. Nothing changed.');
    if (cols.some((c) => c.COLUMN_NAME === 'courier_tracking_link')) {
      console.log('Already up to date. Nothing to do.');
      return;
    }
    console.log(`${apply ? 'run ' : 'would'}  add courier_tracking_link (Grab / Lalamove share link)`);
    if (apply) {
      await conn.query('ALTER TABLE delivery_tracking ADD COLUMN courier_tracking_link VARCHAR(500) NULL AFTER courier_tracking_number');
    } else {
      console.log('Dry run only: nothing changed. Re-run with --apply.');
    }
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
