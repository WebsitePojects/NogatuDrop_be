// Builds what the delivery map draws for one order. Used by the staff/admin route endpoint
// (GET /tracking/:orderId/route, scoped), by public tracking (arrival window only) and by the rider's
// page (Rider Link, authorized by its token). Callers decide who may see it; this only assembles it.
const pool = require('../config/db');
const ApiError = require('../utils/ApiError');
const { orderIsPublicSql } = require('../utils/orderCustomerSql');
const { getRoadRoute, estimateArrival } = require('./routeService');

const isMissingColumn = (err, columnName) => (
  err && err.code === 'ER_BAD_FIELD_ERROR' && String(err.message || '').includes(`'${columnName}'`)
);

async function fetchWarehouseRowsByIds(ids) {
  if (!ids.length) {
    return [];
  }

  const placeholders = ids.map(() => '?').join(', ');

  try {
    const [rows] = await pool.execute(
      `SELECT id, partner_id, name, location, lat, lng
       FROM warehouses
       WHERE id IN (${placeholders}) AND is_deleted = 0`,
      ids
    );
    return rows;
  } catch (err) {
    if (!isMissingColumn(err, 'is_deleted')) {
      throw err;
    }

    const [rows] = await pool.execute(
      `SELECT id, partner_id, name, location, lat, lng
       FROM warehouses
       WHERE id IN (${placeholders})`,
      ids
    );
    return rows;
  }
}

async function fetchPrimaryWarehouseRowsByPartnerIds(partnerIds) {
  if (!partnerIds.length) {
    return [];
  }

  const placeholders = partnerIds.map(() => '?').join(', ');

  try {
    const [rows] = await pool.execute(
      `SELECT w.partner_id, w.id, w.name, w.location, w.lat, w.lng
       FROM warehouses w
       JOIN (
         SELECT partner_id, MIN(id) AS first_id
         FROM warehouses
         WHERE partner_id IN (${placeholders}) AND is_deleted = 0
         GROUP BY partner_id
       ) picked
         ON picked.first_id = w.id`,
      partnerIds
    );
    return rows;
  } catch (err) {
    if (!isMissingColumn(err, 'is_deleted')) {
      throw err;
    }

    const [rows] = await pool.execute(
      `SELECT w.partner_id, w.id, w.name, w.location, w.lat, w.lng
       FROM warehouses w
       JOIN (
         SELECT partner_id, MIN(id) AS first_id
         FROM warehouses
         WHERE partner_id IN (${placeholders})
         GROUP BY partner_id
       ) picked
         ON picked.first_id = w.id`,
      partnerIds
    );
    return rows;
  }
}

const toPoint = (lat, lng) => (
  lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    ? { lat: Number(lat), lng: Number(lng) }
    : null
);

/**
 * Everything the delivery map draws for one order: the center it leaves from, where it goes (the
 * buyer's pin, or the Stockist's warehouse), the rider's trail, the road route still to drive, and
 * an arrival window. Scoped like GET /tracking/:orderId.
 */
async function buildOrderRoute(orderId, scope) {
  const [rows] = await pool.execute(
    `SELECT o.id, o.order_number, o.status AS order_status, o.partner_id, o.source_warehouse_id,
            o.customer_lat, o.customer_lng, ${orderIsPublicSql('o')} AS is_public,
            dt.id AS tracking_id, dt.status AS tracking_status, dt.vehicle_type, dt.rider_name,
            dt.delivered_at
     FROM orders o
     LEFT JOIN delivery_tracking dt ON dt.order_id = o.id
     WHERE o.id = ? AND o.is_deleted = 0${scope.clause}
     LIMIT 1`,
    [orderId, ...scope.params]
  );
  if (rows.length === 0) throw ApiError.notFound('Order not found');
  const row = rows[0];

  const [source] = row.source_warehouse_id ? await fetchWarehouseRowsByIds([Number(row.source_warehouse_id)]) : [];
  let destination = null;
  if (Number(row.is_public)) {
    destination = toPoint(row.customer_lat, row.customer_lng);
  } else if (row.partner_id) {
    const [target] = await fetchPrimaryWarehouseRowsByPartnerIds([Number(row.partner_id)]);
    destination = target ? toPoint(target.lat, target.lng) : null;
  }

  let travelled = [];
  let riderPingedAt = null;
  if (row.tracking_id) {
    const [pings] = await pool.execute(
      `SELECT lat, lng, pinged_at FROM gps_pings WHERE tracking_id = ? ORDER BY pinged_at DESC LIMIT 300`,
      [row.tracking_id]
    );
    riderPingedAt = pings[0]?.pinged_at || null;
    travelled = pings.reverse().map((p) => [Number(p.lat), Number(p.lng)]);
  }

  const sourcePoint = source ? toPoint(source.lat, source.lng) : null;
  const riderPoint = travelled.length ? { lat: travelled.at(-1)[0], lng: travelled.at(-1)[1] } : null;
  const vehicle = row.vehicle_type || 'motorcycle';
  const delivered = row.order_status === 'delivered';
  const from = riderPoint || sourcePoint;
  const remaining = !delivered && from && destination ? await getRoadRoute(from, destination) : null;
  const planned = sourcePoint && destination ? await getRoadRoute(sourcePoint, destination) : null;

  return {
    order_number: row.order_number,
    order_status: row.order_status,
    tracking_status: row.tracking_status || null,
    vehicle_type: vehicle,
    rider_name: row.rider_name || null,
    source: sourcePoint ? { ...sourcePoint, name: source.name, address: source.location } : null,
    destination,
    rider: riderPoint,
    rider_pinged_at: riderPingedAt,
    travelled,
    planned,
    remaining,
    // An estimate only means something once a rider is on the way.
    eta: remaining && riderPoint ? estimateArrival(remaining.duration_s, vehicle) : null,
    delivered_at: row.delivered_at || null,
  };
}

/** No scope: for callers that already authorized the order another way (rider token, public page). */
const UNSCOPED = Object.freeze({ clause: '', params: [] });

module.exports = { buildOrderRoute, fetchWarehouseRowsByIds, fetchPrimaryWarehouseRowsByPartnerIds, UNSCOPED };
