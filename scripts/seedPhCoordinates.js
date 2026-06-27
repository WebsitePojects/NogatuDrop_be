/**
 * Seed realistic Philippines coordinates for all warehouses (and optionally order customer
 * destination columns when they exist).
 *
 * Usage:
 *   node scripts/seedPhCoordinates.js
 *   # or with a specific env file:
 *   node --env-file=.env.dev scripts/seedPhCoordinates.js
 *
 * Philippines bounds (strictly enforced):
 *   latitude  4.5 – 21.2   (Tawi-Tawi to Batanes)
 *   longitude 116.0 – 127.0 (Palawan west to Saranggani east)
 *
 * The script is IDEMPOTENT: re-running it will overwrite with the same set of
 * pre-assigned coordinates (matched by warehouse name keyword or assigned in
 * insertion-order cycling).  Only warehouses whose lat/lng are NULL or
 * fall outside PH bounds are updated; already-valid rows are skipped.
 */

'use strict';

const pool = require('../src/config/db');

// ---------------------------------------------------------------------------
// Philippine region coordinate anchors (lat, lng) with ±spread jitter so
// multiple warehouses in the same region are not stacked on the same point.
// ---------------------------------------------------------------------------
const PH_REGIONS = [
  // Region I — Ilocos
  { label: 'ilocos',      lat: 17.5747, lng: 120.3877 },
  // Region II — Cagayan Valley
  { label: 'cagayan',     lat: 17.6133, lng: 121.7270 },
  // Region III — Central Luzon
  { label: 'central luzon', lat: 15.4827, lng: 120.7120 },
  // NCR — Metro Manila
  { label: 'metro manila', lat: 14.5995, lng: 120.9842 },
  { label: 'manila',       lat: 14.5995, lng: 120.9842 },
  { label: 'quezon',       lat: 14.6760, lng: 121.0437 },
  { label: 'makati',       lat: 14.5547, lng: 121.0244 },
  { label: 'pasig',        lat: 14.5764, lng: 121.0851 },
  // Region IV-A — CALABARZON
  { label: 'calabarzon',   lat: 14.1008, lng: 121.0794 },
  { label: 'cavite',       lat: 14.2456, lng: 120.8786 },
  { label: 'laguna',       lat: 14.2691, lng: 121.4113 },
  { label: 'batangas',     lat: 13.7565, lng: 121.0583 },
  // Region V — Bicol
  { label: 'bicol',        lat: 13.4209, lng: 123.4136 },
  // Region VI — Western Visayas
  { label: 'iloilo',       lat: 10.7202, lng: 122.5621 },
  { label: 'western visayas', lat: 10.7202, lng: 122.5621 },
  // Region VII — Central Visayas
  { label: 'cebu',         lat: 10.3157, lng: 123.8854 },
  { label: 'central visayas', lat: 10.3157, lng: 123.8854 },
  // Region VIII — Eastern Visayas
  { label: 'leyte',        lat: 11.1803, lng: 124.9936 },
  { label: 'tacloban',     lat: 11.2543, lng: 125.0000 },
  // Region IX — Zamboanga Peninsula
  { label: 'zamboanga',    lat: 6.9214,  lng: 122.0790 },
  // Region X — Northern Mindanao
  { label: 'cagayan de oro', lat: 8.4542, lng: 124.6319 },
  { label: 'northern mindanao', lat: 8.4542, lng: 124.6319 },
  // Region XI — Davao
  { label: 'davao',        lat: 7.1907,  lng: 125.4553 },
  // Region XII — SOCCSKSARGEN
  { label: 'general santos', lat: 6.1100, lng: 125.1720 },
  { label: 'soccsksargen', lat: 6.2700,  lng: 124.6860 },
  // Region XIII — Caraga
  { label: 'caraga',       lat: 8.9456,  lng: 125.5437 },
  { label: 'butuan',       lat: 8.9489,  lng: 125.5436 },
  // CAR — Cordillera Administrative Region
  { label: 'baguio',       lat: 16.4023, lng: 120.5960 },
  { label: 'cordillera',   lat: 16.4023, lng: 120.5960 },
  // BARMM — Bangsamoro
  { label: 'cotabato',     lat: 7.2047,  lng: 124.2312 },
  { label: 'marawi',       lat: 7.9986,  lng: 124.2928 },
  // Province fallbacks
  { label: 'provincial',   lat: 14.5995, lng: 120.9842 }, // Metro Manila default
  { label: 'city',         lat: 10.3157, lng: 123.8854 }, // Cebu default
];

// Spread radius in degrees (~5–10 km jitter so warehouses do not overlap)
const SPREAD = 0.05;

// Default rotation of region anchors when no keyword matches
const DEFAULT_ANCHORS = [
  { lat: 14.5995, lng: 120.9842 }, // Manila
  { lat: 10.3157, lng: 123.8854 }, // Cebu
  { lat:  7.1907, lng: 125.4553 }, // Davao
  { lat: 10.7202, lng: 122.5621 }, // Iloilo
  { lat:  8.4542, lng: 124.6319 }, // CDO
  { lat: 16.4023, lng: 120.5960 }, // Baguio
  { lat: 13.4209, lng: 123.4136 }, // Naga/Bicol
  { lat: 17.5747, lng: 120.3877 }, // Laoag/Ilocos
];

