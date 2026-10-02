const cron = require('node-cron');
const env = require('../config/env');
const { runWithCronLeaderLock } = require('./cronLeaderLock');
const { processOrderNotificationOutbox } = require('./orderNotificationOutbox');

// Rows are claimed with a lease and retried with backoff inside processOrderNotificationOutbox;
// this job only has to drain the queue on a schedule so enqueued emails are not left pending.
async function runOrderNotificationOutbox() {
  try {
    const sent = await processOrderNotificationOutbox({ batchSize: 25, maxAttempts: 5 });
    if (sent > 0) {
      console.log(`[OrderNotificationOutboxCron] Sent ${sent} order notification(s)`);
    }
  } catch (err) {
    console.error('[OrderNotificationOutboxCron] Error:', err.message);
  }
}

function startOrderNotificationOutboxCron() {
  cron.schedule(env.ORDER_NOTIFICATION_OUTBOX_CRON, async () => {
    await runWithCronLeaderLock({
      lockKey: 'order-notification-outbox',
      task: runOrderNotificationOutbox,
    });
  });
  console.log(`[OrderNotificationOutboxCron] Started — schedule: ${env.ORDER_NOTIFICATION_OUTBOX_CRON}`);
}

module.exports = {
  startOrderNotificationOutboxCron,
  runOrderNotificationOutbox,
};
