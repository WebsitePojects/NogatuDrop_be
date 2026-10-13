// Real-database proof that a buyer email is queued once however often its status change is retried, and
// that the outbox sends it to the buyer (or records an EMAIL_ALLOWLIST skip without retrying).
// Run: NCDMS_DB_TESTS=1 node --env-file=<env> --test --test-force-exit test/buyerEmails.integration.test.js
// Stop the local API first: its outbox cron would race this test for the queued rows.
const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs the local database)' };

let pool;
let buyer;
let outbox;
let orderId;
let originalEmail;

test.before(async () => {
  if (!enabled) return;
  pool = require('../src/config/db');
  buyer = require('../src/services/buyerEmails');
  outbox = require('../src/services/orderNotificationOutbox');
  const [[order]] = await pool.execute("SELECT id, customer_email FROM orders WHERE placed_by_type = 'public' ORDER BY id DESC LIMIT 1");
  assert.ok(order, 'needs one store order in the local database');
  orderId = order.id;
  originalEmail = order.customer_email;
  await pool.execute("UPDATE orders SET customer_email = 'buyer.test@example.com' WHERE id = ?", [orderId]);
  await pool.execute('DELETE FROM order_notification_outbox WHERE order_id = ? AND user_id IS NULL', [orderId]); // test rows only
});

test.after(async () => {
  if (!enabled) return;
  await pool.execute('DELETE FROM order_notification_outbox WHERE order_id = ? AND user_id IS NULL', [orderId]);
  await pool.execute('UPDATE orders SET customer_email = ? WHERE id = ?', [originalEmail, orderId]);
  await pool.end();
});

const countRows = async (eventType) => {
  const [[row]] = await pool.execute(
    'SELECT COUNT(*) AS n FROM order_notification_outbox WHERE order_id = ? AND event_type = ? AND user_id IS NULL', [orderId, eventType]
  );
  return Number(row.n);
};

test('the same buyer email queued twice, then three times at once, is queued once', opts, async () => {
  const event = buyer.BUYER_EVENTS.APPROVED;
  await buyer.enqueueBuyerEmail(pool, { orderId, eventType: event });
  await buyer.enqueueBuyerEmail(pool, { orderId, eventType: event });
  await Promise.all([1, 2, 3].map(() => buyer.enqueueBuyerEmail(pool, { orderId, eventType: event })));
  assert.equal(await countRows(event), 1);
});

test('an order without a buyer email queues nothing', opts, async () => {
  await pool.execute('UPDATE orders SET customer_email = NULL WHERE id = ?', [orderId]);
  await buyer.enqueueBuyerEmail(pool, { orderId, eventType: buyer.BUYER_EVENTS.PAID });
  assert.equal(await countRows(buyer.BUYER_EVENTS.PAID), 0);
  await pool.execute("UPDATE orders SET customer_email = 'buyer.test@example.com' WHERE id = ?", [orderId]);
});

test('the outbox emails the buyer, and an allowlist skip is final', opts, async () => {
  await buyer.enqueueBuyerEmail(pool, { orderId, eventType: buyer.BUYER_EVENTS.DELIVERED });
  const sent = [];
  const sendEmailFn = async (msg) => {
    sent.push(msg);
    return msg.subject.includes('approved') ? { sent: false, skipped: true } : { sent: true };
  };
  // The worker takes 25 rows a run, oldest first; other queued rows in the local copy may come first.
  for (let run = 0; run < 20 && (await outbox.processOrderNotificationOutbox({ sendEmailFn, spacingMs: 0 })) > 0; run += 1);
  const mine = sent.filter((m) => m.to === 'buyer.test@example.com');
  assert.equal(mine.length, 2, 'approved + delivered');
  assert.ok(mine.some((m) => /delivered/i.test(m.subject)));
  const [rows] = await pool.execute(
    'SELECT event_type, status, last_error FROM order_notification_outbox WHERE order_id = ? AND user_id IS NULL ORDER BY id', [orderId]
  );
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'sent']);
  assert.match(String(rows.find((r) => r.event_type === buyer.BUYER_EVENTS.APPROVED).last_error), /EMAIL_ALLOWLIST/);
  // Nothing left to send: a second run sends nothing more.
  const again = [];
  await outbox.processOrderNotificationOutbox({ sendEmailFn: async (msg) => { again.push(msg); return { sent: true }; } });
  assert.equal(again.filter((m) => m.to === 'buyer.test@example.com').length, 0);
});
