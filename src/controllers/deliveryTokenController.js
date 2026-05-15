const crypto = require('crypto');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendEmail, EMAIL } = require('../services/emailService');
const env = require('../config/env');
const { insertStockMovement } = require('../utils/stockMovementLogger');
const { insertNotification } = require('../utils/notificationWriter');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

async function getWarehouseIdByPartner(db, partnerId) {
  if (!partnerId) return null;

  try {
    const [rows] = await db.execute(
      'SELECT id FROM warehouses WHERE partner_id = ? LIMIT 1',
      [partnerId]
    );
    return rows[0]?.id || null;
  } catch (err) {
    if (!isMissingColumn(err, 'partner_id')) {
      throw err;
    }
  }

  try {
    const [rows] = await db.execute(
      'SELECT warehouse_id AS id FROM inventories WHERE partner_id = ? AND is_active = 1 ORDER BY warehouse_id ASC LIMIT 1',
      [partnerId]
    );
    return rows[0]?.id || null;
  } catch (err) {
    if (!isMissingColumn(err, 'is_active')) {
      throw err;
    }
  }

  const [rows] = await db.execute(
    'SELECT warehouse_id AS id FROM inventories WHERE partner_id = ? ORDER BY warehouse_id ASC LIMIT 1',
    [partnerId]
  );
  return rows[0]?.id || null;
}

async function resolveSourceWarehouseIdForPartner(db, partnerId) {
  if (!partnerId) return null;

  const [partners] = await db.execute(
    'SELECT id, parent_partner_id, stockist_level FROM partners WHERE id = ? LIMIT 1',
    [partnerId]
  );
  if (partners.length === 0) return null;

  const partner = partners[0];

  if (partner.stockist_level === 'city_stockist' && partner.parent_partner_id) {
    return getWarehouseIdByPartner(db, partner.parent_partner_id);
  }

  if (partner.stockist_level === 'provincial_stockist') {
    const [mfrWh] = await db.execute(
      `SELECT id FROM warehouses WHERE type = 'manufacturer' LIMIT 1`
    );
    return mfrWh[0]?.id || null;
  }

  return getWarehouseIdByPartner(db, partner.id);
}

