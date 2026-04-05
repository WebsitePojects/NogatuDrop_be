const cron = require('node-cron');
const pool = require('../config/db');
const env = require('../config/env');
const { sendEmail, EMAIL } = require('./emailService');

async function runPaymentDeadlineCheck() {
  const conn = await pool.getConnection();
  try {
    // Find approved orders where payment_deadline has passed and payment is still pending
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
        // Cancel the order
        await conn.execute(
          `UPDATE orders
           SET status = 'cancelled',
               cancellation_reason = 'Payment deadline expired',
               cancelled_by = NULL,
               updated_at = NOW()
           WHERE id = ?`,
          [order.id]
        );

        // Release reserved stock for all items
        const [items] = await conn.execute(
          'SELECT product_id, quantity, source_warehouse_id FROM order_items WHERE order_id = ?',
          [order.id]
        );

        for (const item of items) {
          const warehouseId = item.source_warehouse_id || order.source_warehouse_id;
          if (warehouseId) {
            await conn.execute(
              `UPDATE inventories
               SET reserved_stock = GREATEST(0, reserved_stock - ?)
               WHERE product_id = ? AND warehouse_id = ?`,
              [item.quantity, item.product_id, warehouseId]
            );

            // Log stock movement
            await conn.execute(
              `INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity_change, reference_type, reference_id, notes)
               VALUES (?, ?, 'release', ?, 'order', ?, 'Reserved stock released — payment deadline expired')`,
              [item.product_id, warehouseId, item.quantity, order.id]
            );
          }
        }

        await conn.commit();

        // Notify stockist users via email
        const [partnerUsers] = await pool.execute(
          `SELECT u.email, u.name FROM users u WHERE u.partner_id = ? AND u.is_deleted = 0 AND u.status = 'active'`,
          [order.partner_id]
        );

        for (const pu of partnerUsers) {
          if (pu.email) {
            const tmpl = EMAIL.orderCancelledDeadline(order.order_number);
            await sendEmail({ to: pu.email, toName: pu.name, ...tmpl });
          }

          // In-app notification
          await pool.execute(
            `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
             VALUES (?, 'order_cancelled', ?, ?, 'order', ?)`,
            [
              pu.id,
              `Order Cancelled: ${order.order_number}`,
              `Order ${order.order_number} was auto-cancelled — payment deadline passed.`,
              order.id,
            ]
          );
        }

        console.log(`[PaymentDeadlineCron] Cancelled order ${order.order_number} — deadline expired`);
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
  cron.schedule(env.PAYMENT_DEADLINE_CRON, runPaymentDeadlineCheck);
  console.log(`[PaymentDeadlineCron] Started — schedule: ${env.PAYMENT_DEADLINE_CRON}`);
}

module.exports = { startPaymentDeadlineCron };