// PH bounding box
const PH_LAT_MIN = 4.5;
const PH_LAT_MAX = 21.2;
const PH_LNG_MIN = 116.0;
const PH_LNG_MAX = 127.0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function jitter(spread) {
  return (Math.random() * 2 - 1) * spread;
}

function isValidPhCoord(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  return (
    Number.isFinite(la) && Number.isFinite(lo) &&
    la >= PH_LAT_MIN && la <= PH_LAT_MAX &&
    lo >= PH_LNG_MIN && lo <= PH_LNG_MAX
  );
}

function resolveCoordForWarehouse(warehouseName, index) {
  const name = String(warehouseName || '').toLowerCase();

  // Try to match a keyword from the warehouse name
  for (const region of PH_REGIONS) {
    if (name.includes(region.label)) {
      return {
        lat: clamp(region.lat + jitter(SPREAD), PH_LAT_MIN, PH_LAT_MAX),
        lng: clamp(region.lng + jitter(SPREAD), PH_LNG_MIN, PH_LNG_MAX),
      };
    }
  }

  // Fall back to cycling through default anchors
  const anchor = DEFAULT_ANCHORS[index % DEFAULT_ANCHORS.length];
  return {
    lat: clamp(anchor.lat + jitter(SPREAD), PH_LAT_MIN, PH_LAT_MAX),
    lng: clamp(anchor.lng + jitter(SPREAD), PH_LNG_MIN, PH_LNG_MAX),
  };
}

async function seedWarehouses(conn) {
  console.log('[seedPhCoordinates] Fetching warehouses…');

  let rows;
  try {
    [rows] = await conn.execute(
      `SELECT id, name, lat, lng FROM warehouses WHERE is_deleted = 0 ORDER BY id ASC`
    );
  } catch {
    // is_deleted column may not exist in early migrations
    [rows] = await conn.execute(
      `SELECT id, name, lat, lng FROM warehouses ORDER BY id ASC`
    );
  }

  console.log(`[seedPhCoordinates] Found ${rows.length} warehouse(s).`);

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const wh = rows[i];

    if (isValidPhCoord(wh.lat, wh.lng)) {
      console.log(
        `  [SKIP] warehouse id=${wh.id} "${wh.name}" — already has valid PH coords ` +
        `(${Number(wh.lat).toFixed(4)}, ${Number(wh.lng).toFixed(4)})`
      );
      skipped++;
      continue;
    }

    const coord = resolveCoordForWarehouse(wh.name, i);

    await conn.execute(
      `UPDATE warehouses SET lat = ?, lng = ?, updated_at = NOW() WHERE id = ?`,
      [coord.lat, coord.lng, wh.id]
    );

    console.log(
      `  [UPDATE] warehouse id=${wh.id} "${wh.name}" → ` +
      `lat=${coord.lat.toFixed(5)}, lng=${coord.lng.toFixed(5)}`
    );
    updated++;
  }

  return { updated, skipped, total: rows.length };
}

async function seedOrderDestinations(conn) {
  // Check whether orders table has customer_lat / customer_lng columns
  let columns;
  try {
    [columns] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'orders'
         AND COLUMN_NAME IN ('customer_lat', 'customer_lng')`
    );
  } catch {
    console.log('[seedPhCoordinates] Could not inspect orders columns — skipping order destinations.');
    return { updated: 0, skipped: 0, total: 0 };
  }

  const colNames = columns.map((c) => c.COLUMN_NAME);
  if (!colNames.includes('customer_lat') || !colNames.includes('customer_lng')) {
    console.log('[seedPhCoordinates] orders.customer_lat/lng columns not found — skipping.');
    return { updated: 0, skipped: 0, total: 0 };
  }

  console.log('[seedPhCoordinates] Seeding order customer destination coordinates…');

  const [rows] = await conn.execute(
    `SELECT id, customer_address, customer_lat, customer_lng
     FROM orders
     WHERE is_deleted = 0
       AND (customer_lat IS NULL OR customer_lng IS NULL
            OR customer_lat NOT BETWEEN ${PH_LAT_MIN} AND ${PH_LAT_MAX}
            OR customer_lng NOT BETWEEN ${PH_LNG_MIN} AND ${PH_LNG_MAX})
     ORDER BY id ASC
     LIMIT 500`
  );

  console.log(`[seedPhCoordinates] Found ${rows.length} order(s) needing destination coords.`);

  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const order = rows[i];
    const coord = resolveCoordForWarehouse(order.customer_address || '', i);
    await conn.execute(
      `UPDATE orders SET customer_lat = ?, customer_lng = ? WHERE id = ?`,
      [coord.lat, coord.lng, order.id]
    );
    updated++;
  }

  return { updated, skipped: 0, total: rows.length };
}

async function main() {
  console.log('=== seedPhCoordinates starting ===');
  const conn = await pool.getConnection();

  try {
    const whResult = await seedWarehouses(conn);
    console.log(
      `\n[warehouses] Updated: ${whResult.updated}, Skipped (already valid): ${whResult.skipped}, Total: ${whResult.total}`
    );

    const ordResult = await seedOrderDestinations(conn);
    if (ordResult.total > 0) {
      console.log(
        `[orders] Updated: ${ordResult.updated}, Total requiring update: ${ordResult.total}`
      );
    }

    console.log('\n=== seedPhCoordinates complete ===');
  } catch (err) {
    console.error('[seedPhCoordinates] ERROR:', err?.message || err);
    process.exit(1);
  } finally {
    conn.release();
    await pool.end();
  }
}

main();
