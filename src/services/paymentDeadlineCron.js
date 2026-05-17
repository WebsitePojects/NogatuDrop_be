const cron = require('node-cron');
const pool = require('../config/db');
const env = require('../config/env');
const { sendEmail, EMAIL } = require('./emailService');
const { insertStockMovement } = require('../utils/stockMovementLogger');
const { insertNotification } = require('../utils/notificationWriter');
const { runWithCronLeaderLock } = require('./cronLeaderLock');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.sqlMessage || '').includes(columnName)
);

async function runPaymentDeadlineCheck() {
  const conn = await pool.getConnection();
  try {
    // Find approved orders where payment_deadline has passed and payment is still pending.
    const [expiredOrders] = await conn.execute(
      `SELECT o.id, o.order_number, o.partner_id, o.source_warehouse_id
       FROM orders o
       WHERE o.status = 'approved'
         AND o.payment_status IN ('pending', 'unpaid')
         AND o.payment_deadline IS NOT NULL
         AND o.payment_deadline < NOW()
         AND o.is_deleted = 0`
    );

    for (const order of expiredOrders) {
      await conn.beginTransaction();
      try {
        await conn.execute(
          `UPDATE orders
           SET status = 'cancelled',
               cancellation_reason = 'Payment deadline expired',
               cancelled_by = NULL,
               updated_at = NOW()
           WHERE id = ?`,
          [order.id]
        );

        let items = [];
        try {
          const [rows] = await conn.execute(
            'SELECT product_id, quantity, source_warehouse_id FROM order_items WHERE order_id = ?',
            [order.id]
          );
          items = rows;
        } catch (err) {
          if (!isMissingColumn(err, 'source_warehouse_id')) {
            throw err;
          }

          // Backward compatibility for databases where order_items has no source_warehouse_id.
          const [rows] = await conn.execute(
            'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
            [order.id]
          );
          items = rows.map((row) => ({ ...row, source_warehouse_id: null }));
        }

        for (const item of items) {
          const warehouseId = item.source_warehouse_id || order.source_warehouse_id;
          if (!warehouseId) continue;

          await conn.execute(
            `UPDATE inventories
             SET reserved_stock = GREATEST(0, reserved_stock - ?)
             WHERE product_id = ? AND warehouse_id = ?`,
            [item.quantity, item.product_id, warehouseId]
          );

          await insertStockMovement(conn, {
            productId: item.product_id,
            warehouseId,
            movementType: 'release',
            quantity: item.quantity,
            referenceType: 'order',
            referenceId: order.id,
            notes: 'Reserved stock released because payment deadline expired',
          });
        }

        await conn.commit();

        const [partnerUsers] = await pool.execute(
          `SELECT u.id, u.email, u.name
           FROM users u
           WHERE u.partner_id = ?
             AND u.is_deleted = 0
             AND u.status = 'active'`,
          [order.partner_id]
        );

        for (const pu of partnerUsers) {
          if (pu.email) {
            const tmpl = EMAIL.orderCancelledDeadline(order.order_number);
            await sendEmail({ to: pu.email, toName: pu.name, ...tmpl });
          }

          await insertNotification(pool, {
            userId: pu.id,
            type: 'order_cancelled',
            title: `Order Cancelled: ${order.order_number}`,
            message: `Order ${order.order_number} was auto-cancelled because the payment deadline passed.`,
            entityType: 'order',
            entityId: order.id,
          });
        }

        console.log(`[PaymentDeadlineCron] Cancelled order ${order.order_number} because the payment deadline expired`);
      } catch (innerErr) {
        await conn.rollback();
        console.error(`[PaymentDeadlineCron] Failed to cancel order ${order.order_number}:`, innerErr.message);
      }
    }

    if (expiredOrders.length > 0) {
      console.log(`[PaymentDeadlineCron] Processed ${expiredOrders.length} expired order(s)`);
    }
  } catch (err) {
    console.error('[PaymentDeadlineCron] Error:', err.message);
  } finally {
    conn.release();
  }
}

function startPaymentDeadlineCron() {
  cron.schedule(env.PAYMENT_DEADLINE_CRON, async () => {
    await runWithCronLeaderLock({
      lockKey: 'payment-deadline',
      task: runPaymentDeadlineCheck,
    });
  });
  console.log(`[PaymentDeadlineCron] Started - schedule: ${env.PAYMENT_DEADLINE_CRON}`);
}

module.exports = { startPaymentDeadlineCron, runPaymentDeadlineCheck };
