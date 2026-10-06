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
const {
  getBankAccountForWarehouseOrDefault,
  assertBankAccountAvailable,
  getPublicPaymentAccounts,
  selectPublicPaymentAccount,
  toBuyerFacingAccount,
} = require('../services/bankAccountResolver');
const { getIdempotencyKey, claimPublicOrderIntent, completePublicOrderIntent } = require('../services/publicOrderIdempotency');
const {
  PUBLIC_ORDER_SHIPPING_FEE,
  getPublicOrderPricingTotals,
  reconcilePublicOrderPricing,
} = require('../services/publicCheckoutPricing');
const { getPaymentVerificationDecision } = require('../services/paymentVerification');
const { enqueueOrderNotifications } = require('../services/orderNotificationOutbox');
const { reserveStock, releaseStock } = require('../services/batchStock');
const { lookupMlmMember } = require('../services/mlmBridge');
const { readPublicCustomer, assertBarangayExists } = require('../services/publicCustomerInput');
const { publicPaymentDeadline } = require('../services/publicOrderPayment');
const { phonesMatch } = require('../utils/phoneMatch');
const { orderCustomerJoins, orderCustomerNameSql, orderCustomerAddressSql, orderIsPublicSql } = require('../utils/orderCustomerSql');
const MEMBER_DISCOUNT_PCT = 30; // Nogatu member discount (off the public price)
const {
  resolveAffiliationContext,
  buildOrderScopeFromContext,
  canApproveOrderFromContext,
  canVerifyPaymentFromContext,
} = require('../rbac/affiliationScopes');
const { PARTNER_LEVELS } = require('../rbac/roles');

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

async function getPublicOrderPlacedByUserId(db) {
  const [rows] = await executeSoftDeleteAware(
    db,
    `SELECT u.id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin'
       AND u.status = 'active'
       AND u.is_deleted = 0
     ORDER BY u.id ASC
     LIMIT 1`,
    [],
    `SELECT u.id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin'
       AND u.status = 'active'
     ORDER BY u.id ASC
     LIMIT 1`
  );

  if (rows.length === 0) {
    throw ApiError.serviceUnavailable('No active super admin is available to own public orders');
  }

  return rows[0].id;
}

