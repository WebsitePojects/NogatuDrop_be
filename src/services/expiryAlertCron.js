const cron = require('node-cron');
const pool = require('../config/db');
const env = require('../config/env');
const { sendEmail, EMAIL } = require('./emailService');
const { insertNotification } = require('../utils/notificationWriter');
const { runWithCronLeaderLock } = require('./cronLeaderLock');

async function runExpiryAlert() {
  try {
    const [batches] = await pool.execute(
      `SELECT i.id, i.product_id, i.warehouse_id, i.expiry_date, i.current_stock,
              p.name AS product_name, w.name AS warehouse_name
       FROM inventories i
       JOIN products p ON p.id = i.product_id
       JOIN warehouses w ON w.id = i.warehouse_id
       WHERE i.expiry_date IS NOT NULL
         AND i.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
         AND i.current_stock > 0
         AND i.is_deleted = 0`
    );

    if (batches.length === 0) return;

    const [admins] = await pool.execute(
      `SELECT u.id, u.email, u.name FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active'`
    );

    for (const batch of batches) {
      const expiryFormatted = batch.expiry_date;

      for (const admin of admins) {
        const tmpl = EMAIL.batchExpiry(batch.product_name, expiryFormatted, batch.warehouse_name);
        await sendEmail({ to: admin.email, toName: admin.name, ...tmpl });

        await insertNotification(pool, {
          userId: admin.id,
          type: 'expiry_alert',
          title: `Expiry Alert: ${batch.product_name}`,
          message: `${batch.product_name} at ${batch.warehouse_name} expires on ${expiryFormatted}. Current stock: ${batch.current_stock}`,
          entityType: 'inventory',
          entityId: batch.id,
        });
      }

      console.log(`[ExpiryAlertCron] Alert sent for ${batch.product_name} (expires ${expiryFormatted})`);
    }
  } catch (err) {
    console.error('[ExpiryAlertCron] Error:', err.message);
  }
}

function startExpiryAlertCron() {
  cron.schedule(env.EXPIRY_ALERT_CRON, async () => {
    await runWithCronLeaderLock({
      lockKey: 'expiry-alert',
      task: runExpiryAlert,
    });
  });
  console.log(`[ExpiryAlertCron] Started â€” schedule: ${env.EXPIRY_ALERT_CRON}`);
}

module.exports = {
  startExpiryAlertCron,
  runExpiryAlert,
};
