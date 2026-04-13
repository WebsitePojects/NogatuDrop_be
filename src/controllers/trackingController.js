const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

async function getLatestPingByTrackingId(trackingId) {
  const [pings] = await pool.execute(
    `SELECT id,
            lat AS latitude,
            lng AS longitude,
            speed_kmh,
            accuracy_meters,
            pinged_at
     FROM gps_pings
     WHERE tracking_id = ?
     ORDER BY pinged_at DESC
     LIMIT 1`,
    [trackingId]
  );

  return pings[0] || null;
}

function normalizePublicStatus(orderStatus, trackingStatus) {
  if (orderStatus === 'delivered') return 'delivered';
  if (orderStatus === 'delivering' || trackingStatus === 'out_for_delivery') return 'delivering';
  if (orderStatus === 'approved') return 'approved';
  if (orderStatus === 'pending') return 'pending';
  if (orderStatus === 'cancelled') return 'cancelled';
  if (orderStatus === 'rejected') return 'rejected';
  return orderStatus || trackingStatus || 'pending';
}

// GET /api/v1/tracking/:orderId
const getTracking = asyncHandler(async (req, res) => {
  const orderId = req.params.orderId;

  const [rows] = await pool.execute(
    `SELECT dt.id, dt.order_id, dt.transfer_id, dt.rider_user_id, dt.status,
            dt.rider_name, dt.courier_id, dt.courier_tracking_number,
            c.name AS courier_name,
            dt.est_delivery_at, dt.delivered_at, dt.created_at, dt.updated_at,
            o.order_number, o.status AS order_status
     FROM delivery_tracking dt
     JOIN orders o ON o.id = dt.order_id
     LEFT JOIN couriers c ON c.id = dt.courier_id
     WHERE dt.order_id = ? LIMIT 1`,
    [orderId]
  );

  if (rows.length === 0) throw ApiError.notFound('Tracking info not found');

  const tracking = rows[0];
  tracking.latest_ping = await getLatestPingByTrackingId(tracking.id);

  res.json({ success: true, data: tracking });
});

// GET /api/v1/tracking/public/:orderNumber
const getPublicTracking = asyncHandler(async (req, res) => {
  const { orderNumber } = req.params;

  const [rows] = await pool.execute(
    `SELECT o.status AS order_status,
            dt.id AS tracking_id, dt.status AS tracking_status,
            dt.est_delivery_at,
            c.name AS courier_name
     FROM orders o
     LEFT JOIN delivery_tracking dt ON dt.order_id = o.id
     LEFT JOIN couriers c ON c.id = dt.courier_id
     WHERE o.order_number = ? AND o.is_deleted = 0
     LIMIT 1`,
    [orderNumber]
  );

  if (rows.length === 0) throw ApiError.notFound('Tracking info not found');

  const row = rows[0];
  const latestPing = row.tracking_id ? await getLatestPingByTrackingId(row.tracking_id) : null;
  const gps = latestPing
    ? {
        latitude: latestPing.latitude,
        longitude: latestPing.longitude,
        speed_kmh: latestPing.speed_kmh,
        accuracy_meters: latestPing.accuracy_meters,
        pinged_at: latestPing.pinged_at,
      }
    : null;

  res.json({
    success: true,
    data: {
      status: normalizePublicStatus(row.order_status, row.tracking_status),
      courier: row.courier_name || null,
      gps,
      eta: row.est_delivery_at || null,
    },
  });
});

// GET /api/v1/tracking/:orderId/pings
const getOrderPings = asyncHandler(async (req, res) => {
  const { orderId } = req.params;

  const [rows] = await pool.execute(
    `SELECT gp.id,
            gp.lat AS latitude,
            gp.lng AS longitude,
            gp.speed_kmh,
            gp.accuracy_meters,
            gp.pinged_at
     FROM gps_pings gp
     JOIN delivery_tracking dt ON dt.id = gp.tracking_id
     JOIN orders o ON o.id = dt.order_id
     WHERE dt.order_id = ? AND o.is_deleted = 0
     ORDER BY gp.pinged_at ASC
     LIMIT 200`,
    [orderId]
  );

  res.json({ success: true, data: rows });
});

