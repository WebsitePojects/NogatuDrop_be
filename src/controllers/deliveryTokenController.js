const crypto = require('crypto');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendEmail, EMAIL } = require('../services/emailService');
const env = require('../config/env');
const { insertStockMovement } = require('../utils/stockMovementLogger');
const { insertNotification } = require('../utils/notificationWriter');

const isMissingColumn = (err, columnName) => {
  if (!err || err.code !== 'ER_BAD_FIELD_ERROR') {
    return false;
  }

  const message = String(err.message || '');
  const quotedIdentifiers = Array.from(message.matchAll(/'([^']+)'/g), (match) => match[1]);

  return quotedIdentifiers.some((identifier) => (
    identifier === columnName || identifier.endsWith(`.${columnName}`)
  ));
};

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

function canAccessDeliveryProof(user, ownership) {
  if (!user) return false;
  if (user.role_slug === 'super_admin') return true;

  const userPartnerId = Number(user.partner_id || 0);
  if (!userPartnerId) return false;

  return userPartnerId === Number(ownership.partner_id || 0)
    || userPartnerId === Number(ownership.source_partner_id || 0);
}

function buildDeliveryProofScope(user, {
  orderAlias = 'o',
  sourcePartnerExpression = 'sw.partner_id',
} = {}) {
  if (user?.role_slug === 'super_admin') {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return {
    clause: ` AND (${orderAlias}.partner_id = ? OR ${sourcePartnerExpression} = ?)`,
    params: [user.partner_id, user.partner_id],
  };
}

async function getDeliveryProofOwnership(orderId) {
  let rows;

  try {
    [rows] = await pool.execute(
      `SELECT o.id, o.partner_id, sw.partner_id AS source_partner_id
       FROM orders o
       LEFT JOIN warehouses sw ON sw.id = o.source_warehouse_id
       WHERE o.id = ? AND o.is_deleted = 0
       LIMIT 1`,
      [orderId]
    );
  } catch (err) {
    if (!isMissingColumn(err, 'source_warehouse_id') && !isMissingColumn(err, 'partner_id')) {
      throw err;
    }

    [rows] = await pool.execute(
      `SELECT o.id, o.partner_id, NULL AS source_partner_id
       FROM orders o
       WHERE o.id = ? AND o.is_deleted = 0
       LIMIT 1`,
      [orderId]
    );
  }

  return rows[0] || null;
}

// POST /api/v1/delivery-tokens — generate magic link for an order
const generateDeliveryLink = asyncHandler(async (req, res) => {
  const { order_id, courier_id, courier_tracking_number } = req.body;
  if (!order_id) throw ApiError.badRequest('order_id is required');

  let orders;
  try {
    [orders] = await pool.execute(
      `SELECT o.id, o.order_number, o.partner_id, o.payment_status, o.status
       FROM orders o WHERE o.id = ? AND o.is_deleted = 0 LIMIT 1`,
      [order_id]
    );
  } catch (err) {
    throw err;
  }
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  assertCanAccessOrder(req.user, orders[0]);
  if (orders[0].payment_status !== 'paid') {
    throw ApiError.badRequest('Payment must be verified before generating a delivery link');
  }
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

// GET /api/v1/delivery-tokens/pods/by-order/:orderId — authenticated POD review for office users
const getDeliveryProofForOrder = asyncHandler(async (req, res) => {
  const { orderId } = req.params;
  const ownership = await getDeliveryProofOwnership(orderId);

  if (!ownership) {
    throw ApiError.notFound('Order not found');
  }

  if (!canAccessDeliveryProof(req.user, ownership)) {
    throw ApiError.forbidden('You do not have permission to access this proof of delivery');
  }

  let rows;

  try {
    [rows] = await pool.execute(
      `SELECT pod.id AS pod_id,
              pod.order_id,
              pod.token_id,
              pod.photo_url,
              pod.gps_lat,
              pod.gps_lng,
              pod.recipient_name,
              pod.recipient_signature,
              pod.signature_hash,
              pod.signed_at,
              pod.notes,
              pod.created_at AS pod_created_at,
              o.order_number,
              o.status AS order_status,
              o.partner_id,
              pt.business_name AS partner_name,
              o.customer_name,
              o.customer_address,
              o.customer_phone,
              o.delivered_at AS order_delivered_at,
              dt.used_at AS token_used_at,
              tr.status AS tracking_status,
              tr.rider_name,
              tr.courier_tracking_number,
              tr.est_delivery_at,
              tr.delivered_at AS tracking_delivered_at,
              c.name AS courier_name,
              sw.id AS source_warehouse_id,
              sw.name AS source_warehouse_name,
              sw.location AS source_warehouse_location,
              tw.id AS target_warehouse_id,
              tw.name AS target_warehouse_name,
              tw.location AS target_warehouse_location
       FROM proof_of_delivery pod
       JOIN orders o ON o.id = pod.order_id
       JOIN partners pt ON pt.id = o.partner_id
       LEFT JOIN delivery_tokens dt ON dt.id = pod.token_id
       LEFT JOIN delivery_tracking tr ON tr.order_id = o.id
       LEFT JOIN couriers c ON c.id = tr.courier_id
       LEFT JOIN warehouses sw ON sw.id = o.source_warehouse_id
       LEFT JOIN warehouses tw ON tw.id = (
         SELECT MIN(w2.id)
         FROM warehouses w2
         WHERE w2.partner_id = o.partner_id
       )
       WHERE pod.order_id = ?
       ORDER BY pod.id DESC
       LIMIT 1`,
      [orderId]
    );
  } catch (err) {
    if (
      !isMissingColumn(err, 'gps_lat')
      && !isMissingColumn(err, 'recipient_name')
      && !isMissingColumn(err, 'source_warehouse_id')
      && !isMissingColumn(err, 'partner_id')
      && !isMissingColumn(err, 'created_at')
    ) {
      throw err;
    }

    [rows] = await pool.execute(
      `SELECT pod.id AS pod_id,
              pod.order_id,
              pod.token_id,
              pod.photo_url,
              NULL AS gps_lat,
              NULL AS gps_lng,
              NULL AS recipient_name,
              NULL AS recipient_signature,
              NULL AS signature_hash,
              NULL AS signed_at,
              pod.notes,
              pod.submitted_at AS pod_created_at,
              o.order_number,
              o.status AS order_status,
              o.partner_id,
              pt.business_name AS partner_name,
              o.customer_name,
              o.customer_address,
              o.customer_phone,
              o.delivered_at AS order_delivered_at,
              dt.used_at AS token_used_at,
              tr.status AS tracking_status,
              tr.rider_name,
              tr.courier_tracking_number,
              tr.est_delivery_at,
              tr.delivered_at AS tracking_delivered_at,
              c.name AS courier_name,
              NULL AS source_warehouse_id,
              NULL AS source_warehouse_name,
              NULL AS source_warehouse_location,
              NULL AS target_warehouse_id,
              NULL AS target_warehouse_name,
              NULL AS target_warehouse_location
       FROM proof_of_delivery pod
       JOIN orders o ON o.id = pod.order_id
       JOIN partners pt ON pt.id = o.partner_id
       LEFT JOIN delivery_tokens dt ON dt.id = pod.token_id
       LEFT JOIN delivery_tracking tr ON tr.order_id = o.id
       LEFT JOIN couriers c ON c.id = tr.courier_id
       WHERE pod.order_id = ?
       ORDER BY pod.id DESC
       LIMIT 1`,
      [orderId]
    );
  }

  if (rows.length === 0) {
    return res.json({ success: true, data: null });
  }

  return res.json({ success: true, data: rows[0] });
});

// GET /api/v1/delivery-tokens/pods — recent POD records within tenant/source scope
const listDeliveryProofs = asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const scope = buildDeliveryProofScope(req.user);
  let rows;

  try {
    [rows] = await pool.execute(
      `SELECT pod.id AS pod_id,
              pod.order_id,
              pod.photo_url,
              pod.gps_lat,
              pod.gps_lng,
              pod.recipient_name,
              pod.recipient_signature,
              pod.signed_at,
              pod.notes,
              pod.created_at AS pod_created_at,
              o.order_number,
              o.status AS order_status,
              o.partner_id,
              pt.business_name AS partner_name,
              o.delivered_at AS order_delivered_at,
              tr.status AS tracking_status,
              tr.rider_name,
              tr.courier_tracking_number,
              tr.delivered_at AS tracking_delivered_at,
              c.name AS courier_name,
              sw.partner_id AS source_partner_id,
              sw.name AS source_warehouse_name,
              sw.location AS source_warehouse_location,
              tw.name AS target_warehouse_name,
              tw.location AS target_warehouse_location
       FROM proof_of_delivery pod
       JOIN orders o ON o.id = pod.order_id
       JOIN partners pt ON pt.id = o.partner_id
       LEFT JOIN delivery_tracking tr ON tr.order_id = o.id
       LEFT JOIN couriers c ON c.id = tr.courier_id
       LEFT JOIN warehouses sw ON sw.id = o.source_warehouse_id
       LEFT JOIN warehouses tw ON tw.id = (
         SELECT MIN(w2.id)
         FROM warehouses w2
         WHERE w2.partner_id = o.partner_id
       )
       WHERE o.is_deleted = 0${scope.clause}
       ORDER BY COALESCE(pod.signed_at, pod.created_at) DESC
       LIMIT ?`,
      [...scope.params, limit]
    );
  } catch (err) {
    if (
      !isMissingColumn(err, 'gps_lat')
      && !isMissingColumn(err, 'recipient_name')
      && !isMissingColumn(err, 'source_warehouse_id')
      && !isMissingColumn(err, 'partner_id')
      && !isMissingColumn(err, 'created_at')
    ) {
      throw err;
    }

    [rows] = await pool.execute(
      `SELECT pod.id AS pod_id,
              pod.order_id,
              pod.photo_url,
              NULL AS gps_lat,
              NULL AS gps_lng,
              NULL AS recipient_name,
              NULL AS recipient_signature,
              NULL AS signed_at,
              pod.notes,
              pod.submitted_at AS pod_created_at,
              o.order_number,
              o.status AS order_status,
              o.partner_id,
              pt.business_name AS partner_name,
              o.delivered_at AS order_delivered_at,
              tr.status AS tracking_status,
              tr.rider_name,
              tr.courier_tracking_number,
              tr.delivered_at AS tracking_delivered_at,
              c.name AS courier_name,
              NULL AS source_partner_id,
              NULL AS source_warehouse_name,
              NULL AS source_warehouse_location,
              NULL AS target_warehouse_name,
              NULL AS target_warehouse_location
       FROM proof_of_delivery pod
       JOIN orders o ON o.id = pod.order_id
       JOIN partners pt ON pt.id = o.partner_id
       LEFT JOIN delivery_tracking tr ON tr.order_id = o.id
       LEFT JOIN delivery_tokens dt ON dt.id = pod.token_id
       LEFT JOIN couriers c ON c.id = tr.courier_id
       WHERE o.is_deleted = 0 AND o.partner_id = ?
       ORDER BY COALESCE(pod.signed_at, pod.submitted_at) DESC
       LIMIT ?`,
      [req.user.partner_id, limit]
    );
  }

  return res.json({ success: true, data: rows });
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
  const recipientSignature = req.body.recipient_signature || null;
  const gpsLat = req.body.latitude || req.body.gps_lat || null;
  const gpsLng = req.body.longitude || req.body.gps_lng || null;
  const signatureHash = recipientSignature
    ? crypto.createHash('sha256').update(String(recipientSignature)).digest('hex')
    : null;

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
        `INSERT INTO proof_of_delivery
         (order_id, token_id, photo_url, gps_lat, gps_lng, recipient_name, recipient_signature, signature_hash, signed_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          tokenId,
          podUrl,
          gpsLat,
          gpsLng,
          recipientName,
          recipientSignature,
          signatureHash,
          recipientSignature ? new Date() : null,
          req.body.notes || null,
        ]
      );
    } catch (err) {
      if (
        !isMissingColumn(err, 'gps_lat') &&
        !isMissingColumn(err, 'recipient_name') &&
        !isMissingColumn(err, 'recipient_signature')
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
        const [updated] = await conn.execute(
          `UPDATE inventories
           SET current_stock = current_stock - ?,
               reserved_stock = reserved_stock - ?,
               last_movement_at = NOW()
           WHERE product_id = ? AND warehouse_id = ?
             AND current_stock >= ?
             AND reserved_stock >= ?`,
          [item.quantity, item.quantity, item.product_id, wid, item.quantity, item.quantity]
        );
        if (updated.affectedRows === 0) {
          throw ApiError.conflict('Reserved stock is no longer sufficient to complete this delivery');
        }
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

module.exports = {
  generateDeliveryLink,
  getLatestDeliveryLinkForOrder,
  getDeliveryProofForOrder,
  listDeliveryProofs,
  getDeliveryInfo,
  completeDelivery,
  __testables: {
    canAccessDeliveryProof,
    buildDeliveryProofScope,
  },
};