// Spreads the reservation over the product's batch rows (services/batchStock.js).
async function reserveInventoryOrThrow(conn, { productId, warehouseId, quantity, productName }) {
  const result = await reserveStock(conn, { productId, warehouseId, quantity });
  if (!result.reserved) {
    throw ApiError.badRequest(`Insufficient stock for ${productName || 'product'} (available: ${result.available})`);
  }
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

// Public (storefront + influencer) orders are fulfilled ONLY by company fulfillment centers.
// A Stockist never fulfils them and there is deliberately no fallback to one: if no center can
// serve the order the customer gets a clear 409 instead of the order leaking to a Stockist.
async function listPublicFulfillmentCandidates(db) {
  const [rows] = await db.execute(
    `SELECT p.id AS partner_id, w.id AS warehouse_id, w.lat, w.lng
     FROM partners p
     JOIN warehouses w ON w.partner_id = p.id
     WHERE p.stockist_level = 'center'
       AND p.status = 'active' AND p.is_deleted = 0
       AND w.is_deleted = 0 AND w.is_active = 1
     ORDER BY w.id ASC`
  );
  return rows;
}

// Checks every requested line against one warehouse with a single query. Returns
// `totalAvailable` (sum of available units over the requested products) so callers can prefer
// the center holding the most stock.
async function canWarehouseFulfillItems(db, warehouseId, items) {
  const requestedByProduct = new Map();
  const nameByProduct = new Map();
  for (const item of items) {
    const productId = Number(item.product_id);
    requestedByProduct.set(productId, (requestedByProduct.get(productId) || 0) + item.quantity);
    nameByProduct.set(productId, item.name);
  }

  const productIds = [...requestedByProduct.keys()];
  const placeholders = productIds.map(() => '?').join(', ');
  // Same soft-delete-aware shape as reserveInventoryOrThrow: some deployments' inventories table has
  // no is_deleted column, and the availability check must count exactly the rows reservation locks.
  const [inventoryRows] = await executeSoftDeleteAware(
    db,
    `SELECT product_id, SUM(current_stock) AS current_stock, SUM(reserved_stock) AS reserved_stock
     FROM inventories
     WHERE warehouse_id = ? AND product_id IN (${placeholders}) AND is_deleted = 0
     GROUP BY product_id`,
    [warehouseId, ...productIds],
    `SELECT product_id, SUM(current_stock) AS current_stock, SUM(reserved_stock) AS reserved_stock
     FROM inventories
     WHERE warehouse_id = ? AND product_id IN (${placeholders})
     GROUP BY product_id`
  );

  const availableByProduct = new Map(inventoryRows.map((row) => [
    Number(row.product_id),
    Number(row.current_stock || 0) - Number(row.reserved_stock || 0),
  ]));

  let totalAvailable = 0;
  for (const [productId, requestedQty] of requestedByProduct) {
    const availableQty = availableByProduct.get(productId) || 0;
    if (availableQty < requestedQty) {
      return { ok: false, productName: nameByProduct.get(productId), availableQty };
    }
    totalAvailable += availableQty;
  }

  return { ok: true, totalAvailable };
}

function haversineDistanceKm(originLat, originLng, targetLat, targetLng) {
  const toRadians = (value) => Number(value) * Math.PI / 180;
  const lat1 = toRadians(originLat);
  const lat2 = toRadians(targetLat);
  const deltaLat = toRadians(Number(targetLat) - Number(originLat));
  const deltaLng = toRadians(Number(targetLng) - Number(originLng));
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const hasCoordinates = (lat, lng) => lat != null && lng != null
  && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

// Orders capable centers best-first. With a customer pin: nearest first, centers without
// coordinates last. Without one: most available stock first. Warehouse id is always the final
// tie-break so the same inputs pick the same center on every request.
function rankPublicFulfillmentCandidates(candidates, { customerLat, customerLng } = {}) {
  const hasCustomerLocation = hasCoordinates(customerLat, customerLng);
  const distanceKm = (candidate) => (
    hasCustomerLocation && hasCoordinates(candidate.lat, candidate.lng)
      ? haversineDistanceKm(customerLat, customerLng, candidate.lat, candidate.lng)
      : Number.POSITIVE_INFINITY
  );

  return candidates
    .map((candidate) => ({ candidate, distance: distanceKm(candidate) }))
    .sort((left, right) => {
      if (left.distance !== right.distance) return left.distance < right.distance ? -1 : 1;
      const leftStock = Number(left.candidate.available_qty || 0);
      const rightStock = Number(right.candidate.available_qty || 0);
      if (!hasCustomerLocation && leftStock !== rightStock) return rightStock - leftStock;
      return Number(left.candidate.warehouse_id) - Number(right.candidate.warehouse_id);
    })
    .map(({ candidate }) => candidate);
}

async function resolvePublicFulfillmentRoute(db, items, location = {}) {
  const candidates = await listPublicFulfillmentCandidates(db);
  if (candidates.length === 0) {
    throw ApiError.serviceUnavailable('No fulfillment center is available to handle this order');
  }

  const capable = [];
  let firstShortage = null;

  for (const candidate of candidates) {
    const fulfillmentCheck = await canWarehouseFulfillItems(db, candidate.warehouse_id, items);
    if (fulfillmentCheck.ok) {
      capable.push({ ...candidate, available_qty: fulfillmentCheck.totalAvailable });
    } else if (!firstShortage) {
      firstShortage = fulfillmentCheck;
    }
  }

  if (capable.length === 0) {
    throw ApiError.conflict(
      `Not enough stock at our fulfillment centers for ${firstShortage.productName || 'this product'}`
    );
  }

  return rankPublicFulfillmentCandidates(capable, location)[0];
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
  affiliationContext = null,
  placedByRoleAlias = null,
} = {}) {
  const context = affiliationContext || {
    role: user?.role_slug,
    userId: user?.id,
    partnerId: user?.partner_id,
    partnerLevel: user?.role_slug === 'provincial_stockist' || user?.role_slug === 'city_stockist'
      ? user?.role_slug
      : null,
    childCityPartnerIds: [],
  };

  return buildOrderScopeFromContext(context, { orderAlias, placedByRoleAlias });
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

function getPublicOrderUnitPrice(product) {
  const retailPrice = product?.retail_price == null || product?.retail_price === ''
    ? null
    : Number(product.retail_price);
  if (Number.isFinite(retailPrice) && retailPrice >= 0) {
    return retailPrice;
  }

  const price = product?.price == null || product?.price === ''
    ? null
    : Number(product.price);
  if (Number.isFinite(price) && price >= 0) {
    return price;
  }

  const partnerPrice = product?.partner_price == null || product?.partner_price === ''
    ? null
    : Number(product.partner_price);
  if (Number.isFinite(partnerPrice) && partnerPrice >= 0) {
    return partnerPrice;
  }

  throw ApiError.badRequest('Product price is unavailable');
}

function buildBankDetailsString(bankAccount) {
  if (!bankAccount) {
    return null;
  }

  return `${bankAccount.bank_name} - ${bankAccount.account_name} - ${bankAccount.account_number}`;
}

function buildPublicPaymentContext({
  orderNumber,
  totalAmount,
  merchandiseSubtotal = null,
  memberDiscountAmount = null,
  shippingFee = null,
  systemFee = null,
  bankAccount,
  paymentDeadline,
  paymentProofUploadedAt = null,
  paymentStatus = 'pending',
}) {
  return {
    order_number: orderNumber,
    total_amount: Number(totalAmount || 0),
    merchandise_subtotal: merchandiseSubtotal == null ? null : Number(merchandiseSubtotal || 0),
    member_discount_amount: memberDiscountAmount == null ? null : Number(memberDiscountAmount || 0),
    shipping_fee: shippingFee == null ? null : Number(shippingFee || 0),
    system_fee: systemFee == null ? null : Number(systemFee || 0),
    payment_status: paymentStatus || 'pending',
    payment_deadline: paymentDeadline || null,
    payment_proof_uploaded_at: paymentProofUploadedAt || null,
    bank_account: toBuyerFacingAccount(bankAccount),
  };
}

function buildOrderPricingBreakdown(order, items = []) {
  const itemSubtotal = items.reduce(
    (sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0),
    0
  );
  const totalAmount = Number(order?.total_amount || 0);
  const merchandiseSubtotal = order?.merchandise_subtotal == null
    ? itemSubtotal
    : Number(order.merchandise_subtotal);
  const isPublic = order?.placed_by_type === 'public' || Boolean(order?.is_public);
  const shippingFee = order?.shipping_fee == null
    ? (isPublic && totalAmount - merchandiseSubtotal >= PUBLIC_ORDER_SHIPPING_FEE
      ? PUBLIC_ORDER_SHIPPING_FEE
      : 0)
    : Number(order.shipping_fee);
  const systemFee = order?.system_fee == null
    ? Math.max(totalAmount - merchandiseSubtotal - shippingFee, 0)
    : Number(order.system_fee);
  const reconciled = reconcilePublicOrderPricing({
    merchandiseSubtotal,
    memberDiscountAmount: order?.member_discount_amount || 0,
    shippingFee,
    systemFee,
    totalAmount,
  });

  return {
    merchandise_subtotal: reconciled.merchandiseSubtotal,
    member_discount_amount: reconciled.memberDiscountAmount,
    shipping_fee: reconciled.shippingFee,
    system_fee: reconciled.systemFee,
    adjustment_amount: reconciled.adjustmentAmount,
    total_amount: reconciled.totalDue,
  };
}

// GET /api/v1/orders
const getOrders = asyncHandler(async (req, res) => {
  const { page, limit, status, payment_status, search } = req.query;
  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  const scope = buildOrderScope(req.user, {
    affiliationContext,
    placedByRoleAlias: 'ur',
  });
  const params = [];
  let where = `WHERE o.is_deleted = 0${scope.clause}`;
  params.push(...scope.params);

  if (status) { where += ' AND o.status = ?'; params.push(status); }
  if (payment_status) { where += ' AND o.payment_status = ?'; params.push(payment_status); }
  if (search) {
    where += ' AND (o.order_number LIKE ? OR pt.business_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  // Order Archive: by default the active list hides archived orders. Pass
  // ?archived=true to view the archive. Archived orders KEEP their record and
  // still count in reports/calculations — this is only a list filter, never a
  // data deletion.
  const showArchived = req.query.archived === 'true' || req.query.archived === '1';
  where += showArchived ? ' AND o.is_archived = 1' : ' AND o.is_archived = 0';

  const baseQuery = `
    SELECT o.id, o.order_number, o.partner_id, pt.business_name AS partner_name,
           o.placed_by, u.name AS placed_by_name, u.email AS placed_by_email, ur.slug AS placed_by_role_slug,
           o.status, o.payment_status,
           o.total_amount, o.payment_deadline, o.payment_proof_url, o.payment_proof_uploaded_at, o.cod_amount,
           EXISTS(
             SELECT 1
             FROM delivery_tokens dt
             WHERE dt.order_id = o.id
               AND dt.is_used = 0
               AND dt.expires_at > NOW()
           ) AS has_active_delivery_link,
           o.placed_by_type, ${orderCustomerNameSql('o')} AS customer_name, o.customer_phone, o.customer_email,
           ${orderCustomerAddressSql('o')} AS customer_address,
           ${orderIsPublicSql('o')} AS is_public,
           o.notes, o.created_at, o.approved_at, o.delivered_at
    FROM orders o
    LEFT JOIN partners pt ON pt.id = o.partner_id
    LEFT JOIN users u ON u.id = o.placed_by
    LEFT JOIN roles ur ON ur.id = u.role_id
    ${orderCustomerJoins('o')}
    ${where}
    ORDER BY o.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM orders o
    LEFT JOIN partners pt ON pt.id = o.partner_id
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

// PATCH /api/v1/orders/:id/archive — move to the Order Archive. This is the
// "delete" action in the UI: it NEVER removes the record (revenue and history
// stay intact for accurate lifetime calculations), it only hides the order from
// the active list.
const archiveOrder = asyncHandler(async (req, res) => {
  const [r] = await pool.execute(
    'UPDATE orders SET is_archived = 1, archived_at = NOW() WHERE id = ? AND is_deleted = 0',
    [req.params.id]
  );
  if (r.affectedRows === 0) throw ApiError.notFound('Order not found');
  res.json({ success: true, message: 'Order archived' });
});

// PATCH /api/v1/orders/:id/unarchive — restore an order to the active list.
const unarchiveOrder = asyncHandler(async (req, res) => {
  const [r] = await pool.execute(
    'UPDATE orders SET is_archived = 0, archived_at = NULL WHERE id = ? AND is_deleted = 0',
    [req.params.id]
  );
  if (r.affectedRows === 0) throw ApiError.notFound('Order not found');
  res.json({ success: true, message: 'Order restored' });
});

// GET /api/v1/orders/:id
const getOrder = asyncHandler(async (req, res) => {
  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  const scope = buildOrderScope(req.user, { affiliationContext });
  const params = [req.params.id, ...scope.params];
  const where = `WHERE o.id = ? AND o.is_deleted = 0${scope.clause}`;

  const [rows] = await pool.execute(
    `SELECT o.*, pt.business_name AS partner_name, u.name AS placed_by_name,
            u.email AS placed_by_email, ur.slug AS placed_by_role_slug,
            a.name AS approved_by_name, verifier.name AS payment_verified_by_name,
            ${orderIsPublicSql('o')} AS is_public,
            ${orderCustomerNameSql('o')} AS customer_display_name,
            ${orderCustomerAddressSql('o')} AS customer_display_address
     FROM orders o
     LEFT JOIN partners pt ON pt.id = o.partner_id
     LEFT JOIN users u ON u.id = o.placed_by
     LEFT JOIN roles ur ON ur.id = u.role_id
     LEFT JOIN users a ON a.id = o.approved_by
     LEFT JOIN users verifier ON verifier.id = o.payment_proof_verified_by
     ${orderCustomerJoins('o')}
     ${where} LIMIT 1`,
    params
  );

  if (rows.length === 0) throw ApiError.notFound('Order not found');
  const { customer_display_name: customerName, customer_display_address: customerAddress, ...order } = rows[0];
  order.customer_name = customerName;
  order.customer_address = customerAddress;

  const [items] = await pool.execute(
    `SELECT oi.id, oi.product_id, p.name AS product_name, p.sku, p.image_url,
            oi.quantity, oi.unit_price, oi.subtotal
     FROM order_items oi
     JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`,
    [order.id]
  );
  order.items = items;
  order.pricing_breakdown = buildOrderPricingBreakdown(order, items);

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

    // A center is the company's own fulfillment point, not a buyer: it has no upstream warehouse
    // and no discount tier, so a stockist-style purchase from it must never be priced or routed.
    if (partnerData.stockist_level === PARTNER_LEVELS.CENTER) {
      throw ApiError.forbidden('Fulfillment centers cannot place stockist orders');
    }

    // Determine source warehouse
    // City stockist → order from parent provincial warehouse
    // Provincial stockist → order from Goldenstar (type = 'manufacturer')
    const sourceWarehouseId = await resolveSourceWarehouseIdForPartner(conn, partnerId);
    if (!sourceWarehouseId) {
      // Refuse to deduct stock from a vague/unknown source. A warehouse must be
      // assigned before any order can reserve inventory.
      throw ApiError.badRequest('No source warehouse is assigned for this account. Please assign a warehouse/storage before placing orders.');
    }

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

    // Compute prices with discount locked at order time.
    // Fixed role-based discount off partner_price (per business rule):
    //   Provincial 45% · City 40% · Mobile 35%. Falls back to the legacy
    //   per-partner discount_pct only when the stockist has no level set.
    let totalAmount = 0;
    const ROLE_DISCOUNT_PCT = { provincial_stockist: 45, city_stockist: 40, mobile_stockist: 35 };
    const fixedPct = ROLE_DISCOUNT_PCT[partnerData.stockist_level];
    const discountPct = fixedPct != null ? fixedPct : (partnerData.discount_pct || 0);

    for (const item of cartItems) {
      const unitPrice = parseFloat(item.partner_price) * (1 - discountPct / 100);
      item.lockedUnitPrice = Math.round(unitPrice * 100) / 100;
      totalAmount += item.quantity * item.lockedUnitPrice;
    }

    normalizeOrderPaymentMethod(payment_method);
    const codAmount = 0;
    const paymentDeadline = new Date(Date.now() + env.PAYMENT_DEADLINE_HOURS * 60 * 60 * 1000);
    const bankAccount = await getBankAccountForWarehouseOrDefault(conn, sourceWarehouseId);
    assertBankAccountAvailable(bankAccount);

    // Check available stock if source warehouse known (summed over every batch row of the product)
    if (sourceWarehouseId) {
      for (const item of cartItems) {
        const [inv] = await executeSoftDeleteAware(
          conn,
          `SELECT COALESCE(SUM(current_stock - reserved_stock), 0) AS available FROM inventories
           WHERE product_id = ? AND warehouse_id = ? AND is_deleted = 0`,
          [item.product_id, sourceWarehouseId],
          `SELECT COALESCE(SUM(current_stock - reserved_stock), 0) AS available FROM inventories
           WHERE product_id = ? AND warehouse_id = ?`
        );
        const available = Number(inv[0].available);
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
  const { customer_phone, customer_email, customer_lat, customer_lng, items, notes, payment_method } = req.body;
  const customer = readPublicCustomer(req.body);

  if (!items || items.length === 0) throw ApiError.badRequest('items are required');

  // Optional pinned delivery coordinates (consent-gated on the client). Stored
  // as sensitive data — never returned by the public tracking endpoint.
  const parsedLat = Number(customer_lat);
  const parsedLng = Number(customer_lng);
  const custLat = Number.isFinite(parsedLat) && parsedLat >= 4 && parsedLat <= 22 ? parsedLat : null;
  const custLng = Number.isFinite(parsedLng) && parsedLng >= 115 && parsedLng <= 128 ? parsedLng : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const idempotency = await claimPublicOrderIntent(conn, {
      scope: req.influencerContext ? `influencer:${req.influencerContext.slug}` : 'public-order',
      key: getIdempotencyKey(req),
      body: req.body,
    });
    if (idempotency.replay) {
      await conn.rollback();
      return res.status(201).json(idempotency.replay);
    }
    await assertBarangayExists(conn, customer.barangayCode);
    const publicPlacedByUserId = await getPublicOrderPlacedByUserId(conn);

    let merchandiseSubtotal = 0;
    let preDiscountSubtotal = 0;
    const resolvedItems = [];

    for (const item of items) {
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw ApiError.badRequest(`Invalid quantity for product ${item.product_id}`);
      }

      const [products] = await executeSoftDeleteAware(
        conn,
        'SELECT id, name, retail_price, partner_price FROM products WHERE id = ? AND is_deleted = 0 AND is_active = 1 LIMIT 1',
        [item.product_id],
        'SELECT id, name, retail_price, partner_price FROM products WHERE id = ? AND is_active = 1 LIMIT 1'
      );
      if (products.length === 0) throw ApiError.badRequest(`Product ${item.product_id} not found`);
      const price = getPublicOrderUnitPrice(products[0]);
      resolvedItems.push({ ...item, quantity, name: products[0].name, unit_price: price });
      merchandiseSubtotal += quantity * price;
      preDiscountSubtotal += quantity * price;
    }

    // Member discount: a valid ACTIVE Nogatu MLM member gets MEMBER_DISCOUNT_PCT
    // off. Verified live against the MLM bridge; falls back to no discount when
    // the bridge isn't configured/reachable, so checkout never breaks.
    const memberUsername = String(req.body.member_username || '').trim();
    let memberDiscountPct = 0;
    if (memberUsername) {
      const member = await lookupMlmMember(memberUsername);
      if (member && String(member.account_status || '').toLowerCase() === 'active') {
        memberDiscountPct = MEMBER_DISCOUNT_PCT;
        merchandiseSubtotal = 0;
        for (const it of resolvedItems) {
          it.unit_price = Math.round(it.unit_price * (1 - memberDiscountPct / 100) * 100) / 100;
          merchandiseSubtotal += it.quantity * it.unit_price;
        }
      }
    }

    const pricingTotals = getPublicOrderPricingTotals(merchandiseSubtotal, { preDiscountSubtotal });
    const totalAmount = pricingTotals.totalDue;

    const fulfillmentRoute = await resolvePublicFulfillmentRoute(conn, resolvedItems, {
      customerLat: custLat,
      customerLng: custLng,
    });
    const partnerId = fulfillmentRoute.partner_id;
    const sourceWarehouseId = fulfillmentRoute.warehouse_id;

    normalizeOrderPaymentMethod(payment_method);
    const codAmount = 0;
    const orderNumber = await generateOrderNum('PUB', 'orders', 'order_number');
    const paymentDeadline = publicPaymentDeadline();
    let bankAccount = await getBankAccountForWarehouseOrDefault(conn, sourceWarehouseId);
    if (req.body.payment_provider) {
      const accounts = await getPublicPaymentAccounts(conn, sourceWarehouseId);
      bankAccount = selectPublicPaymentAccount(accounts, req.body.payment_provider, sourceWarehouseId);
    }
    assertBankAccountAvailable(bankAccount);

    // The old single-text customer_name / customer_address stay NULL: the parts are the only copy.
    let orderResult;
    try {
      [orderResult] = await conn.execute(
        `INSERT INTO orders (order_number, partner_id, placed_by, placed_by_type, source_warehouse_id,
                             customer_first_name, customer_middle_name, customer_last_name, customer_name_suffix,
                             customer_address_line, customer_barangay_code, customer_postal_code,
                             customer_phone, customer_email, customer_lat, customer_lng, cod_amount,
                             total_amount, notes, payment_deadline)
         VALUES (?, ?, ?, 'public', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderNumber, partnerId, publicPlacedByUserId, sourceWarehouseId,
         customer.firstName, customer.middleName, customer.lastName, customer.suffix,
         customer.addressLine, customer.barangayCode, customer.postalCode,
         customer_phone || null, customer_email || null, custLat, custLng, codAmount, totalAmount, notes || null,
         paymentDeadline]
      );
    } catch (err) {
      if (isMissingColumn(err, 'customer_last_name') || isMissingColumn(err, 'customer_barangay_code')) {
        throw ApiError.internal('Database schema is outdated for public orders. Run scripts/addPhLocations.js.');
      }
      throw err;
    }
    const orderId = orderResult.insertId;

    if (req.body.payment_provider) {
      try {
        await conn.execute(
          'UPDATE orders SET payment_provider = ?, payment_account_id = ? WHERE id = ?',
          [String(req.body.payment_provider).toUpperCase(), bankAccount.id, orderId],
        );
      } catch (err) {
        if (!isMissingColumn(err, 'payment_provider') && !isMissingColumn(err, 'payment_account_id')) throw err;
      }
    }

    try {
      await conn.execute(
        `UPDATE orders
         SET merchandise_subtotal = ?, member_discount_amount = ?, shipping_fee = ?, system_fee = ?
         WHERE id = ?`,
        [
          pricingTotals.merchandiseSubtotal,
          pricingTotals.memberDiscountAmount,
          pricingTotals.shippingFee,
          pricingTotals.systemFee,
          orderId,
        ]
      );
    } catch (err) {
      const pricingColumns = ['merchandise_subtotal', 'member_discount_amount', 'shipping_fee', 'system_fee'];
      if (!pricingColumns.some((column) => isMissingColumn(err, column))) throw err;
    }

    if (memberUsername) {
      try {
        await conn.execute(
          'UPDATE orders SET member_username = ?, member_discount_pct = ? WHERE id = ?',
          [memberUsername, memberDiscountPct, orderId]
        );
      } catch (err) {
        if (!isMissingColumn(err, 'member_username') && !isMissingColumn(err, 'member_discount_pct')) throw err;
      }
    }

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

    if (req.influencerContext) {
      await conn.execute(
        `INSERT INTO order_attribution (order_id, channel, slug) VALUES (?, 'influencer', ?)`,
        [orderId, req.influencerContext.slug],
      );
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

    const partnerUsers = await notifyPartnerUsers(
      conn,
      partnerId,
      'public_order_placed',
      `Public Order Placed: #${orderNumber}`,
      `Public storefront order #${orderNumber} is placed and awaiting review.`,
      orderId
    );
    const admins = await notifySuperAdmins(
      conn,
      'public_order_placed',
      `Public Order Placed: #${orderNumber}`,
      `Public storefront order #${orderNumber} is placed and awaiting review.`,
      orderId
    );
    await enqueueOrderNotifications(conn, { orderId, orderNumber, users: [...partnerUsers, ...admins] });

    const responseBody = {
      success: true,
      message: 'Order placed successfully. Complete your bank transfer and upload your payment proof.',
      data: {
        order_number: orderNumber,
        total_amount: totalAmount,
        payment: buildPublicPaymentContext({
          orderNumber,
          totalAmount,
          merchandiseSubtotal: pricingTotals.merchandiseSubtotal,
          memberDiscountAmount: pricingTotals.memberDiscountAmount,
          shippingFee: pricingTotals.shippingFee,
          systemFee: pricingTotals.systemFee,
          bankAccount,
          paymentDeadline: paymentDeadline.toISOString(),
        }),
      },
    };
    await completePublicOrderIntent(conn, idempotency.id, orderId, responseBody);
    await conn.commit();

    res.status(201).json(responseBody);
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
    `SELECT o.id, o.order_number, o.partner_id, o.source_warehouse_id, o.status, o.placed_by_type,
            r.slug AS placed_by_role_slug
     FROM orders o
     LEFT JOIN users u ON u.id = o.placed_by
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE o.id = ? AND o.is_deleted = 0
     LIMIT 1`,
    [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'pending') throw ApiError.badRequest('Only pending orders can be approved');

  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  if (!canApproveOrderFromContext(affiliationContext, orders[0])) {
    throw ApiError.forbidden('You do not have permission to approve this order');
  }

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
    const [approved] = await conn.execute(
      // A public order already carries its deadline from checkout (the buyer was shown it); approving
      // must not shorten it. Stockist orders get theirs here. The status condition makes a double
      // click, or two people approving at once, a single approval.
      `UPDATE orders SET status = 'approved', approved_by = ?, approved_at = NOW(),
                         payment_deadline = COALESCE(payment_deadline, ?)
       WHERE id = ? AND status = 'pending' AND is_deleted = 0`,
      [req.user.id, deadline, orderId]
    );
    if (approved.affectedRows !== 1) {
      throw ApiError.conflict('This order was already handled. Refresh to see its current status.');
    }

    // The Stockist who placed an order is told to pay. A public order's partner is the center
    // that just approved it, so there is no one to notify (the buyer sees it on the tracking page).
    const partnerUsers = orders[0].placed_by_type === 'public' ? [] : await notifyPartnerUsers(
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

  const [orders] = await pool.execute(
    `SELECT o.id, o.order_number, o.partner_id, o.source_warehouse_id, o.status, o.placed_by_type,
            r.slug AS placed_by_role_slug
     FROM orders o
     LEFT JOIN users u ON u.id = o.placed_by
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE o.id = ? AND o.is_deleted = 0
     LIMIT 1`,
    [orderId]
  );
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  if (orders[0].status !== 'pending') throw ApiError.badRequest('Only pending orders can be rejected');

  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  if (!canApproveOrderFromContext(affiliationContext, orders[0])) {
    throw ApiError.forbidden('You do not have permission to reject this order');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rejected] = await conn.execute(
      `UPDATE orders SET status = 'rejected', cancellation_reason = ?, cancelled_by = ?, updated_at = NOW()
       WHERE id = ? AND status = 'pending' AND is_deleted = 0`,
      [reason || null, req.user.id, orderId]
    );
    // Only the request that actually moved the order releases its stock; a duplicate releases nothing.
    if (rejected.affectedRows !== 1) {
      throw ApiError.conflict('This order was already handled. Refresh to see its current status.');
    }

    // Release reserved stock
    const items = await getOrderItemsWithOptionalSourceColumn(conn, orderId);
    let fallbackWarehouseId = orders[0].source_warehouse_id || null;
    if (!fallbackWarehouseId) {
      fallbackWarehouseId = await resolveSourceWarehouseIdForPartner(conn, orders[0].partner_id);
    }
    for (const item of items) {
      const wid = item.source_warehouse_id || fallbackWarehouseId;
      if (wid) {
        await releaseStock(conn, { productId: item.product_id, warehouseId: wid, quantity: item.quantity });
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

  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  const scope = buildOrderScope(req.user, { orderAlias: '', affiliationContext });
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
        await releaseStock(conn, { productId: item.product_id, warehouseId: wid, quantity: item.quantity });
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

  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  const scope = buildOrderScope(req.user, { orderAlias: '', affiliationContext });
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

const uploadPublicPaymentProof = asyncHandler(async (req, res) => {
  const { order_number, customer_phone } = req.body;

  if (!order_number || !customer_phone) {
    throw ApiError.badRequest('order_number and customer_phone are required');
  }
  if (!req.file) {
    throw ApiError.badRequest('Payment proof file is required');
  }

  const normalizedOrderNumber = String(order_number).trim().toUpperCase();
  const [orders] = await pool.execute(
    `SELECT o.id, o.order_number, o.partner_id, o.status, o.payment_status, o.payment_proof_url,
            ${orderCustomerNameSql('o')} AS customer_name, o.customer_phone
     FROM orders o
     WHERE o.order_number = ?
       AND o.placed_by_type = 'public'
       AND o.is_deleted = 0
     LIMIT 1`,
    [normalizedOrderNumber]
  );

  if (orders.length === 0) throw ApiError.notFound('Public order not found for this order number');

  if (!phonesMatch(customer_phone, orders[0].customer_phone)) {
    throw ApiError.badRequest('The phone number does not match the public order record');
  }
  if (['cancelled', 'rejected'].includes(String(orders[0].status || '').toLowerCase())) {
    throw ApiError.badRequest('This order is closed and can no longer accept payment proof');
  }
  if (orders[0].payment_status === 'paid') {
    throw ApiError.badRequest('Payment has already been verified for this order');
  }
  if (orders[0].payment_proof_url) {
    throw ApiError.conflict('Payment proof has already been uploaded for this order');
  }

  const proofUrl = req.file.path;
  const orderId = orders[0].id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [proofUpdate] = await conn.execute(
      `UPDATE orders SET payment_proof_url = ?, payment_proof_uploaded_at = NOW() WHERE id = ? AND payment_proof_url IS NULL`,
      [proofUrl, orderId]
    );
    if (proofUpdate.affectedRows !== 1) throw ApiError.conflict('Payment proof has already been uploaded for this order');

    const admins = await notifySuperAdmins(
      conn, 'payment_proof_uploaded',
      `Payment Proof: #${orders[0].order_number}`,
      `Payment proof uploaded for public order #${orders[0].order_number}. Please verify.`,
      orderId
    );
    await conn.commit();

    for (const admin of admins) {
      const tmpl = EMAIL.paymentProofUploaded(orders[0].order_number, orders[0].customer_name || 'Public customer');
      await sendEmail({ to: admin.email, toName: admin.name, ...tmpl });
    }

    res.json({
      success: true,
      message: 'Payment proof uploaded. We will verify your payment shortly.',
      data: { payment_proof_url: proofUrl },
    });
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

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [orders] = await conn.execute(
      `SELECT o.id, o.order_number, o.partner_id, o.status, o.payment_status,
              o.payment_proof_url, o.total_amount, o.placed_by_type, r.slug AS placed_by_role_slug
       FROM orders o
       LEFT JOIN users u ON u.id = o.placed_by
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE o.id = ? AND o.is_deleted = 0
       FOR UPDATE`,
      [orderId]
    );
    if (orders.length === 0) throw ApiError.notFound('Order not found');

    const affiliationContext = await resolveAffiliationContext(conn, req.user);
    if (req.user.role_slug !== 'super_admin' && !canVerifyPaymentFromContext(affiliationContext, orders[0])) {
      throw ApiError.forbidden('You do not have permission to verify payment for this order');
    }

    const decision = getPaymentVerificationDecision(orders[0]);
    if (decision.alreadyPaid) {
      await conn.commit();
      return res.json({ success: true, message: 'Payment already verified', data: { already_paid: true } });
    }

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
  uploadPublicPaymentProof,
  approveOrder,
  rejectOrder,
  cancelOrder,
  uploadPaymentProof,
  verifyPayment,
  archiveOrder,
  unarchiveOrder,
  __testables: {
    buildOrderScope,
    getPublicOrderPlacedByUserId,
    getPublicOrderUnitPrice,
    normalizeOrderPaymentMethod,
    rankPublicFulfillmentCandidates,
    resolvePublicFulfillmentRoute,
    reconcilePublicOrderPricing,
    buildOrderPricingBreakdown,
  },
};
