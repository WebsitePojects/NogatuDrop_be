const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');
const { sendEmail, EMAIL } = require('../services/emailService');
const cache = require('../services/cacheService');
const env = require('../config/env');
const { insertStockMovement } = require('../utils/stockMovementLogger');
const { insertNotification } = require('../utils/notificationWriter');
const { createPendingSettlementForOrder } = require('./settlementController');

const isMissingSoftDeleteColumn = (err) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes("'is_deleted'")
);

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

async function executeSoftDeleteAware(db, primarySql, params = [], fallbackSql = null) {
  try {
    return await db.execute(primarySql, params);
  } catch (err) {
    if (isMissingSoftDeleteColumn(err) && fallbackSql) {
      return db.execute(fallbackSql, params);
    }
    throw err;
  }
}

async function getOrderRowsWithOptionalSourceColumn(db, whereClause, params = []) {
  try {
    const [rows] = await db.execute(
      `SELECT id, order_number, partner_id, source_warehouse_id, status FROM orders ${whereClause}`,
      params
    );
    return rows;
  } catch (err) {
    if (isMissingColumn(err, 'source_warehouse_id')) {
      const [rows] = await db.execute(
        `SELECT id, order_number, partner_id, status FROM orders ${whereClause}`,
        params
      );
      return rows.map((row) => ({ ...row, source_warehouse_id: null }));
    }
    throw err;
  }
}

async function getOrderItemsWithOptionalSourceColumn(db, orderId) {
  try {
    const [rows] = await db.execute(
      'SELECT product_id, quantity, source_warehouse_id FROM order_items WHERE order_id = ?',
      [orderId]
    );
    return rows;
  } catch (err) {
    if (isMissingColumn(err, 'source_warehouse_id')) {
      const [rows] = await db.execute(
        'SELECT product_id, quantity FROM order_items WHERE order_id = ?',
        [orderId]
      );
      return rows.map((row) => ({ ...row, source_warehouse_id: null }));
    }
    throw err;
  }
}

async function reserveInventoryOrThrow(conn, { productId, warehouseId, quantity, productName }) {
  let result;
  try {
    [result] = await conn.execute(
      `UPDATE inventories
       SET reserved_stock = reserved_stock + ?,
           last_movement_at = NOW()
       WHERE product_id = ?
         AND warehouse_id = ?
         AND is_deleted = 0
         AND current_stock >= reserved_stock + ?`,
      [quantity, productId, warehouseId, quantity]
    );
  } catch (err) {
    if (!isMissingSoftDeleteColumn(err)) {
      throw err;
    }

    [result] = await conn.execute(
      `UPDATE inventories
       SET reserved_stock = reserved_stock + ?,
           last_movement_at = NOW()
       WHERE product_id = ?
         AND warehouse_id = ?
         AND current_stock >= reserved_stock + ?`,
      [quantity, productId, warehouseId, quantity]
    );
  }

  if (result.affectedRows > 0) {
    return;
  }

  const [inventory] = await executeSoftDeleteAware(
    conn,
    `SELECT current_stock, reserved_stock
     FROM inventories
     WHERE product_id = ? AND warehouse_id = ? AND is_deleted = 0
     LIMIT 1`,
    [productId, warehouseId],
    `SELECT current_stock, reserved_stock
     FROM inventories
     WHERE product_id = ? AND warehouse_id = ?
     LIMIT 1`
  );

  const available = inventory.length > 0
    ? Number(inventory[0].current_stock || 0) - Number(inventory[0].reserved_stock || 0)
    : 0;

  throw ApiError.badRequest(`Insufficient stock for ${productName || 'product'} (available: ${available})`);
}

