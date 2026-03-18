const cron = require('node-cron');
const pool = require('../config/db');
const env = require('../config/env');
const generateOrderNum = require('../utils/generateOrderNum');
const { sendSMS, SMS_TEMPLATES } = require('./smsService');

function startReplenishmentCron() {
  console.log(`[Cron] Replenishment check scheduled: ${env.REPLENISH_CRON}`);

  cron.schedule(env.REPLENISH_CRON, async () => {
    console.log('[Cron] Running replenishment check...');
    let conn;
    try {
      conn = await pool.getConnection();

      // Find inventory items at or below reorder threshold
      const [lowStockItems] = await conn.execute(`
        SELECT i.id, i.product_id, i.warehouse_id, i.current_stock, i.reorder_threshold,
               p.name AS product_name, p.partner_price, p.sku,
               w.name AS warehouse_name, w.manager_phone
        FROM inventories i
        JOIN products p ON p.id = i.product_id
        JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.is_active = 1
          AND p.is_deleted = 0
          AND w.is_deleted = 0
          AND i.current_stock <= i.reorder_threshold
      `);

      if (lowStockItems.length === 0) {
        console.log('[Cron] No low-stock items found.');
        return;
      }

      for (const item of lowStockItems) {
        // Check if there's already a pending auto-PO for this product
        const [existingPO] = await conn.execute(`
          SELECT po.id FROM purchase_orders po
          JOIN po_items pi ON pi.po_id = po.id
          WHERE po.auto_generated = 1
            AND po.status = 'pending'
            AND po.is_deleted = 0
            AND pi.product_id = ?
          LIMIT 1
        `, [item.product_id]);

        if (existingPO.length > 0) {
          continue; // Skip, there's already a pending auto-PO
        }

        // Get super_admin user id for created_by
        const [admins] = await conn.execute(`
          SELECT u.id FROM users u
          JOIN roles r ON r.id = u.role_id
          WHERE r.slug = 'super_admin' AND u.is_deleted = 0
          LIMIT 1
        `);

        if (admins.length === 0) continue;

        const adminId = admins[0].id;
        const reorderQty = item.reorder_threshold * 2;
        const totalAmount = reorderQty * item.partner_price;

        const poNumber = await generateOrderNum('PO', 'purchase_orders', 'po_number');

        await conn.beginTransaction();

        try {
          // Create purchase order
          const [poResult] = await conn.execute(`
            INSERT INTO purchase_orders (po_number, supplier, created_by, status, auto_generated, total_amount, notes)
            VALUES (?, 'Nogatu Manufacturing', ?, 'pending', 1, ?, ?)
          `, [poNumber, adminId, totalAmount, `Auto-generated: ${item.product_name} low stock at ${item.warehouse_name}`]);

          const poId = poResult.insertId;

          // Create PO item
          await conn.execute(`
            INSERT INTO po_items (po_id, product_id, supplier, quantity, unit_price)
            VALUES (?, ?, 'Nogatu Manufacturing', ?, ?)
          `, [poId, item.product_id, reorderQty, item.partner_price]);

          // Create notification
          const notifType = item.current_stock === 0 ? 'no_stock' : 'low_stock';
          const notifTitle = item.current_stock === 0
            ? `Out of Stock: ${item.product_name}`
            : `Low Stock Alert: ${item.product_name}`;
          const notifMessage = item.current_stock === 0
            ? `${item.product_name} at ${item.warehouse_name} is out of stock. Auto PO ${poNumber} has been generated.`
            : `${item.product_name} at ${item.warehouse_name} is at ${item.current_stock} units (threshold: ${item.reorder_threshold}). Auto PO ${poNumber} has been generated.`;

          await conn.execute(`
            INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id, location, sms_sent)
            VALUES (?, ?, ?, ?, 'purchase_order', ?, ?, ?)
          `, [adminId, notifType, notifTitle, notifMessage, poId, item.warehouse_name, 0]);

          await conn.commit();

          // Send SMS to warehouse manager
          if (item.manager_phone) {
            const smsMsg = item.current_stock === 0
              ? SMS_TEMPLATES.NO_STOCK(item.product_name, item.warehouse_name)
              : SMS_TEMPLATES.LOW_STOCK(item.product_name, item.warehouse_name, item.current_stock);
            await sendSMS(item.manager_phone, smsMsg);
            await sendSMS(item.manager_phone, SMS_TEMPLATES.AUTO_PO(poNumber, item.product_name));
          }

          console.log(`[Cron] Auto PO ${poNumber} created for ${item.product_name}`);
        } catch (txErr) {
          await conn.rollback();
          console.error(`[Cron] Transaction failed for ${item.product_name}:`, txErr.message);
        }
      }
    } catch (err) {
      console.error('[Cron] Replenishment check failed:', err.message);
    } finally {
      if (conn) conn.release();
    }
  });
}

module.exports = { startReplenishmentCron };
