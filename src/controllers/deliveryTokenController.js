const crypto = require('crypto');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendEmail, EMAIL } = require('../services/emailService');
const env = require('../config/env');
const { insertStockMovement } = require('../utils/stockMovementLogger');
const { insertNotification } = require('../utils/notificationWriter');
const { consumeReservedStock } = require('../services/batchStock');
const { orderCustomerJoins, orderCustomerNameSql, orderCustomerAddressSql } = require('../utils/orderCustomerSql');
const { buildOrderRoute, UNSCOPED } = require('../services/orderRouteService');
const {
  resolveAffiliationContext,
  buildOrderScopeFromContext,
  canManageDeliveryLinkFromContext,
} = require('../rbac/affiliationScopes');

/**
 * Resolve the frontend base URL dynamically.
 * Priority order:
 *   1. request Origin header (e.g. https://nogatu.store)
 *   2. scheme + host derived from Referer header
 *   3. env.PUBLIC_BASE_URL when it is a real, non-placeholder value
 *   4. scheme + host inferred from the Express request object
 *
 * A "placeholder" value is anything containing "your-production-domain" or
 * "example.com" (case-insensitive).
 */
function resolveFrontendBaseUrl(req) {
  const placeholderPattern = /your-production-domain|example\.com/i;

  const stripTrailingSlash = (url) => String(url || '').replace(/\/+$/, '');

  // 1. Configured public base URL is AUTHORITATIVE. This forces the customer-facing
  //    delivery link to the public storefront domain (https://nogatu.store in prod,
  //    http://localhost:5173 in dev) so it never inherits a different admin domain
  //    such as a .com. Set via PUBLIC_BASE_URL in .env.prod / .env.dev.
  const envUrl = String(env.PUBLIC_BASE_URL || '').trim();
  if (envUrl && !placeholderPattern.test(envUrl)) {
    return stripTrailingSlash(envUrl);
  }

  // 2. Origin header (only used when no real PUBLIC_BASE_URL is configured)
  const origin = req.get('Origin');
  if (origin && origin.startsWith('http')) {
    return stripTrailingSlash(origin);
  }

  // 3. Referer header — extract scheme + host only
  const referer = req.get('Referer');
  if (referer && referer.startsWith('http')) {
    try {
      const url = new URL(referer);
      return stripTrailingSlash(`${url.protocol}//${url.host}`);
    } catch {
      // malformed Referer — fall through
    }
  }

  // 4. Derive from the Express request itself
  return stripTrailingSlash(`${req.protocol}://${req.get('host')}`);
}

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