async function getWarehouseIdByPartner(db, partnerId) {
  if (!partnerId) return null;

  try {
    const [rows] = await executeSoftDeleteAware(
      db,
      'SELECT id FROM warehouses WHERE partner_id = ? AND is_deleted = 0 LIMIT 1',
      [partnerId],
      'SELECT id FROM warehouses WHERE partner_id = ? LIMIT 1'
    );
    return rows[0]?.id || null;
  } catch (err) {
    if (!isMissingColumn(err, 'partner_id') && !isMissingColumn(err, 'w.partner_id')) {
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

  const [partners] = await executeSoftDeleteAware(
    db,
    'SELECT id, parent_partner_id, stockist_level FROM partners WHERE id = ? AND is_deleted = 0 LIMIT 1',
    [partnerId],
    'SELECT id, parent_partner_id, stockist_level FROM partners WHERE id = ? LIMIT 1'
  );
  if (partners.length === 0) return null;

  const partner = partners[0];

  if (partner.stockist_level === 'city_stockist' && partner.parent_partner_id) {
    return getWarehouseIdByPartner(db, partner.parent_partner_id);
  }

  if (partner.stockist_level === 'provincial_stockist') {
    const [mfrWh] = await executeSoftDeleteAware(
      db,
      `SELECT id FROM warehouses WHERE type = 'manufacturer' AND is_deleted = 0 LIMIT 1`,
      [],
      `SELECT id FROM warehouses WHERE type = 'manufacturer' LIMIT 1`
    );
    return mfrWh[0]?.id || null;
  }

  return getWarehouseIdByPartner(db, partner.id);
}

// ─── Helper: notify users of a partner ───────────────────────────────────────
async function notifyPartnerUsers(conn, partnerId, type, title, message, entityId) {
  const [users] = await executeSoftDeleteAware(
    conn,
    `SELECT id, email, name FROM users WHERE partner_id = ? AND is_deleted = 0 AND status = 'active'`,
    [partnerId],
    `SELECT id, email, name FROM users WHERE partner_id = ? AND status = 'active'`
  );
  for (const u of users) {
    await insertNotification(conn, {
      userId: u.id,
      type,
      title,
      message,
      entityType: 'order',
      entityId,
    });
  }
  return users;
}

async function notifySuperAdmins(conn, type, title, message, entityId) {
  const [admins] = await executeSoftDeleteAware(
    conn,
    `SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active'`,
    [],
    `SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.status = 'active'`
  );
  for (const a of admins) {
    await insertNotification(conn, {
      userId: a.id,
      type,
      title,
      message,
      entityType: 'order',
      entityId,
    });
  }
  return admins;
}

function buildOrderScope(user, {
  orderAlias = 'o',
} = {}) {
  const orderRef = orderAlias ? `${orderAlias}.` : '';

  if (user?.role_slug === 'super_admin') {
    return { clause: '', params: [] };
  }

  if (user?.role_slug === 'mobile_stockist') {
    if (!user?.id) {
      return { clause: ' AND 1 = 0', params: [] };
    }

    return {
      clause: ` AND ${orderRef}placed_by = ?`,
      params: [user.id],
    };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return {
    clause: ` AND ${orderRef}partner_id = ?`,
    params: [user.partner_id],
  };
}

function normalizeOrderPaymentMethod(paymentMethod) {
  if (paymentMethod == null || paymentMethod === '') {
    return 'bank_transfer';
  }

  if (paymentMethod === 'bank_transfer') {
    return paymentMethod;
  }

  throw ApiError.badRequest('Bank transfer is the only supported payment method');
}

// GET /api/v1/orders
const getOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, payment_status, search } = req.query;
  const scope = buildOrderScope(req.user);
  const params = [];
  let where = `WHERE o.is_deleted = 0${scope.clause}`;
  params.push(...scope.params);

  if (status) { where += ' AND o.status = ?'; params.push(status); }
  if (payment_status) { where += ' AND o.payment_status = ?'; params.push(payment_status); }
  if (search) {
    where += ' AND (o.order_number LIKE ? OR pt.business_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const baseQuery = `
    SELECT o.id, o.order_number, o.partner_id, pt.business_name AS partner_name,
           o.placed_by, u.name AS placed_by_name, u.email AS placed_by_email, ur.slug AS placed_by_role_slug,
           o.status, o.payment_status,
           o.total_amount, o.payment_deadline, o.payment_proof_url, o.cod_amount,
           o.placed_by_type, o.customer_name,
           o.notes, o.created_at, o.approved_at, o.delivered_at
    FROM orders o
    JOIN partners pt ON pt.id = o.partner_id
    LEFT JOIN users u ON u.id = o.placed_by
    LEFT JOIN roles ur ON ur.id = u.role_id
    ${where}
    ORDER BY o.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM orders o
    JOIN partners pt ON pt.id = o.partner_id
    LEFT JOIN users u ON u.id = o.placed_by
    LEFT JOIN roles ur ON ur.id = u.role_id
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);

  for (const order of result.data) {
    const [items] = await pool.execute(
      `SELECT oi.id, oi.product_id, p.name AS product_name, p.sku, p.image_url,
              oi.quantity, oi.unit_price, oi.subtotal
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
  const scope = buildOrderScope(req.user);
  const params = [req.params.id, ...scope.params];
  const where = `WHERE o.id = ? AND o.is_deleted = 0${scope.clause}`;

  const [rows] = await pool.execute(
    `SELECT o.*, pt.business_name AS partner_name, u.name AS placed_by_name,
            u.email AS placed_by_email, ur.slug AS placed_by_role_slug,
            a.name AS approved_by_name, verifier.name AS payment_verified_by_name
     FROM orders o
     JOIN partners pt ON pt.id = o.partner_id
     LEFT JOIN users u ON u.id = o.placed_by
     LEFT JOIN roles ur ON ur.id = u.role_id
     LEFT JOIN users a ON a.id = o.approved_by
     LEFT JOIN users verifier ON verifier.id = o.payment_proof_verified_by
     ${where} LIMIT 1`,
    params
  );

  if (rows.length === 0) throw ApiError.notFound('Order not found');
  const order = rows[0];

  const [items] = await pool.execute(
    `SELECT oi.id, oi.product_id, p.name AS product_name, p.sku, p.image_url,
            oi.quantity, oi.unit_price, oi.subtotal
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`,
    [order.id]
  );
  order.items = items;

  res.json({ success: true, data: order });
});

// POST /api/v1/orders — checkout cart (authenticated stockist)
const createOrder = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const partnerId = req.user.partner_id;
  const { notes, payment_method } = req.body;

  if (!partnerId) throw ApiError.badRequest('Only Stockist users can place orders');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [partner] = await executeSoftDeleteAware(
      conn,
      'SELECT id, business_name, parent_partner_id, stockist_level, discount_pct FROM partners WHERE id = ? AND is_deleted = 0',
      [partnerId],
      'SELECT id, business_name, parent_partner_id, stockist_level, discount_pct FROM partners WHERE id = ?'
    );
    if (partner.length === 0) throw ApiError.badRequest('Partner account not found');

    const partnerData = partner[0];

    // Determine source warehouse
    // City stockist → order from parent provincial warehouse
    // Provincial stockist → order from Goldenstar (type = 'manufacturer')
    const sourceWarehouseId = await resolveSourceWarehouseIdForPartner(conn, partnerId);

    const [cartItems] = await executeSoftDeleteAware(
      conn,
      `SELECT ci.id, ci.product_id, ci.quantity, p.name AS product_name,
              p.partner_price, p.sku
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = ? AND p.is_deleted = 0 AND p.is_active = 1`,
      [userId],
      `SELECT ci.id, ci.product_id, ci.quantity, p.name AS product_name,
              p.partner_price, p.sku
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.user_id = ? AND p.is_active = 1`
    );

    if (cartItems.length === 0) throw ApiError.badRequest('Cart is empty');

    // Compute prices with discount locked at order time
    let totalAmount = 0;
    const discountPct = partnerData.discount_pct || 0;

    for (const item of cartItems) {
      const unitPrice = parseFloat(item.partner_price) * (1 - discountPct / 100);
      item.lockedUnitPrice = Math.round(unitPrice * 100) / 100;
      totalAmount += item.quantity * item.lockedUnitPrice;
    }

    normalizeOrderPaymentMethod(payment_method);
    const codAmount = 0;

    // Check available stock if source warehouse known
    if (sourceWarehouseId) {
      for (const item of cartItems) {
        const [inv] = await executeSoftDeleteAware(
          conn,
          `SELECT current_stock, reserved_stock FROM inventories
           WHERE product_id = ? AND warehouse_id = ? AND is_deleted = 0`,
          [item.product_id, sourceWarehouseId],
          `SELECT current_stock, reserved_stock FROM inventories
           WHERE product_id = ? AND warehouse_id = ?`
        );
        const available = inv.length > 0 ? inv[0].current_stock - inv[0].reserved_stock : 0;
        if (available < item.quantity) {
          throw ApiError.badRequest(`Insufficient stock for ${item.product_name} (available: ${available})`);
        }
      }
    }

    const orderNumber = await generateOrderNum('ORD', 'orders', 'order_number');

    let orderResult;
    try {
      [orderResult] = await conn.execute(
        `INSERT INTO orders (order_number, partner_id, placed_by, placed_by_type, source_warehouse_id, cod_amount, total_amount, notes)
         VALUES (?, ?, ?, 'user', ?, ?, ?, ?)`,
        [orderNumber, partnerId, userId, sourceWarehouseId, codAmount, totalAmount, notes || null]
      );
    } catch (err) {
      // Backward compatibility for DBs missing v2 order columns.
      if (isMissingColumn(err, 'cod_amount')) {
        try {
          [orderResult] = await conn.execute(
            `INSERT INTO orders (order_number, partner_id, placed_by, placed_by_type, source_warehouse_id, total_amount, notes)
             VALUES (?, ?, ?, 'user', ?, ?, ?)`,
            [orderNumber, partnerId, userId, sourceWarehouseId, totalAmount, notes || null]
          );
        } catch (innerErr) {
          if (isMissingColumn(innerErr, 'source_warehouse_id') || isMissingColumn(innerErr, 'placed_by_type')) {
            [orderResult] = await conn.execute(
              `INSERT INTO orders (order_number, partner_id, placed_by, total_amount, notes)
               VALUES (?, ?, ?, ?, ?)`,
              [orderNumber, partnerId, userId, totalAmount, notes || null]
            );
          } else {
            throw innerErr;
          }
        }
      } else if (isMissingColumn(err, 'source_warehouse_id') || isMissingColumn(err, 'placed_by_type')) {
        [orderResult] = await conn.execute(
          `INSERT INTO orders (order_number, partner_id, placed_by, total_amount, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [orderNumber, partnerId, userId, totalAmount, notes || null]
        );
      } else {
        throw err;
      }
    }
    const orderId = orderResult.insertId;

    for (const item of cartItems) {
      try {
        await conn.execute(
          `INSERT INTO order_items (order_id, product_id, source_warehouse_id, quantity, unit_price)
           VALUES (?, ?, ?, ?, ?)`,
          [orderId, item.product_id, sourceWarehouseId, item.quantity, item.lockedUnitPrice]
        );
      } catch (err) {
        // Backward compatibility for DBs where order_items has no source_warehouse_id.
        if (isMissingColumn(err, 'source_warehouse_id')) {
          await conn.execute(
            `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
             VALUES (?, ?, ?, ?)`,
            [orderId, item.product_id, item.quantity, item.lockedUnitPrice]
          );
        } else {
          throw err;
        }
      }
    }

    // Reserve stock
    if (sourceWarehouseId) {
      for (const item of cartItems) {
        await reserveInventoryOrThrow(conn, {
          productId: item.product_id,
          warehouseId: sourceWarehouseId,
          quantity: item.quantity,
          productName: item.product_name,
        });
        await insertStockMovement(conn, {
          productId: item.product_id,
          warehouseId: sourceWarehouseId,
          movementType: 'reserve',
          quantity: item.quantity,
          referenceType: 'order',
          referenceId: orderId,
          notes: 'Stock reserved on order placement',
          createdBy: req.user.id,
        });
      }
    }

    // Clear cart
    await conn.execute('DELETE FROM cart_items WHERE user_id = ?', [userId]);

    const admins = await notifySuperAdmins(
      conn, 'order_placed',
      `New Order: #${orderNumber}`,
      `New order #${orderNumber} from ${partnerData.business_name} worth ₱${totalAmount.toFixed(2)}`,
      orderId
    );

    await conn.commit();
    await cache.delPattern('dashboard:*');

    // Email all super admins
    for (const admin of admins) {
      const tmpl = EMAIL.orderPlaced(orderNumber, partnerData.business_name);
      await sendEmail({ to: admin.email, toName: admin.name, ...tmpl });
    }

    res.status(201).json({ success: true, message: 'Order placed successfully', data: { id: orderId, order_number: orderNumber, total_amount: totalAmount } });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/v1/orders/public — public order (no auth, mobile/walk-in customer)
const createPublicOrder = asyncHandler(async (req, res) => {
  const { customer_name, customer_phone, customer_email, customer_address, items, notes, payment_method } = req.body;

  if (!customer_name || !customer_address) throw ApiError.badRequest('customer_name and customer_address are required');
  if (!items || items.length === 0) throw ApiError.badRequest('items are required');

  // Auto-assign nearest stockist (city or provincial) based on customer address
  // For now, assign the first available city/provincial stockist
  // In production this uses ST_Distance_Sphere on warehouse coordinates
  let nearestPartner;
  try {
    [nearestPartner] = await executeSoftDeleteAware(
      pool,
      `SELECT p.id AS partner_id, w.id AS warehouse_id
       FROM partners p
       JOIN warehouses w ON w.partner_id = p.id
       WHERE p.stockist_level IN ('city_stockist', 'provincial_stockist')
         AND p.is_deleted = 0 AND w.is_deleted = 0
       LIMIT 1`,
      [],
      `SELECT p.id AS partner_id, w.id AS warehouse_id
       FROM partners p
       JOIN warehouses w ON w.partner_id = p.id
       WHERE p.stockist_level IN ('city_stockist', 'provincial_stockist')
       LIMIT 1`
    );
  } catch (err) {
    if (!isMissingColumn(err, 'w.partner_id') && !isMissingColumn(err, 'partner_id')) {
      throw err;
    }

    [nearestPartner] = await executeSoftDeleteAware(
      pool,
      `SELECT p.id AS partner_id, i.warehouse_id
       FROM partners p
       JOIN inventories i ON i.partner_id = p.id AND i.is_active = 1
       JOIN warehouses w ON w.id = i.warehouse_id
       WHERE p.stockist_level IN ('city_stockist', 'provincial_stockist')
         AND p.is_deleted = 0 AND w.is_deleted = 0
       GROUP BY p.id, i.warehouse_id
       ORDER BY MIN(i.id)
       LIMIT 1`,
      [],
      `SELECT p.id AS partner_id, i.warehouse_id
       FROM partners p
       JOIN inventories i ON i.partner_id = p.id
       JOIN warehouses w ON w.id = i.warehouse_id
       WHERE p.stockist_level IN ('city_stockist', 'provincial_stockist')
       GROUP BY p.id, i.warehouse_id
       ORDER BY MIN(i.id)
       LIMIT 1`
    );
  }

  if (nearestPartner.length === 0) throw ApiError.serviceUnavailable('No available Stockist to handle this order');

  const { partner_id: partnerId, warehouse_id: sourceWarehouseId } = nearestPartner[0];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let totalAmount = 0;
    const resolvedItems = [];

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw ApiError.badRequest(`Invalid quantity for product ${item.product_id}`);
      }

      const [products] = await executeSoftDeleteAware(
        conn,
        'SELECT id, name, partner_price FROM products WHERE id = ? AND is_deleted = 0 AND is_active = 1 LIMIT 1',
        [item.product_id],
        'SELECT id, name, partner_price FROM products WHERE id = ? AND is_active = 1 LIMIT 1'
      );
      if (products.length === 0) throw ApiError.badRequest(`Product ${item.product_id} not found`);
      const price = parseFloat(products[0].partner_price);
      resolvedItems.push({ ...item, quantity, name: products[0].name, unit_price: price });
      totalAmount += quantity * price;
    }

    normalizeOrderPaymentMethod(payment_method);
    const codAmount = 0;

    if (sourceWarehouseId) {
      for (const item of resolvedItems) {
        const [inv] = await executeSoftDeleteAware(
          conn,
          `SELECT current_stock, reserved_stock FROM inventories
           WHERE product_id = ? AND warehouse_id = ? AND is_deleted = 0`,
          [item.product_id, sourceWarehouseId],
          `SELECT current_stock, reserved_stock FROM inventories
           WHERE product_id = ? AND warehouse_id = ?`
        );
        const available = inv.length > 0 ? Number(inv[0].current_stock || 0) - Number(inv[0].reserved_stock || 0) : 0;
        if (available < item.quantity) {
          throw ApiError.badRequest(`Insufficient stock for ${item.name} (available: ${available})`);
        }
      }
    }

    const orderNumber = await generateOrderNum('PUB', 'orders', 'order_number');

    let orderResult;
    try {
      [orderResult] = await conn.execute(
        `INSERT INTO orders (order_number, partner_id, placed_by_type, source_warehouse_id,
                             customer_name, customer_phone, customer_email, customer_address, cod_amount,
                             total_amount, notes)
         VALUES (?, ?, 'public', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderNumber, partnerId, sourceWarehouseId, customer_name, customer_phone || null,
         customer_email || null, customer_address, codAmount, totalAmount, notes || null]
      );
    } catch (err) {
      // Some DBs are partially migrated and only miss source_warehouse_id.
      if (isMissingColumn(err, 'cod_amount')) {
        try {
          [orderResult] = await conn.execute(
            `INSERT INTO orders (order_number, partner_id, placed_by_type, source_warehouse_id,
                                 customer_name, customer_phone, customer_email, customer_address,
                                 total_amount, notes)
             VALUES (?, ?, 'public', ?, ?, ?, ?, ?, ?, ?)`,
            [orderNumber, partnerId, sourceWarehouseId, customer_name, customer_phone || null,
             customer_email || null, customer_address, totalAmount, notes || null]
          );
        } catch (innerErr) {
          if (isMissingColumn(innerErr, 'source_warehouse_id')) {
            try {
              [orderResult] = await conn.execute(
                `INSERT INTO orders (order_number, partner_id, placed_by_type,
                                     customer_name, customer_phone, customer_email, customer_address,
                                     total_amount, notes)
                 VALUES (?, ?, 'public', ?, ?, ?, ?, ?, ?)`,
                [orderNumber, partnerId, customer_name, customer_phone || null,
                 customer_email || null, customer_address, totalAmount, notes || null]
              );
            } catch (legacyErr) {
              if (isMissingColumn(legacyErr, 'placed_by_type') || isMissingColumn(legacyErr, 'customer_name')) {
                throw ApiError.internal('Database schema is outdated for public orders. Please apply the latest migration.');
              }
              throw legacyErr;
            }
          } else if (isMissingColumn(innerErr, 'placed_by_type') || isMissingColumn(innerErr, 'customer_name')) {
            throw ApiError.internal('Database schema is outdated for public orders. Please apply the latest migration.');
          }
          throw innerErr;
        }
      } else if (isMissingColumn(err, 'source_warehouse_id')) {
        try {
          [orderResult] = await conn.execute(
            `INSERT INTO orders (order_number, partner_id, placed_by_type,
                                 customer_name, customer_phone, customer_email, customer_address,
                                 total_amount, notes)
             VALUES (?, ?, 'public', ?, ?, ?, ?, ?, ?)`,
            [orderNumber, partnerId, customer_name, customer_phone || null,
             customer_email || null, customer_address, totalAmount, notes || null]
          );
        } catch (innerErr) {
          if (isMissingColumn(innerErr, 'placed_by_type') || isMissingColumn(innerErr, 'customer_name')) {
            throw ApiError.internal('Database schema is outdated for public orders. Please apply the latest migration.');
          }
          throw innerErr;
        }
      } else if (isMissingColumn(err, 'placed_by_type') || isMissingColumn(err, 'customer_name')) {
        throw ApiError.internal('Database schema is outdated for public orders. Please apply the latest migration.');
      } else {
        throw err;
      }
    }
    const orderId = orderResult.insertId;

    for (const item of resolvedItems) {
      try {
        await conn.execute(
          `INSERT INTO order_items (order_id, product_id, source_warehouse_id, quantity, unit_price)
           VALUES (?, ?, ?, ?, ?)`,
          [orderId, item.product_id, sourceWarehouseId, item.quantity, item.unit_price]
        );
      } catch (err) {
        if (isMissingColumn(err, 'source_warehouse_id')) {
          await conn.execute(
            `INSERT INTO order_items (order_id, product_id, quantity, unit_price)
             VALUES (?, ?, ?, ?)`,
            [orderId, item.product_id, item.quantity, item.unit_price]
          );
        } else {
          throw err;
        }
      }
    }

    if (sourceWarehouseId) {
      for (const item of resolvedItems) {
        await reserveInventoryOrThrow(conn, {
          productId: item.product_id,
          warehouseId: sourceWarehouseId,
          quantity: item.quantity,
          productName: item.name,
        });
        await insertStockMovement(conn, {
          productId: item.product_id,
          warehouseId: sourceWarehouseId,
          movementType: 'reserve',
          quantity: item.quantity,
          referenceType: 'order',
          referenceId: orderId,
          notes: 'Stock reserved on public order placement',
        });
      }
    }

    await conn.commit();

    res.status(201).json({
      success: true,
      message: 'Order placed successfully. You will be contacted shortly.',
      data: { order_number: orderNumber, total_amount: totalAmount },
    });
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

  const orders = await getOrderRowsWithOptionalSourceColumn(
    pool,
    'WHERE id = ? AND is_deleted = 0',
    [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'pending') throw ApiError.badRequest('Only pending orders can be approved');

  let sourceWarehouseId = orders[0].source_warehouse_id || null;
  if (!sourceWarehouseId) {
    sourceWarehouseId = await resolveSourceWarehouseIdForPartner(pool, orders[0].partner_id);
  }

  const deadline = new Date(Date.now() + env.PAYMENT_DEADLINE_HOURS * 60 * 60 * 1000);

  // Find bank account for the source warehouse
  let bankDetails = null;
  if (sourceWarehouseId) {
    const [banks] = await executeSoftDeleteAware(
      pool,
      `SELECT bank_name, account_name, account_number FROM bank_accounts
       WHERE warehouse_id = ? AND is_active = 1 AND is_deleted = 0 LIMIT 1`,
      [sourceWarehouseId],
      `SELECT bank_name, account_name, account_number FROM bank_accounts
       WHERE warehouse_id = ? AND is_active = 1 LIMIT 1`
    );
    if (banks.length > 0) {
      const b = banks[0];
      bankDetails = `${b.bank_name} — ${b.account_name} — ${b.account_number}`;
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE orders SET status = 'approved', approved_by = ?, approved_at = NOW(), payment_deadline = ? WHERE id = ?`,
      [req.user.id, deadline, orderId]
    );

    const partnerUsers = await notifyPartnerUsers(
      conn, orders[0].partner_id, 'order_approved',
      `Order Approved: #${orders[0].order_number}`,
      `Your order #${orders[0].order_number} has been approved. Pay within ${env.PAYMENT_DEADLINE_HOURS} hours.`,
      orderId
    );
    await conn.commit();

    for (const pu of partnerUsers) {
      const tmpl = EMAIL.orderApproved(
        orders[0].order_number,
        env.PAYMENT_DEADLINE_HOURS,
        bankDetails
      );
      await sendEmail({ to: pu.email, toName: pu.name, ...tmpl });
    }

    await cache.delPattern('dashboard:*');
    res.json({ success: true, message: 'Order approved', data: { payment_deadline: deadline } });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/orders/:id/reject
const rejectOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const orderId = req.params.id;

  const orders = await getOrderRowsWithOptionalSourceColumn(
    pool,
    'WHERE id = ? AND is_deleted = 0',
    [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'pending') throw ApiError.badRequest('Only pending orders can be rejected');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE orders SET status = 'rejected', cancellation_reason = ?, cancelled_by = ?, updated_at = NOW() WHERE id = ?`,
      [reason || null, req.user.id, orderId]
    );

    // Release reserved stock
    const items = await getOrderItemsWithOptionalSourceColumn(conn, orderId);
    let fallbackWarehouseId = orders[0].source_warehouse_id || null;
    if (!fallbackWarehouseId) {
      fallbackWarehouseId = await resolveSourceWarehouseIdForPartner(conn, orders[0].partner_id);
    }
    for (const item of items) {
      const wid = item.source_warehouse_id || fallbackWarehouseId;
      if (wid) {
        await conn.execute(
          `UPDATE inventories SET reserved_stock = GREATEST(0, reserved_stock - ?) WHERE product_id = ? AND warehouse_id = ?`,
          [item.quantity, item.product_id, wid]
        );
        await insertStockMovement(conn, {
          productId: item.product_id,
          warehouseId: wid,
          movementType: 'release',
          quantity: item.quantity,
          referenceType: 'order',
          referenceId: orderId,
          notes: 'Reserved stock released — order rejected',
          createdBy: req.user.id,
        });
      }
    }

    const partnerUsers = await notifyPartnerUsers(
      conn, orders[0].partner_id, 'order_rejected',
      `Order Rejected: #${orders[0].order_number}`,
      `Order #${orders[0].order_number} was rejected. Reason: ${reason || 'N/A'}`,
      orderId
    );
    await conn.commit();

    for (const pu of partnerUsers) {
      const tmpl = EMAIL.orderRejected(orders[0].order_number, reason);
      await sendEmail({ to: pu.email, toName: pu.name, ...tmpl });
    }

    await cache.delPattern('dashboard:*');
    res.json({ success: true, message: 'Order rejected' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/orders/:id/cancel — stockist self-cancel (pending only)
const cancelOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  const orderId = req.params.id;

  const scope = buildOrderScope(req.user, { orderAlias: '' });
  const params = [orderId, ...scope.params];

  const orders = await getOrderRowsWithOptionalSourceColumn(
    pool,
    `WHERE id = ? AND is_deleted = 0${scope.clause}`,
    params
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'pending') throw ApiError.badRequest('Only pending orders can be self-cancelled');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE orders SET status = 'cancelled', cancellation_reason = ?, cancelled_by = ?, updated_at = NOW() WHERE id = ?`,
      [reason || 'Cancelled by Stockist', req.user.id, orderId]
    );

    // Release reserved stock
    const items = await getOrderItemsWithOptionalSourceColumn(conn, orderId);
    let fallbackWarehouseId = orders[0].source_warehouse_id || null;
    if (!fallbackWarehouseId) {
      fallbackWarehouseId = await resolveSourceWarehouseIdForPartner(conn, orders[0].partner_id);
    }
    for (const item of items) {
      const wid = item.source_warehouse_id || fallbackWarehouseId;
      if (wid) {
        await conn.execute(
          `UPDATE inventories SET reserved_stock = GREATEST(0, reserved_stock - ?) WHERE product_id = ? AND warehouse_id = ?`,
          [item.quantity, item.product_id, wid]
        );
        await insertStockMovement(conn, {
          productId: item.product_id,
          warehouseId: wid,
          movementType: 'release',
          quantity: item.quantity,
          referenceType: 'order',
          referenceId: orderId,
          notes: 'Reserved stock released on order cancellation',
          createdBy: req.user.id,
        });
      }
    }

    await conn.commit();
    await cache.delPattern('dashboard:*');
    res.json({ success: true, message: 'Order cancelled' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// POST /api/v1/orders/:id/payment-proof — upload payment proof (Cloudinary)
const uploadPaymentProof = asyncHandler(async (req, res) => {
  const orderId = req.params.id;

  if (!req.file) throw ApiError.badRequest('Payment proof file is required');

  const scope = buildOrderScope(req.user, { orderAlias: '' });
  const params = [orderId, ...scope.params];

  const [orders] = await pool.execute(
    `SELECT id, order_number, partner_id, status FROM orders WHERE id = ? AND is_deleted = 0${scope.clause}`,
    params
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'approved') throw ApiError.badRequest('Payment proof can only be uploaded for approved orders');

  const proofUrl = req.file.path; // Cloudinary URL

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE orders SET payment_proof_url = ?, payment_proof_uploaded_at = NOW() WHERE id = ?`,
      [proofUrl, orderId]
    );

    const admins = await notifySuperAdmins(
      conn, 'payment_proof_uploaded',
      `Payment Proof: #${orders[0].order_number}`,
      `Payment proof uploaded for order #${orders[0].order_number}. Please verify.`,
      orderId
    );
    await conn.commit();

    // Get stockist name
    const [partnerRow] = await pool.execute('SELECT business_name FROM partners WHERE id = ?', [orders[0].partner_id]);
    const stockistName = partnerRow[0]?.business_name || 'Stockist';

    for (const admin of admins) {
      const tmpl = EMAIL.paymentProofUploaded(orders[0].order_number, stockistName);
      await sendEmail({ to: admin.email, toName: admin.name, ...tmpl });
    }

    res.json({ success: true, message: 'Payment proof uploaded', data: { payment_proof_url: proofUrl } });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/orders/:id/verify-payment — super_admin verifies payment proof
const verifyPayment = asyncHandler(async (req, res) => {
  const orderId = req.params.id;

  const [orders] = await pool.execute(
    'SELECT id, order_number, partner_id, status, payment_proof_url, total_amount FROM orders WHERE id = ? AND is_deleted = 0',
    [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'approved') throw ApiError.badRequest('Order must be in approved status');
  if (!orders[0].payment_proof_url) throw ApiError.badRequest('No payment proof has been uploaded');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE orders SET payment_status = 'paid', payment_proof_verified_by = ?, payment_proof_verified_at = NOW() WHERE id = ?`,
      [req.user.id, orderId]
    );
    await createPendingSettlementForOrder(conn, {
      orderId,
      partnerId: orders[0].partner_id,
      amount: orders[0].total_amount,
      method: 'bank_transfer',
    });

    const partnerUsers = await notifyPartnerUsers(
      conn, orders[0].partner_id, 'payment_verified',
      `Payment Confirmed: #${orders[0].order_number}`,
      `Payment for order #${orders[0].order_number} has been verified. Delivery is being arranged.`,
      orderId
    );
    await conn.commit();

    for (const pu of partnerUsers) {
      const tmpl = EMAIL.paymentVerified(orders[0].order_number);
      await sendEmail({ to: pu.email, toName: pu.name, ...tmpl });
    }

    res.json({ success: true, message: 'Payment verified' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = {
  getOrders,
  getOrder,
  createOrder,
  createPublicOrder,
  approveOrder,
  rejectOrder,
  cancelOrder,
  uploadPaymentProof,
  verifyPayment,
  __testables: {
    buildOrderScope,
    normalizeOrderPaymentMethod,
  },
};
