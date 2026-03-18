const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');
const { sendSMS, SMS_TEMPLATES } = require('../services/smsService');
const cache = require('../services/cacheService');

// GET /api/v1/orders
const getOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, payment_status, search } = req.query;
  const params = [];
  let where = 'WHERE o.is_deleted = 0';

  // Scope by role
  if (req.user.role_slug !== 'super_admin') {
    where += ' AND o.partner_id = ?';
    params.push(req.user.partner_id);
  }

  if (status) { where += ' AND o.status = ?'; params.push(status); }
  if (payment_status) { where += ' AND o.payment_status = ?'; params.push(payment_status); }
  if (search) {
    where += ' AND (o.order_number LIKE ? OR pt.business_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const baseQuery = `
    SELECT o.id, o.order_number, o.partner_id, pt.business_name AS partner_name,
           o.placed_by, u.name AS placed_by_name, o.status, o.payment_status,
           o.total_amount, o.notes, o.created_at, o.approved_at, o.delivered_at
    FROM orders o
    JOIN partners pt ON pt.id = o.partner_id
    JOIN users u ON u.id = o.placed_by
    ${where}
    ORDER BY o.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM orders o
    JOIN partners pt ON pt.id = o.partner_id
    JOIN users u ON u.id = o.placed_by
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);

  // Attach order items to each order
  for (const order of result.data) {
    const [items] = await pool.execute(
      `SELECT oi.id, oi.product_id, p.name AS product_name, p.sku, p.image_url,
              oi.supplier, oi.quantity, oi.unit_price, oi.subtotal
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ?`,
      [order.id]
    );
    order.items = items;
  }

  res.json({ success: true, ...result });
});

// GET /api/v1/orders/:id
const getOrder = asyncHandler(async (req, res) => {
  const params = [req.params.id];
  let where = 'WHERE o.id = ? AND o.is_deleted = 0';

  if (req.user.role_slug !== 'super_admin') {
    where += ' AND o.partner_id = ?';
    params.push(req.user.partner_id);
  }

  const [rows] = await pool.execute(
    `SELECT o.*, pt.business_name AS partner_name, u.name AS placed_by_name,
            a.name AS approved_by_name
     FROM orders o
     JOIN partners pt ON pt.id = o.partner_id
     JOIN users u ON u.id = o.placed_by
     LEFT JOIN users a ON a.id = o.approved_by
     ${where} LIMIT 1`,
    params
  );

  if (rows.length === 0) throw ApiError.notFound('Order not found');

  const order = rows[0];
  const [items] = await pool.execute(
    `SELECT oi.id, oi.product_id, p.name AS product_name, p.sku, p.image_url,
            oi.supplier, oi.quantity, oi.unit_price, oi.subtotal
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`,
    [order.id]
  );
  order.items = items;

  res.json({ success: true, data: order });
});