async function getLatestActiveToken(orderId, db = pool) {
  const [rows] = await db.execute(
    `SELECT id, token, expires_at, is_used, created_at
     FROM delivery_tokens
     WHERE order_id = ? AND is_used = 0 AND expires_at > NOW()
     ORDER BY id DESC LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

function assertCanAccessOrder(affiliationContext, order) {
  const scope = buildOrderScopeFromContext(affiliationContext, { orderAlias: '' });
  if (!scope.clause) {
    return;
  }

  if (scope.clause === ' AND 1 = 0') {
    throw ApiError.forbidden('You do not have permission to access this order');
  }

  // Simple in-memory mirror of the order visibility rules for single-record checks.
  const role = affiliationContext?.role;
  const partnerId = Number(affiliationContext?.partnerId || 0) || null;
  const partnerLevel = affiliationContext?.partnerLevel;
  const childCityPartnerIds = Array.isArray(affiliationContext?.childCityPartnerIds)
    ? affiliationContext.childCityPartnerIds.map(Number)
    : [];

  if (role === 'mobile_stockist') {
    if (Number(order.placed_by) !== Number(affiliationContext?.userId || 0)) {
      throw ApiError.forbidden('You do not have permission to access this order');
    }
    return;
  }

  if (partnerLevel === 'city_stockist') {
    if (Number(order.partner_id) !== partnerId) {
      throw ApiError.forbidden('You do not have permission to access this order');
    }
    return;
  }

  if (partnerLevel === 'provincial_stockist') {
    if (Number(order.partner_id) === partnerId) {
      return;
    }
    if (
      childCityPartnerIds.includes(Number(order.partner_id))
      && ['city_stockist', 'staff'].includes(String(order.placed_by_role_slug || ''))
    ) {
      return;
    }
  }

  if (partnerLevel === 'center' && Number(order.partner_id) === partnerId) {
    return;
  }

  throw ApiError.forbidden('You do not have permission to access this order');
}

function canAccessDeliveryProof(affiliationContext, ownership) {
  try {
    assertCanAccessOrder(affiliationContext, ownership);
    return true;
  } catch {
    return false;
  }
}

function assertCanManageDeliveryLink(affiliationContext, order) {
  if (affiliationContext?.role === 'super_admin') {
    return;
  }

  if (!canManageDeliveryLinkFromContext(affiliationContext, order)) {
    throw ApiError.forbidden('You do not have permission to create or view the Rider Link for this order');
  }
}

function buildDeliveryProofScope(affiliationContext, {
  orderAlias = 'o',
} = {}) {
  return buildOrderScopeFromContext(affiliationContext, { orderAlias });
}

async function getDeliveryProofOwnership(orderId) {
  let rows;

  try {
    [rows] = await pool.execute(
      `SELECT o.id, o.partner_id, o.placed_by, r.slug AS placed_by_role_slug
       FROM orders o
       LEFT JOIN users u ON u.id = o.placed_by
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE o.id = ? AND o.is_deleted = 0
       LIMIT 1`,
      [orderId]
    );
  } catch (err) {
    if (!isMissingColumn(err, 'partner_id')) {
      throw err;
    }

    [rows] = await pool.execute(
      `SELECT o.id, o.partner_id, o.placed_by, NULL AS placed_by_role_slug
       FROM orders o
       WHERE o.id = ? AND o.is_deleted = 0
       LIMIT 1`,
      [orderId]
    );
  }

  return rows[0] || null;
}

/**
 * Creates or updates the order's delivery_tracking row. A vehicle or courier left out keeps the
 * stored value, so regenerating a link without picking again does not reset it.
 */
async function upsertTracking(conn, orderId, { courier_id, courier_tracking_number, vehicle_type, setOutForDelivery }) {
  const [trackingRows] = await conn.execute('SELECT id FROM delivery_tracking WHERE order_id = ? LIMIT 1', [orderId]);
  if (trackingRows.length === 0) {
    await conn.execute(
      `INSERT INTO delivery_tracking (order_id, status, courier_id, courier_tracking_number, vehicle_type)
       VALUES (?, 'out_for_delivery', ?, ?, ?)`,
      [orderId, courier_id || null, courier_tracking_number || null, vehicle_type || 'motorcycle']
    );
    return;
  }
  await conn.execute(
    `UPDATE delivery_tracking
     SET status = IF(?, 'out_for_delivery', status),
         courier_id = COALESCE(?, courier_id),
         courier_tracking_number = COALESCE(?, courier_tracking_number),
         vehicle_type = COALESCE(?, vehicle_type),
         updated_at = NOW()
     WHERE order_id = ?`,
    [setOutForDelivery ? 1 : 0, courier_id || null, courier_tracking_number || null, vehicle_type || null, orderId]
  );
}

// POST /api/v1/delivery-tokens — create the Rider Link for an order (body validated in routes)
const generateDeliveryLink = asyncHandler(async (req, res) => {
  const { order_id, courier_id, courier_tracking_number, vehicle_type } = req.body;
  if (!order_id) throw ApiError.badRequest('order_id is required');

  let orders;
  try {
    [orders] = await pool.execute(
      `SELECT o.id, o.order_number, o.partner_id, o.placed_by, o.placed_by_type, o.payment_status, o.status,
              r.slug AS placed_by_role_slug
       FROM orders o
       LEFT JOIN users u ON u.id = o.placed_by
       LEFT JOIN roles r ON r.id = u.role_id
       WHERE o.id = ? AND o.is_deleted = 0 LIMIT 1`,
      [order_id]
    );
  } catch (err) {
    throw err;
  }
  if (orders.length === 0) throw ApiError.notFound('Order not found');
  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  assertCanAccessOrder(affiliationContext, orders[0]);
  assertCanManageDeliveryLink(affiliationContext, orders[0]);
  if (orders[0].payment_status !== 'paid') {
    throw ApiError.badRequest('Payment must be verified before creating the Rider Link');
  }
  if (['delivered', 'cancelled', 'rejected'].includes(orders[0].status)) {
    throw ApiError.badRequest('This order is closed, so it cannot get a Rider Link');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock the order so two clicks (or two staff) cannot each create a link; the loser finds the
    // winner's link below and returns it instead.
    await conn.execute('SELECT id FROM orders WHERE id = ? FOR UPDATE', [order_id]);

    const existingToken = await getLatestActiveToken(order_id, conn);
    if (existingToken) {
      await upsertTracking(conn, order_id, { courier_id, courier_tracking_number, vehicle_type, setOutForDelivery: false });
      await conn.commit();
      return res.status(200).json({
        success: true,
        message: 'This order already has an active Rider Link',
        data: {
          token: existingToken.token,
          magic_link: `${resolveFrontendBaseUrl(req)}/deliver/${existingToken.token}`,
          expires_at: existingToken.expires_at,
          vehicle_type: vehicle_type || null,
        },
      });
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h

    await conn.execute(
      `INSERT INTO delivery_tokens (order_id, token, expires_at, created_by) VALUES (?, ?, ?, ?)`,
      [order_id, token, expiresAt, req.user.id]
    );

    await upsertTracking(conn, order_id, { courier_id, courier_tracking_number, vehicle_type, setOutForDelivery: true });

    // Update order status to 'delivering'
    await conn.execute(`UPDATE orders SET status = 'delivering' WHERE id = ?`, [order_id]);

    await conn.commit();

    const magicLink = `${resolveFrontendBaseUrl(req)}/deliver/${token}`;

    // Tell the Stockist who ordered that it is on its way. A store order's partner is the center
    // that just created this link, so there is nobody to tell.
    const [partnerUsers] = orders[0].placed_by_type === 'public' ? [[]] : await pool.execute(
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
      message: 'Rider Link created',
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
    `SELECT o.id, o.partner_id, o.placed_by, o.placed_by_type, r.slug AS placed_by_role_slug
     FROM orders o
     LEFT JOIN users u ON u.id = o.placed_by
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE o.id = ? AND o.is_deleted = 0 LIMIT 1`,
    [orderId]
  );

  if (orders.length === 0) throw ApiError.notFound('Order not found');
  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  assertCanAccessOrder(affiliationContext, orders[0]);
  assertCanManageDeliveryLink(affiliationContext, orders[0]);

  const token = await getLatestActiveToken(orderId);
  if (!token) {
    return res.json({ success: true, data: null });
  }

  const magicLink = `${resolveFrontendBaseUrl(req)}/deliver/${token.token}`;
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
  const affiliationContext = await resolveAffiliationContext(pool, req.user);

  if (!ownership) {
    throw ApiError.notFound('Order not found');
  }

  if (!canAccessDeliveryProof(affiliationContext, ownership)) {
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
              ${orderCustomerNameSql('o')} AS customer_name,
              ${orderCustomerAddressSql('o')} AS customer_address,
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
       ${orderCustomerJoins('o')}
       LEFT JOIN partners pt ON pt.id = o.partner_id
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
              ${orderCustomerNameSql('o')} AS customer_name,
              ${orderCustomerAddressSql('o')} AS customer_address,
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
       ${orderCustomerJoins('o')}
       LEFT JOIN partners pt ON pt.id = o.partner_id
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
  const affiliationContext = await resolveAffiliationContext(pool, req.user);
  const scope = buildDeliveryProofScope(affiliationContext);
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
       LEFT JOIN partners pt ON pt.id = o.partner_id
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
       LEFT JOIN partners pt ON pt.id = o.partner_id
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

  let tokens;
  try {
    [tokens] = await pool.execute(
      `SELECT dt.*, o.order_number, ${orderCustomerNameSql('o')} AS customer_name,
              ${orderCustomerAddressSql('o')} AS customer_address, o.customer_phone,
              o.customer_lat, o.customer_lng,
              o.total_amount, o.partner_id, o.status AS order_status, o.source_warehouse_id
       FROM delivery_tokens dt
       JOIN orders o ON o.id = dt.order_id
       ${orderCustomerJoins('o')}
       WHERE dt.token = ? AND dt.is_used = 0 AND dt.expires_at > NOW()
       LIMIT 1`,
      [token]
    );
  } catch (err) {
    // source_warehouse_id may not exist in older migrations
    if (!isMissingColumn(err, 'source_warehouse_id')) throw err;
    [tokens] = await pool.execute(
      `SELECT dt.*, o.order_number, ${orderCustomerNameSql('o')} AS customer_name,
              ${orderCustomerAddressSql('o')} AS customer_address, o.customer_phone,
              NULL AS customer_lat, NULL AS customer_lng,
              o.total_amount, o.partner_id, o.status AS order_status, NULL AS source_warehouse_id
       FROM delivery_tokens dt
       JOIN orders o ON o.id = dt.order_id
       ${orderCustomerJoins('o')}
       WHERE dt.token = ? AND dt.is_used = 0 AND dt.expires_at > NOW()
       LIMIT 1`,
      [token]
    );
  }

  if (tokens.length === 0) throw ApiError.notFound('This Rider Link is invalid, expired, or already used');

  const info = tokens[0];
  const [items] = await pool.execute(
    `SELECT p.name AS product_name, oi.quantity, oi.unit_price
     FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ?`,
    [info.order_id]
  );

  // Fetch source warehouse coordinates (origin point for the map)
  let sourceWarehouse = null;
  if (info.source_warehouse_id) {
    try {
      const [whRows] = await pool.execute(
        `SELECT id, name, location, lat, lng FROM warehouses WHERE id = ? LIMIT 1`,
        [info.source_warehouse_id]
      );
      if (whRows.length > 0) {
        const wh = whRows[0];
        sourceWarehouse = {
          id: wh.id,
          name: wh.name || null,
          location: wh.location || null,
          lat: wh.lat != null ? Number(wh.lat) : null,
          lng: wh.lng != null ? Number(wh.lng) : null,
        };
      }
    } catch {
      // Warehouse lookup is best-effort; missing coords are handled by the frontend
    }
  }

  // Fetch the latest GPS ping for this order (from delivery_tracking → gps_pings)
  let latestGps = null;
  try {
    const [gpsRows] = await pool.execute(
      `SELECT gp.lat AS latitude, gp.lng AS longitude, gp.speed_kmh, gp.accuracy_meters, gp.pinged_at
       FROM gps_pings gp
       JOIN delivery_tracking dt ON dt.id = gp.tracking_id
       WHERE dt.order_id = ?
       ORDER BY gp.pinged_at DESC
       LIMIT 1`,
      [info.order_id]
    );
    if (gpsRows.length > 0) {
      const g = gpsRows[0];
      latestGps = {
        latitude: g.latitude != null ? Number(g.latitude) : null,
        longitude: g.longitude != null ? Number(g.longitude) : null,
        speed_kmh: g.speed_kmh != null ? Number(g.speed_kmh) : null,
        accuracy_meters: g.accuracy_meters != null ? Number(g.accuracy_meters) : null,
        pinged_at: g.pinged_at || null,
      };
    }
  } catch {
    // GPS data is best-effort; the delivery flow must work without it
  }

  // The rider's map: road route from where they are (or the center) to the door, and an arrival
  // window. The token already authorized this order; routing trouble only costs the map.
  let route = null;
  try {
    route = await buildOrderRoute(info.order_id, UNSCOPED);
  } catch {
    route = null;
  }

  res.json({
    success: true,
    data: {
      route,
      order_number: info.order_number,
      customer_name: info.customer_name,
      customer_address: info.customer_address,
      customer_phone: info.customer_phone,
      total_amount: info.total_amount,
      items,
      source_warehouse: sourceWarehouse,
      // Destination = the buyer's pinned coordinates (if they consented) so the
      // rider map can draw the main-warehouse -> destination route. Only exposed
      // here (token-authenticated rider view), never on public tracking.
      destination: {
        lat: info.customer_lat != null ? Number(info.customer_lat) : null,
        lng: info.customer_lng != null ? Number(info.customer_lng) : null,
        address: info.customer_address || null,
      },
      latest_gps: latestGps,
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
  if (tokens.length === 0) throw ApiError.notFound('This Rider Link is invalid, expired, or already used');

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
        const delivered = await consumeReservedStock(conn, {
          productId: item.product_id, warehouseId: wid, quantity: item.quantity,
        });
        if (!delivered) {
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
