const pool = require('../config/db');
const { sendEmail, EMAIL } = require('./emailService');
const crypto = require('crypto');
const { orderCustomerNameSql } = require('../utils/orderCustomerSql');
const { BUYER_EVENT_SET, loadBuyerEmailOrder, buildBuyerEmail } = require('./buyerEmails');

// Rows with a user_id email that staff member; rows with recipient_email instead are store-buyer emails
// (services/buyerEmails.js), built from the order at send time.
async function sendQueuedEmail(conn, job, sendEmailFn) {
  if (job.user_id == null) {
    if (!job.recipient_email || !BUYER_EVENT_SET.has(job.event_type)) throw new Error('Unknown buyer email row');
    const order = await loadBuyerEmailOrder(conn, job.order_id);
    if (!order) throw new Error('Order for buyer email is missing');
    const template = buildBuyerEmail(job.event_type, order);
    return sendEmailFn({ to: job.recipient_email, toName: order.customer_name, ...template, throwOnFailure: true });
  }
  const [users] = await conn.execute('SELECT email, name FROM users WHERE id = ? LIMIT 1', [job.user_id]);
  if (!users.length || !users[0].email) throw new Error('Notification recipient is unavailable');
  const template = EMAIL.orderPlaced(job.order_number, job.customer_name || 'customer');
  return sendEmailFn({ to: users[0].email, toName: users[0].name, ...template, throwOnFailure: true });
}

async function enqueueOrderNotifications(conn, { orderId, orderNumber, users, eventType = 'public_order_placed' }) {
  for (const user of users) {
    await conn.execute(
      `INSERT INTO order_notification_outbox
        (order_id, user_id, event_type, order_number, status, available_at)
       VALUES (?, ?, ?, ?, 'pending', NOW())
       ON DUPLICATE KEY UPDATE user_id = user_id`,
      [orderId, user.id, eventType, orderNumber],
    );
  }
}

async function processOrderNotificationOutbox({ batchSize = 25, maxAttempts = 5, connectionFactory = () => pool.getConnection(), sendEmailFn = sendEmail } = {}) {
  const conn = await connectionFactory();
  let processed = 0;
  try {
    await conn.execute(
      `UPDATE order_notification_outbox
       SET status = 'failed', locked_at = NULL, lease_token = NULL, last_error = 'notification delivery attempts exhausted'
       WHERE status = 'processing' AND locked_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE) AND attempts >= ?`,
      [maxAttempts],
    );
    const [jobs] = await conn.execute(
      `SELECT n.id, n.order_id, n.order_number, n.user_id, n.recipient_email, n.event_type, n.attempts,
              ${orderCustomerNameSql('o')} AS customer_name
       FROM order_notification_outbox n JOIN orders o ON o.id = n.order_id
       WHERE ((n.status IN ('pending', 'retry') AND n.available_at <= NOW())
          OR (n.status = 'processing' AND n.locked_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE)))
         AND n.attempts < ?
       ORDER BY n.id LIMIT ?`, [maxAttempts, batchSize],
    );
    for (const job of jobs) {
      const leaseToken = crypto.randomUUID();
      const [claimed] = await conn.execute(`UPDATE order_notification_outbox SET status = 'processing', attempts = attempts + 1, locked_at = NOW(), lease_token = ? WHERE id = ? AND attempts < ? AND ((status IN ('pending', 'retry') AND available_at <= NOW()) OR (status = 'processing' AND locked_at < DATE_SUB(NOW(), INTERVAL 15 MINUTE)))`, [leaseToken, job.id, maxAttempts]);
      if (claimed.affectedRows !== 1) continue;
      try {
        const result = await sendQueuedEmail(conn, job, sendEmailFn);
        // A recipient filtered out by EMAIL_ALLOWLIST (staging) is final: recorded, never retried.
        const note = result && result.skipped ? 'skipped: recipient not on EMAIL_ALLOWLIST' : null;
        await conn.execute(`UPDATE order_notification_outbox SET status = 'sent', sent_at = NOW(), last_error = ?, locked_at = NULL, lease_token = NULL WHERE id = ? AND lease_token = ?`, [note, job.id, leaseToken]);
        processed += 1;
      } catch (error) {
        const terminal = Number(job.attempts) + 1 >= maxAttempts;
        await conn.execute(`UPDATE order_notification_outbox SET status = ?, available_at = DATE_ADD(NOW(), INTERVAL LEAST(60 * POW(2, attempts), 3600) SECOND), last_error = ?, locked_at = NULL, lease_token = NULL WHERE id = ? AND lease_token = ?`, [terminal ? 'failed' : 'retry', 'notification delivery failed', job.id, leaseToken]);
      }
    }
    return processed;
  } finally {
    conn.release();
  }
}

module.exports = { enqueueOrderNotifications, processOrderNotificationOutbox };