// GET /api/v1/tracking/active
const getActiveTracking = asyncHandler(async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT dt.id AS tracking_id,
            dt.order_id,
            o.order_number,
            dt.status,
            dt.courier_tracking_number,
            c.name AS courier_name,
            dt.updated_at,
            lp.lat AS latitude,
            lp.lng AS longitude,
            lp.pinged_at AS last_pinged_at
     FROM delivery_tracking dt
     JOIN orders o ON o.id = dt.order_id
     LEFT JOIN couriers c ON c.id = dt.courier_id
     LEFT JOIN (
       SELECT gp1.tracking_id, gp1.lat, gp1.lng, gp1.pinged_at
       FROM gps_pings gp1
       JOIN (
         SELECT tracking_id, MAX(pinged_at) AS max_ping
         FROM gps_pings
         GROUP BY tracking_id
       ) latest
         ON latest.tracking_id = gp1.tracking_id
        AND latest.max_ping = gp1.pinged_at
     ) lp ON lp.tracking_id = dt.id
     WHERE o.is_deleted = 0
       AND (o.status = 'delivering' OR dt.status IN ('in_progress', 'out_for_delivery'))
     ORDER BY dt.updated_at DESC
     LIMIT 100`
  );

  res.json({ success: true, data: rows });
});

// POST /api/v1/tracking/ping/:token
const postPingByToken = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { lat, lng, speed_kmh, accuracy_meters } = req.body;

  let tokens;
  try {
    [tokens] = await pool.execute(
      `SELECT dt.id AS token_id, dt.order_id,
              o.status AS order_status,
              o.payment_status
       FROM delivery_tokens dt
       JOIN orders o ON o.id = dt.order_id
       WHERE dt.token = ? AND dt.is_used = 0 AND dt.expires_at > NOW()
       LIMIT 1`,
      [token]
    );
  } catch (err) {
    if (!isMissingColumn(err, 'payment_status')) {
      throw err;
    }

    [tokens] = await pool.execute(
      `SELECT dt.id AS token_id, dt.order_id,
              o.status AS order_status,
              NULL AS payment_status
       FROM delivery_tokens dt
       JOIN orders o ON o.id = dt.order_id
       WHERE dt.token = ? AND dt.is_used = 0 AND dt.expires_at > NOW()
       LIMIT 1`,
      [token]
    );
  }

  if (tokens.length === 0) {
    throw ApiError.notFound('Delivery link is invalid, expired, or already used');
  }

  const tokenInfo = tokens[0];
  const orderId = tokenInfo.order_id;

  if (['cancelled', 'rejected', 'delivered'].includes(tokenInfo.order_status)) {
    throw ApiError.badRequest('Order is no longer eligible for delivery tracking');
  }

  if (!['approved', 'delivering'].includes(tokenInfo.order_status)) {
    throw ApiError.badRequest('Order is not ready for delivery tracking');
  }

  if (tokenInfo.order_status === 'approved' && tokenInfo.payment_status && tokenInfo.payment_status !== 'paid') {
    throw ApiError.badRequest('Order payment is not yet verified');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let orderUpdate;
    try {
      [orderUpdate] = await conn.execute(
        `UPDATE orders
         SET status = 'delivering', updated_at = NOW()
         WHERE id = ?
           AND (
             status = 'delivering'
             OR (status = 'approved' AND payment_status = 'paid')
           )`,
        [orderId]
      );
    } catch (err) {
      if (!isMissingColumn(err, 'payment_status')) {
        throw err;
      }

      [orderUpdate] = await conn.execute(
        `UPDATE orders
         SET status = 'delivering', updated_at = NOW()
         WHERE id = ? AND status IN ('approved', 'delivering')`,
        [orderId]
      );
    }

    if (orderUpdate.affectedRows === 0) {
      throw ApiError.badRequest('Order is not ready for delivery tracking');
    }

    let [trackingRows] = await conn.execute(
      `SELECT id FROM delivery_tracking WHERE order_id = ? LIMIT 1`,
      [orderId]
    );

    let trackingId;
    if (trackingRows.length === 0) {
      const [created] = await conn.execute(
        `INSERT INTO delivery_tracking (order_id, status)
         VALUES (?, 'out_for_delivery')`,
        [orderId]
      );
      trackingId = created.insertId;
    } else {
      trackingId = trackingRows[0].id;
      await conn.execute(
        `UPDATE delivery_tracking SET status = 'out_for_delivery', updated_at = NOW() WHERE id = ?`,
        [trackingId]
      );
    }

    await conn.execute(
      `INSERT INTO gps_pings (tracking_id, lat, lng, speed_kmh, accuracy_meters)
       VALUES (?, ?, ?, ?, ?)`,
      [trackingId, lat, lng, speed_kmh || null, accuracy_meters || null]
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  res.status(201).json({ success: true, message: 'GPS ping recorded' });
});

// POST /api/v1/tracking/ping
const postPing = asyncHandler(async (req, res) => {
  const { tracking_id, lat, lng, speed_kmh, accuracy_meters } = req.body;
  const trackingId = tracking_id || req.params.trackingId;

  if (!trackingId) {
    throw ApiError.badRequest('Tracking ID is required');
  }

  const [tracking] = await pool.execute(
    'SELECT id FROM delivery_tracking WHERE id = ?', [trackingId]
  );
  if (tracking.length === 0) throw ApiError.notFound('Tracking record not found');

  await pool.execute(
    'INSERT INTO gps_pings (tracking_id, lat, lng, speed_kmh, accuracy_meters) VALUES (?, ?, ?, ?, ?)',
    [trackingId, lat, lng, speed_kmh || null, accuracy_meters || null]
  );

  res.status(201).json({ success: true, message: 'GPS ping recorded' });
});

// PATCH /api/v1/tracking/:trackingId/status
const updateTrackingStatus = asyncHandler(async (req, res) => {
  const { status, rider_name, rider_user_id, est_delivery_at } = req.body;
  const trackingId = req.params.trackingId;

  const [existing] = await pool.execute(
    'SELECT id, order_id FROM delivery_tracking WHERE id = ?', [trackingId]
  );
  if (existing.length === 0) throw ApiError.notFound('Tracking record not found');

  const fields = [];
  const values = [];

  if (status) { fields.push('status = ?'); values.push(status); }
  if (rider_name) { fields.push('rider_name = ?'); values.push(rider_name); }
  if (rider_user_id !== undefined) { fields.push('rider_user_id = ?'); values.push(rider_user_id || null); }
  if (est_delivery_at) { fields.push('est_delivery_at = ?'); values.push(est_delivery_at); }

  if (status === 'delivered') {
    fields.push('delivered_at = NOW()');
  }

  if (fields.length === 0) throw ApiError.badRequest('No fields to update');

  values.push(trackingId);
  await pool.execute(`UPDATE delivery_tracking SET ${fields.join(', ')} WHERE id = ?`, values);

  // If delivered, update order status too
  if (status === 'delivered') {
    await pool.execute(
      'UPDATE orders SET status = ?, delivered_at = NOW() WHERE id = ?',
      ['delivered', existing[0].order_id]
    );
  } else if (status === 'out_for_delivery') {
    await pool.execute(
      'UPDATE orders SET status = ? WHERE id = ?',
      ['delivering', existing[0].order_id]
    );
  }

  const [updated] = await pool.execute('SELECT * FROM delivery_tracking WHERE id = ?', [trackingId]);
  res.json({ success: true, message: 'Tracking status updated', data: updated[0] });
});

// POST /api/v1/tracking (create tracking record)
const createTracking = asyncHandler(async (req, res) => {
  const { order_id, transfer_id, rider_user_id, rider_name, est_delivery_at } = req.body;

  // Verify order exists
  const [order] = await pool.execute(
    'SELECT id FROM orders WHERE id = ? AND is_deleted = 0', [order_id]
  );
  if (order.length === 0) throw ApiError.notFound('Order not found');

  // Check if tracking already exists
  const [existing] = await pool.execute(
    'SELECT id FROM delivery_tracking WHERE order_id = ?', [order_id]
  );
  if (existing.length > 0) throw ApiError.conflict('Tracking record already exists for this order');

  const [result] = await pool.execute(
    `INSERT INTO delivery_tracking (order_id, transfer_id, rider_user_id, rider_name, est_delivery_at)
     VALUES (?, ?, ?, ?, ?)`,
    [order_id, transfer_id || null, rider_user_id || null, rider_name || null, est_delivery_at || null]
  );

  // Update order to delivering status
  await pool.execute('UPDATE orders SET status = ? WHERE id = ? AND status = ?', ['delivering', order_id, 'approved']);

  const [created] = await pool.execute('SELECT * FROM delivery_tracking WHERE id = ?', [result.insertId]);
  res.status(201).json({ success: true, message: 'Tracking record created', data: created[0] });
});

module.exports = {
  getTracking,
  getPublicTracking,
  getOrderPings,
  getActiveTracking,
  postPingByToken,
  postPing,
  updateTrackingStatus,
  createTracking,
};
