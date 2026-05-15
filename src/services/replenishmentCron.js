const cron = require('node-cron');
const pool = require('../config/db');
const env = require('../config/env');
const generateOrderNum = require('../utils/generateOrderNum');
const { sendEmail, EMAIL } = require('./emailService');
const { insertNotification } = require('../utils/notificationWriter');

function startReplenishmentCron() {
  console.log(`[ReplenishmentCron] Started — schedule: ${env.REPLENISH_CRON}`);

  cron.schedule(env.REPLENISH_CRON, async () => {
    let conn;
    try {
      conn = await pool.getConnection();

      // Find inventory items at or below reorder threshold
      const [lowStockItems] = await conn.execute(`
        SELECT i.id, i.product_id, i.warehouse_id, i.current_stock, i.reorder_threshold,
               p.name AS product_name, p.partner_price, p.sku,
               w.name AS warehouse_name
        FROM inventories i
        JOIN products p ON p.id = i.product_id
        JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.is_active = 1
          AND p.is_deleted = 0
          AND w.is_deleted = 0
          AND i.current_stock <= i.reorder_threshold
      `);

      if (lowStockItems.length === 0) return;

      // Get all super_admin users for notifications
      const [admins] = await conn.execute(`
        SELECT u.id, u.email, u.name FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active'
      `);

      if (admins.length === 0) return;

      for (const item of lowStockItems) {
        // Skip if a pending auto-PO already exists for this product
        const [existingPO] = await conn.execute(`
          SELECT po.id FROM purchase_orders po
          JOIN po_items pi ON pi.po_id = po.id
          WHERE po.auto_generated = 1
            AND po.status = 'pending'
            AND po.is_deleted = 0
            AND pi.product_id = ?
          LIMIT 1
        `, [item.product_id]);

        if (existingPO.length > 0) continue;

        const reorderQty = item.reorder_threshold * 2;
        const totalAmount = reorderQty * item.partner_price;
        const poNumber = await generateOrderNum('PO', 'purchase_orders', 'po_number');

        await conn.beginTransaction();
        try {
          const [poResult] = await conn.execute(`
            INSERT INTO purchase_orders (po_number, supplier, created_by, status, auto_generated, total_amount, notes)
            VALUES (?, 'Nogatu Manufacturing', ?, 'pending', 1, ?, ?)
          `, [poNumber, admins[0].id, totalAmount, `Auto-generated: ${item.product_name} low stock at ${item.warehouse_name}`]);

          const poId = poResult.insertId;

          await conn.execute(`
            INSERT INTO po_items (po_id, product_id, supplier, quantity, unit_price)
            VALUES (?, ?, 'Nogatu Manufacturing', ?, ?)
          `, [poId, item.product_id, reorderQty, item.partner_price]);

          // In-app notifications for all admins
          for (const admin of admins) {
            await insertNotification(conn, {
              userId: admin.id,
              type: 'low_stock',
              title: `Low Stock: ${item.product_name}`,
              message: `${item.product_name} at ${item.warehouse_name} is at ${item.current_stock} units. Auto PO ${poNumber} generated.`,
              entityType: 'purchase_order',
              entityId: poId,
            });
          }

          await conn.commit();

          // Email all super admins
          for (const admin of admins) {
            const lowTmpl = EMAIL.lowStock(item.product_name, item.warehouse_name, item.current_stock);
            await sendEmail({ to: admin.email, toName: admin.name, ...lowTmpl });

            const poTmpl = EMAIL.autoPO(poNumber, item.product_name);
            await sendEmail({ to: admin.email, toName: admin.name, ...poTmpl });
          }

          console.log(`[ReplenishmentCron] Auto PO ${poNumber} created for ${item.product_name}`);
        } catch (txErr) {
          await conn.rollback();
          console.error(`[ReplenishmentCron] Transaction failed for ${item.product_name}:`, txErr.message);
        }
      }
    } catch (err) {
      console.error('[ReplenishmentCron] Error:', err.message);
    } finally {
      if (conn) conn.release();
    }
  });
}

module.exports = { startReplenishmentCron };
