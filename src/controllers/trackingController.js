const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');

// GET /api/v1/tracking/:orderId
const getTracking = asyncHandler(async (req, res) => {
  const orderId = req.params.orderId;

  const [rows] = await pool.execute(
    `SELECT dt.id, dt.order_id, dt.transfer_id, dt.rider_user_id, dt.status,
            dt.rider_name, dt.est_delivery_at, dt.delivered_at, dt.created_at, dt.updated_at,
            o.order_number, o.status AS order_status
     FROM delivery_tracking dt
     JOIN orders o ON o.id = dt.order_id
     WHERE dt.order_id = ? LIMIT 1`,
    [orderId]
  );

  if (rows.length === 0) throw ApiError.notFound('Tracking info not found');

  const tracking = rows[0];

  // Get latest GPS ping
  const [pings] = await pool.execute(
    `SELECT id, lat, lng, pinged_at
     FROM gps_pings
     WHERE tracking_id = ?
     ORDER BY pinged_at DESC LIMIT 1`,
    [tracking.id]
  );

  tracking.latest_ping = pings.length > 0 ? pings[0] : null;

  res.json({ success: true, data: tracking });
});

// POST /api/v1/tracking/ping
const postPing = asyncHandler(async (req, res) => {
  const { tracking_id, lat, lng } = req.body;
  const trackingId = tracking_id || req.params.trackingId;

  if (!trackingId) {
    throw ApiError.badRequest('Tracking ID is required');
  }

  const [tracking] = await pool.execute(
    'SELECT id FROM delivery_tracking WHERE id = ?', [trackingId]
  );
  if (tracking.length === 0) throw ApiError.notFound('Tracking record not found');

  await pool.execute(
    'INSERT INTO gps_pings (tracking_id, lat, lng) VALUES (?, ?, ?)',
    [trackingId, lat, lng]
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

module.exports = { getTracking, postPing, updateTrackingStatus, createTracking };
