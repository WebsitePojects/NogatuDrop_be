// Lets the order email queue (order_notification_outbox) hold buyer emails as well as staff emails.
// A store buyer has no user account, so a queued buyer email names its address instead:
//   user_id          becomes NULL-able (NULL on buyer rows)
//   recipient_email  new; the buyer's address on buyer rows, NULL on staff rows
//   uq_order_notification_buyer  UNIQUE (order_id, event_type, recipient_email): one email per order,
//                    event and address, so a double click or retry cannot queue it twice. Staff rows keep
//                    their own unique key (order_id, user_id, event_type).
//
// Additive and idempotent: each step runs only when its column/index is missing. Dry run by default.
// Run: node --env-file=<env> scripts/addBuyerEmailOutbox.js [--apply]
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
      `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_notification_outbox'`
    );
    if (cols.length === 0) throw new Error('order_notification_outbox does not exist. Nothing changed.');
    const col = Object.fromEntries(cols.map((c) => [c.COLUMN_NAME, c]));
    const [idx] = await conn.execute(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_notification_outbox'`
    );
    const hasIndex = new Set(idx.map((i) => i.INDEX_NAME));

    const steps = [];
    if (col.user_id.IS_NULLABLE !== 'YES') {
      steps.push(['user_id may be empty (buyer emails)', 'ALTER TABLE order_notification_outbox MODIFY user_id BIGINT UNSIGNED NULL']);
    }
    if (!col.recipient_email) {
      steps.push(['add recipient_email', 'ALTER TABLE order_notification_outbox ADD COLUMN recipient_email VARCHAR(190) NULL AFTER user_id']);
    }
    if (!hasIndex.has('uq_order_notification_buyer')) {
      steps.push(['one buyer email per order and event', 'ALTER TABLE order_notification_outbox ADD UNIQUE KEY uq_order_notification_buyer (order_id, event_type, recipient_email)']);
    }

    if (steps.length === 0) console.log('Already up to date. Nothing to do.');
    for (const [label, sql] of steps) {
      console.log(`${apply ? 'run ' : 'would'}  ${label}`);
      if (apply) await conn.query(sql);
    }
    if (!apply && steps.length) console.log('Dry run only: nothing changed. Re-run with --apply.');
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
