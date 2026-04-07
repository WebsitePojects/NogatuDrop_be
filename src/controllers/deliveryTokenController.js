const crypto = require('crypto');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendEmail, EMAIL } = require('../services/emailService');
const env = require('../config/env');

// POST /api/v1/delivery-tokens — generate magic link for an order
const generateDeliveryLink = asyncHandler(async (req, res) => {
  const { order_id, courier_id, courier_tracking_number } = req.body;
  if (!order_id) throw ApiError.badRequest('order_id is required');

  const [orders] = await pool.execute(
    `SELECT o.id, o.order_number, o.partner_id, o.payment_status, o.status
     FROM orders o WHERE o.id = ? AND o.is_deleted = 0 LIMIT 1`,
    [order_id]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].payment_status !== 'paid') throw ApiError.badRequest('Payment must be verified before generating a delivery link');
  if (['delivered', 'cancelled', 'rejected'].includes(orders[0].status)) {
    throw ApiError.badRequest('Cannot generate delivery link for this order status');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h

    await conn.execute(
      `INSERT INTO delivery_tokens (order_id, token, expires_at, created_by) VALUES (?, ?, ?, ?)`,
      [order_id, token, expiresAt, req.user.id]
    );

    // Update delivery_tracking with courier info
    if (courier_id || courier_tracking_number) {
      await conn.execute(
        `UPDATE delivery_tracking SET courier_id = COALESCE(?, courier_id),
         courier_tracking_number = COALESCE(?, courier_tracking_number)
         WHERE order_id = ?`,
        [courier_id || null, courier_tracking_number || null, order_id]
      );
    }

    // Update order status to 'delivering'
    await conn.execute(`UPDATE orders SET status = 'delivering' WHERE id = ?`, [order_id]);

    await conn.commit();

    const magicLink = `${env.PUBLIC_BASE_URL}/deliver/${token}`;

    // Notify Stockist users that order is on its way
    const [partnerUsers] = await pool.execute(
      `SELECT u.email, u.name FROM users u WHERE u.partner_id = ? AND u.is_deleted = 0 AND u.status = 'active'`,
      [orders[0].partner_id]
    );

    let courierName = 'Courier';
    if (courier_id) {
      const [courierRow] = await pool.execute('SELECT name FROM couriers WHERE id = ? LIMIT 1', [courier_id]);
      if (courierRow.length > 0) courierName = courierRow[0].name;
    }

    for (const pu of partnerUsers) {
      const tmpl = EMAIL.riderDispatched(orders[0].order_number, courierName, courier_tracking_number);
      await sendEmail({ to: pu.email, toName: pu.name, ...tmpl });

      await pool.execute(
        `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id) VALUES (?, 'rider_dispatched', ?, ?, 'order', ?)`,
        [pu.id, `Order Dispatched: #${orders[0].order_number}`, `Order #${orders[0].order_number} is on its way via ${courierName}.`, order_id]
      );
    }

    res.status(201).json({
      success: true,
      message: 'Delivery link generated',
      data: { token, magic_link: magicLink, expires_at: expiresAt },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// GET /deliver/:token — public, no auth — delivery page info for rider
const getDeliveryInfo = asyncHandler(async (req, res) => {
  const { token } = req.params;

  const [tokens] = await pool.execute(
    `SELECT dt.*, o.order_number, o.customer_name, o.customer_address, o.customer_phone,
            o.total_amount, o.partner_id, o.status AS order_status
     FROM delivery_tokens dt
     JOIN orders o ON o.id = dt.order_id
     WHERE dt.token = ? AND dt.is_used = 0 AND dt.expires_at > NOW()
     LIMIT 1`,
    [token]
  );

  if (tokens.length === 0) throw ApiError.notFound('Delivery link is invalid, expired, or already used');

  const info = tokens[0];
  const [items] = await pool.execute(
    `SELECT p.name AS product_name, oi.quantity, oi.unit_price
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`,
    [info.order_id]
  );

  res.json({
    success: true,
    data: {
      order_number: info.order_number,
      customer_name: info.customer_name,
      customer_address: info.customer_address,
      customer_phone: info.customer_phone,
      total_amount: info.total_amount,
      items,
    },
  });
});

// POST /deliver/:token/complete — rider submits POD photo, marks delivery complete
const completeDelivery = asyncHandler(async (req, res) => {
  const { token } = req.params;

  if (!req.file) throw ApiError.badRequest('Proof of delivery photo is required');

  const [tokens] = await pool.execute(
    `SELECT dt.id, dt.order_id FROM delivery_tokens dt
     WHERE dt.token = ? AND dt.is_used = 0 AND dt.expires_at > NOW() LIMIT 1`,
    [token]
  );
  if (tokens.length === 0) throw ApiError.notFound('Delivery link is invalid, expired, or already used');

  const { id: tokenId, order_id: orderId } = tokens[0];
  const podUrl = req.file.path; // Cloudinary URL

  const [orders] = await pool.execute(
    'SELECT id, order_number, partner_id, source_warehouse_id FROM orders WHERE id = ? LIMIT 1',
    [orderId]
  );
  const order = orders[0];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Mark token used
    await conn.execute(`UPDATE delivery_tokens SET is_used = 1, used_at = NOW() WHERE id = ?`, [tokenId]);

    // Create POD record
    await conn.execute(
      `INSERT INTO proof_of_delivery (order_id, token_id, photo_url, notes) VALUES (?, ?, ?, ?)`,
      [orderId, tokenId, podUrl, req.body.notes || null]
    );

    // Update delivery_tracking
    await conn.execute(
      `UPDATE delivery_tracking SET status = 'delivered', delivered_at = NOW() WHERE order_id = ?`,
      [orderId]
    );

    // Update order
    await conn.execute(
      `UPDATE orders SET status = 'delivered', delivered_at = NOW() WHERE id = ?`,
      [orderId]
    );

    // Decrement current_stock and reserved_stock
    const [items] = await conn.execute(
      'SELECT product_id, quantity, source_warehouse_id FROM order_items WHERE order_id = ?',
      [orderId]
    );
    for (const item of items) {
      const wid = item.source_warehouse_id || order.source_warehouse_id;
      if (wid) {
        await conn.execute(
          `UPDATE inventories
           SET current_stock = GREATEST(0, current_stock - ?),
               reserved_stock = GREATEST(0, reserved_stock - ?),
               last_movement_at = NOW()
           WHERE product_id = ? AND warehouse_id = ?`,
          [item.quantity, item.quantity, item.product_id, wid]
        );
        await conn.execute(
          `INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity_change, reference_type, reference_id, notes)
           VALUES (?, ?, 'out', ?, 'order', ?, 'Stock out on delivery confirmation')`,
          [item.product_id, wid, item.quantity, orderId]
        );
      }
    }

    // Notify Stockist
    const [partnerUsers] = await conn.execute(
      `SELECT id, email, name FROM users WHERE partner_id = ? AND is_deleted = 0 AND status = 'active'`,
      [order.partner_id]
    );
    for (const pu of partnerUsers) {
      await conn.execute(
        `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id) VALUES (?, 'order_delivered', ?, ?, 'order', ?)`,
        [pu.id, `Order Delivered: #${order.order_number}`, `Order #${order.order_number} has been delivered.`, orderId]
      );
    }

    await conn.commit();

    // Send email outside transaction
    for (const pu of partnerUsers) {
      const tmpl = EMAIL.orderDelivered(order.order_number);
      await sendEmail({ to: pu.email, toName: pu.name, ...tmpl });
    }

    res.json({ success: true, message: 'Delivery confirmed. Thank you!' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = { generateDeliveryLink, getDeliveryInfo, completeDelivery };