// POST /api/v1/orders (checkout cart)
const createOrder = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const partnerId = req.user.partner_id;
  const { notes } = req.body;

  if (!partnerId) throw ApiError.badRequest('Only partner users can place orders');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Get cart items
    const [cartItems] = await conn.execute(
      `SELECT ci.id, ci.product_id, ci.quantity, p.name AS product_name,
              p.partner_price, p.sku
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = ? AND p.is_deleted = 0 AND p.is_active = 1`,
      [userId]
    );

    if (cartItems.length === 0) throw ApiError.badRequest('Cart is empty');

    // Calculate total
    let totalAmount = 0;
    for (const item of cartItems) {
      totalAmount += item.quantity * item.partner_price;
    }

    // Generate order number
    const orderNumber = await generateOrderNum('ORD', 'orders', 'order_number');

    // Create order
    const [orderResult] = await conn.execute(
      `INSERT INTO orders (order_number, partner_id, placed_by, total_amount, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [orderNumber, partnerId, userId, totalAmount, notes || null]
    );

    const orderId = orderResult.insertId;

    // Create order items
    for (const item of cartItems) {
      await conn.execute(
        `INSERT INTO order_items (order_id, product_id, supplier, quantity, unit_price)
         VALUES (?, ?, 'Nogatu Manufacturing', ?, ?)`,
        [orderId, item.product_id, item.quantity, item.partner_price]
      );
    }

    // Clear cart
    await conn.execute('DELETE FROM cart_items WHERE user_id = ?', [userId]);

    // Create notification for super_admin
    const [admins] = await conn.execute(
      `SELECT u.id, u.phone FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.slug = 'super_admin' AND u.is_deleted = 0`
    );

    const [partner] = await conn.execute('SELECT business_name, phone FROM partners WHERE id = ?', [partnerId]);
    const partnerName = partner[0]?.business_name || 'Unknown';

    for (const admin of admins) {
      await conn.execute(
        `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
         VALUES (?, 'order_placed', ?, ?, 'order', ?)`,
        [admin.id, `New Order: ${orderNumber}`, `New order ${orderNumber} from ${partnerName} worth PHP ${totalAmount.toFixed(2)}`, orderId]
      );

      if (admin.phone) {
        sendSMS(admin.phone, SMS_TEMPLATES.NEW_ORDER(orderNumber, partnerName));
      }
    }

    await conn.commit();

    await cache.delPattern('dashboard:*');
    await cache.delPattern('orders:*');

    const [createdOrder] = await pool.execute(
      `SELECT o.*, pt.business_name AS partner_name
       FROM orders o JOIN partners pt ON pt.id = o.partner_id WHERE o.id = ?`,
      [orderId]
    );

    res.status(201).json({ success: true, message: 'Order placed successfully', data: createdOrder[0] });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/orders/:id/approve
const approveOrder = asyncHandler(async (req, res) => {
  const orderId = req.params.id;

  const [orders] = await pool.execute(
    'SELECT id, order_number, partner_id, status FROM orders WHERE id = ? AND is_deleted = 0', [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'pending') throw ApiError.badRequest('Order can only be approved from pending status');

  await pool.execute(
    'UPDATE orders SET status = ?, approved_by = ?, approved_at = NOW() WHERE id = ?',
    ['approved', req.user.id, orderId]
  );

  // Notify partner
  const [partnerUsers] = await pool.execute(
    `SELECT u.id, u.phone FROM users u WHERE u.partner_id = ? AND u.is_deleted = 0`,
    [orders[0].partner_id]
  );

  for (const pu of partnerUsers) {
    await pool.execute(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
       VALUES (?, 'order_approved', ?, ?, 'order', ?)`,
      [pu.id, `Order Approved: ${orders[0].order_number}`, `Your order ${orders[0].order_number} has been approved. Please proceed with payment.`, orderId]
    );
    if (pu.phone) sendSMS(pu.phone, SMS_TEMPLATES.ORDER_APPROVED(orders[0].order_number));
  }

  await cache.delPattern('dashboard:*');
  res.json({ success: true, message: 'Order approved' });
});