async function getLatestActiveToken(orderId) {
  const [rows] = await pool.execute(
    `SELECT id, token, expires_at, is_used, created_at
     FROM delivery_tokens
     WHERE order_id = ? AND is_used = 0 AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

function assertCanAccessOrder(user, order) {
  if (user.role_slug === 'super_admin') return;
  if (Number(user.partner_id) === Number(order.partner_id)) return;
  throw ApiError.forbidden('You do not have permission to access this order');
}

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
  assertCanAccessOrder(req.user, orders[0]);
  if (orders[0].payment_status !== 'paid') throw ApiError.badRequest('Payment must be verified before generating a delivery link');
  if (['delivered', 'cancelled', 'rejected'].includes(orders[0].status)) {
    throw ApiError.badRequest('Cannot generate delivery link for this order status');
  }

  const existingToken = await getLatestActiveToken(order_id);
  if (existingToken) {
    const [trackingRows] = await pool.execute(
      'SELECT id FROM delivery_tracking WHERE order_id = ? LIMIT 1',
      [order_id]
    );
    if (trackingRows.length === 0) {
      await pool.execute(
        `INSERT INTO delivery_tracking (order_id, status, courier_id, courier_tracking_number)
         VALUES (?, 'out_for_delivery', ?, ?)`,
        [order_id, courier_id || null, courier_tracking_number || null]
      );
    }

    const existingMagicLink = `${env.PUBLIC_BASE_URL}/deliver/${existingToken.token}`;
    return res.status(200).json({
      success: true,
      message: 'Active delivery link already exists',
      data: {
        token: existingToken.token,
        magic_link: existingMagicLink,
        expires_at: existingToken.expires_at,
      },
    });
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

    const [trackingRows] = await conn.execute(
      'SELECT id FROM delivery_tracking WHERE order_id = ? LIMIT 1',
      [order_id]
    );

    if (trackingRows.length === 0) {
      await conn.execute(
        `INSERT INTO delivery_tracking (order_id, status, courier_id, courier_tracking_number)
         VALUES (?, 'out_for_delivery', ?, ?)`,
        [order_id, courier_id || null, courier_tracking_number || null]
      );
    } else {
      await conn.execute(
        `UPDATE delivery_tracking
         SET status = 'out_for_delivery',
             courier_id = COALESCE(?, courier_id),
             courier_tracking_number = COALESCE(?, courier_tracking_number),
             updated_at = NOW()
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
      `SELECT u.id, u.email, u.name FROM users u WHERE u.partner_id = ? AND u.is_deleted = 0 AND u.status = 'active'`,
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

      if (pu.id) {
        try {
          await insertNotification(pool, {
            userId: pu.id,
            type: 'rider_dispatched',
            title: `Order Dispatched: #${orders[0].order_number}`,
            message: `Order #${orders[0].order_number} is on its way via ${courierName}.`,
            entityType: 'order',
            entityId: order_id,
          });
        } catch (notifyErr) {
          console.error('[DeliveryToken] Failed to create rider_dispatched notification:', notifyErr?.message || notifyErr);
        }
      }
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

// GET /api/v1/delivery-tokens/by-order/:orderId — latest active magic link for an order
const getLatestDeliveryLinkForOrder = asyncHandler(async (req, res) => {
  const orderId = req.params.orderId;

  const [orders] = await pool.execute(
    'SELECT id, partner_id FROM orders WHERE id = ? AND is_deleted = 0 LIMIT 1',
    [orderId]
  );

  if (orders.length === 0) throw ApiError.notFound('Order not found');
  assertCanAccessOrder(req.user, orders[0]);

  const token = await getLatestActiveToken(orderId);
  if (!token) {
    return res.json({ success: true, data: null });
  }

  const magicLink = `${env.PUBLIC_BASE_URL}/deliver/${token.token}`;
  return res.json({
    success: true,
    data: {
      token: token.token,
      magic_link: magicLink,
      expires_at: token.expires_at,
      is_used: token.is_used,
      created_at: token.created_at,
    },
  });
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
  const recipientName = req.body.recipient_name || null;
  const gpsLat = req.body.latitude || req.body.gps_lat || null;
  const gpsLng = req.body.longitude || req.body.gps_lng || null;

  let orders;
  try {
    [orders] = await pool.execute(
      'SELECT id, order_number, partner_id, source_warehouse_id FROM orders WHERE id = ? LIMIT 1',
      [orderId]
    );
  } catch (err) {
    if (isMissingColumn(err, 'source_warehouse_id')) {
      [orders] = await pool.execute(
        'SELECT id, order_number, partner_id FROM orders WHERE id = ? LIMIT 1',
        [orderId]
      );
      orders = orders.map((row) => ({ ...row, source_warehouse_id: null }));
    } else {
      throw err;
    }
  }
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  const order = orders[0];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Mark token used
    await conn.execute(`UPDATE delivery_tokens SET is_used = 1, used_at = NOW() WHERE id = ?`, [tokenId]);

    // Create POD record
    try {
      await conn.execute(
        `INSERT INTO proof_of_delivery (order_id, token_id, photo_url, gps_lat, gps_lng, recipient_name, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderId, tokenId, podUrl, gpsLat, gpsLng, recipientName, req.body.notes || null]
      );
    } catch (err) {
      if (
        !isMissingColumn(err, 'gps_lat') &&
        !isMissingColumn(err, 'recipient_name')
      ) {
        throw err;
      }

      await conn.execute(
        `INSERT INTO proof_of_delivery (order_id, token_id, photo_url, notes) VALUES (?, ?, ?, ?)`,
        [orderId, tokenId, podUrl, req.body.notes || null]
      );
    }

    const [trackingRows] = await conn.execute(
      'SELECT id FROM delivery_tracking WHERE order_id = ? LIMIT 1',
      [orderId]
    );
    if (trackingRows.length === 0) {
      await conn.execute(
        `INSERT INTO delivery_tracking (order_id, status, delivered_at)
         VALUES (?, 'delivered', NOW())`,
        [orderId]
      );
    } else {
      await conn.execute(
        `UPDATE delivery_tracking SET status = 'delivered', delivered_at = NOW(), updated_at = NOW() WHERE order_id = ?`,
        [orderId]
      );
    }

    // Update order
    await conn.execute(
      `UPDATE orders SET status = 'delivered', delivered_at = NOW() WHERE id = ?`,
      [orderId]
    );

    // Decrement current_stock and reserved_stock
    let items;
    try {
      [items] = await conn.execute(
        'SELECT product_id, quantity, source_warehouse_id FROM order_items WHERE order_id = ?',
        [orderId]
      );
    } catch (err) {
      if (isMissingColumn(err, 'source_warehouse_id')) {
        const [rows] = await conn.execute(
          'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
          [orderId]
        );
        items = rows.map((row) => ({ ...row, source_warehouse_id: null }));
      } else {
        throw err;
      }
    }

    let fallbackWarehouseId = order.source_warehouse_id || null;
    if (!fallbackWarehouseId) {
      fallbackWarehouseId = await resolveSourceWarehouseIdForPartner(conn, order.partner_id);
    }

    for (const item of items) {
      const wid = item.source_warehouse_id || fallbackWarehouseId;
      if (wid) {
        await conn.execute(
          `UPDATE inventories
           SET current_stock = GREATEST(0, current_stock - ?),
               reserved_stock = GREATEST(0, reserved_stock - ?),
               last_movement_at = NOW()
           WHERE product_id = ? AND warehouse_id = ?`,
          [item.quantity, item.quantity, item.product_id, wid]
        );
        await insertStockMovement(conn, {
          productId: item.product_id,
          warehouseId: wid,
          movementType: 'out',
          quantity: item.quantity,
          referenceType: 'order',
          referenceId: orderId,
          notes: 'Stock out on delivery confirmation',
        });
      }
    }

    // Notify Stockist
    const [partnerUsers] = await conn.execute(
      `SELECT id, email, name FROM users WHERE partner_id = ? AND is_deleted = 0 AND status = 'active'`,
      [order.partner_id]
    );
    for (const pu of partnerUsers) {
      await insertNotification(conn, {
        userId: pu.id,
        type: 'order_delivered',
        title: `Order Delivered: #${order.order_number}`,
        message: `Order #${order.order_number} has been delivered.`,
        entityType: 'order',
        entityId: orderId,
      });
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

module.exports = { generateDeliveryLink, getLatestDeliveryLinkForOrder, getDeliveryInfo, completeDelivery };