// PATCH /api/v1/orders/:id/reject
const rejectOrder = asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const { reason } = req.body;

  const [orders] = await pool.execute(
    'SELECT id, order_number, partner_id, status FROM orders WHERE id = ? AND is_deleted = 0', [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'pending') throw ApiError.badRequest('Order can only be rejected from pending status');

  await pool.execute(
    'UPDATE orders SET status = ?, approved_by = ?, notes = CONCAT(COALESCE(notes, ""), ?) WHERE id = ?',
    ['rejected', req.user.id, reason ? `\nRejection reason: ${reason}` : '', orderId]
  );

  const [partnerUsers] = await pool.execute(
    'SELECT u.id, u.phone FROM users u WHERE u.partner_id = ? AND u.is_deleted = 0',
    [orders[0].partner_id]
  );

  for (const pu of partnerUsers) {
    await pool.execute(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
       VALUES (?, 'order_rejected', ?, ?, 'order', ?)`,
      [pu.id, `Order Rejected: ${orders[0].order_number}`, `Your order ${orders[0].order_number} has been rejected. Reason: ${reason || 'N/A'}`, orderId]
    );
    if (pu.phone) sendSMS(pu.phone, SMS_TEMPLATES.ORDER_REJECTED(orders[0].order_number, reason));
  }

  await cache.delPattern('dashboard:*');
  res.json({ success: true, message: 'Order rejected' });
});

// PATCH /api/v1/orders/:id/pay
const payOrder = asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const { method, amount, reference, notes } = req.body;

  const [orders] = await pool.execute(
    'SELECT id, order_number, partner_id, status, payment_status, total_amount FROM orders WHERE id = ? AND is_deleted = 0',
    [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'approved') throw ApiError.badRequest('Order must be approved before payment');
  if (orders[0].payment_status === 'paid') throw ApiError.badRequest('Order is already paid');

  const payAmount = amount || orders[0].total_amount;

  await pool.execute('UPDATE orders SET payment_status = ? WHERE id = ?', ['paid', orderId]);

  // Create payment record
  await pool.execute(
    `INSERT INTO payments (order_id, marked_by, method, amount, reference, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orderId, req.user.id, method || 'bank_transfer', payAmount, reference || null, notes || null]
  );

  const [partnerUsers] = await pool.execute(
    'SELECT u.id, u.phone FROM users u WHERE u.partner_id = ? AND u.is_deleted = 0',
    [orders[0].partner_id]
  );

  for (const pu of partnerUsers) {
    await pool.execute(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
       VALUES (?, 'order_paid', ?, ?, 'order', ?)`,
      [pu.id, `Payment Confirmed: ${orders[0].order_number}`, `Payment for order ${orders[0].order_number} has been confirmed.`, orderId]
    );
    if (pu.phone) sendSMS(pu.phone, SMS_TEMPLATES.ORDER_PAID(orders[0].order_number));
  }

  await cache.delPattern('dashboard:*');
  res.json({ success: true, message: 'Payment recorded' });
});

// PATCH /api/v1/orders/:id/deliver
const deliverOrder = asyncHandler(async (req, res) => {
  const orderId = req.params.id;

  const [orders] = await pool.execute(
    'SELECT id, order_number, partner_id, status, payment_status FROM orders WHERE id = ? AND is_deleted = 0',
    [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (!['approved', 'delivering'].includes(orders[0].status)) {
    throw ApiError.badRequest('Order must be approved or delivering to mark as delivered');
  }

  await pool.execute(
    'UPDATE orders SET status = ?, delivered_at = NOW() WHERE id = ?',
    ['delivered', orderId]
  );

  // Update delivery tracking if exists
  await pool.execute(
    `UPDATE delivery_tracking SET status = 'delivered', delivered_at = NOW() WHERE order_id = ?`,
    [orderId]
  );

  const [partnerUsers] = await pool.execute(
    'SELECT u.id, u.phone FROM users u WHERE u.partner_id = ? AND u.is_deleted = 0',
    [orders[0].partner_id]
  );

  for (const pu of partnerUsers) {
    await pool.execute(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
       VALUES (?, 'order_delivered', ?, ?, 'order', ?)`,
      [pu.id, `Order Delivered: ${orders[0].order_number}`, `Order ${orders[0].order_number} has been delivered successfully.`, orderId]
    );
    if (pu.phone) sendSMS(pu.phone, SMS_TEMPLATES.ORDER_DELIVERED(orders[0].order_number));
  }

  await cache.delPattern('dashboard:*');
  res.json({ success: true, message: 'Order marked as delivered' });
});

module.exports = { getOrders, getOrder, createOrder, approveOrder, rejectOrder, payOrder, deliverOrder };
