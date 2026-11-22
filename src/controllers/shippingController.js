const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { quotePublicCart } = require('../services/shippingService');

// Island groups a region can belong to; the tiers are counted from them (services/shippingService.js).
const ISLAND_GROUP_ZONES = ['LUZON', 'VISAYAS', 'MINDANAO'];

// POST /api/v1/shipping/quote  { barangay_code, items: [{ product_id, quantity }], centers_only? }   (public, read-only)
// What checkout shows before the buyer pays: who would ship it, the fee from there and the delivery window.
// Placing the order computes the same quote again on the server. `centers_only` is the influencer-link
// checkout (always shipped by a center); the order itself decides that from the link, not from this flag.
const getShippingQuote = asyncHandler(async (req, res) => {
  const quote = await quotePublicCart(pool, {
    barangayCode: req.body.barangay_code,
    items: req.body.items,
    centersOnly: req.body.centers_only === true,
  });
  res.json({ success: true, data: quote });
});

async function readSettings(db) {
  const [[zones], [rates], [regions], [provinces], [products]] = await Promise.all([
    db.execute('SELECT code, name, eta_min_days, eta_max_days FROM shipping_zones ORDER BY sort_order, code'),
    db.execute('SELECT zone_code, max_weight_grams, fee FROM shipping_rates ORDER BY zone_code, max_weight_grams'),
    db.execute(
      `SELECT r.code, r.name, z.zone_code FROM ph_regions r
       LEFT JOIN shipping_area_zones z ON z.area_type = 'region' AND z.area_code = r.code
       ORDER BY r.name`
    ),
    db.execute(
      `SELECT p.code, p.name, p.region_code, z.zone_code FROM ph_provinces p
       LEFT JOIN shipping_area_zones z ON z.area_type = 'province' AND z.area_code = p.code
       ORDER BY p.name`
    ),
    db.execute(
      `SELECT id, name, sku, weight_grams FROM products
       WHERE is_deleted = 0 AND is_active = 1 ORDER BY name`
    ),
  ]);
  const ratesByZone = new Map(zones.map((zone) => [zone.code, []]));
  for (const rate of rates) {
    ratesByZone.get(rate.zone_code)?.push({ max_weight_grams: Number(rate.max_weight_grams), fee: Number(rate.fee) });
  }
  return {
    zones: zones.map((zone) => ({ ...zone, rates: ratesByZone.get(zone.code) })),
    island_group_zones: ISLAND_GROUP_ZONES,
    regions,
    provinces,
    products,
  };
}

// GET /api/v1/shipping/settings  (Super Admin)
const getShippingSettings = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await readSettings(pool) });
});

/** Rates must climb in weight with no repeated bracket, or two brackets would claim the same cart. */
function assertBracketsAscending(zoneCode, rates) {
  for (let i = 1; i < rates.length; i += 1) {
    if (rates[i].max_weight_grams <= rates[i - 1].max_weight_grams) {
      throw ApiError.badRequest(`${zoneCode}: each weight bracket must be heavier than the one before it`);
    }
  }
}

/** Throws naming the first code that is not in `table`; one query for the whole list. Names come from code. */
async function assertAllExist(conn, table, column, values, label) {
  if (values.length === 0) return;
  const unique = [...new Set(values.map(String))];
  const [rows] = await conn.query(`SELECT ${column} AS v FROM ${table} WHERE ${column} IN (?)`, [unique]);
  const found = new Set(rows.map((row) => String(row.v)));
  const missing = unique.find((value) => !found.has(value));
  if (missing) throw ApiError.badRequest(`Unknown ${label} ${missing}`);
}

// PUT /api/v1/shipping/settings  (Super Admin)
// { zones: [{ code, eta_min_days, eta_max_days, rates: [{ max_weight_grams, fee }] }],
//   regions: [{ code, zone_code }], provinces: [{ code, zone_code | null }], products: [{ id, weight_grams }] }
// Each list sets exactly what it sends, in one transaction, so saving the same screen twice changes nothing.
// A region's zone is its island group; a province with zone_code null follows its region.
const updateShippingSettings = asyncHandler(async (req, res) => {
  const { zones = [], regions = [], provinces = [], products = [] } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Locking every zone row serializes two Super Admins saving at once: the second waits, then wins whole.
    const [knownZones] = await conn.execute('SELECT code FROM shipping_zones FOR UPDATE');
    const zoneCodes = new Set(knownZones.map((zone) => zone.code));
    const assertZone = (code) => {
      // Fail closed: a zone the system does not have can never be assigned or priced.
      if (!zoneCodes.has(code)) throw ApiError.badRequest(`Unknown shipping zone ${code}`);
    };

    const rateRows = [];
    for (const zone of zones) {
      assertZone(zone.code);
      if (zone.eta_min_days > zone.eta_max_days) {
        throw ApiError.badRequest(`${zone.code}: the earliest delivery day cannot be after the latest`);
      }
      const rates = [...zone.rates].sort((a, b) => a.max_weight_grams - b.max_weight_grams);
      assertBracketsAscending(zone.code, rates);
      rates.forEach((rate) => rateRows.push([zone.code, rate.max_weight_grams, rate.fee]));
      await conn.execute(
        'UPDATE shipping_zones SET eta_min_days = ?, eta_max_days = ?, updated_by = ? WHERE code = ?',
        [zone.eta_min_days, zone.eta_max_days, req.user.id, zone.code]
      );
    }
    if (zones.length) {
      // Rates are a price list, not business records: each sent zone's list is replaced as a whole.
      await conn.query('DELETE FROM shipping_rates WHERE zone_code IN (?)', [zones.map((zone) => zone.code)]);
      await conn.query('INSERT INTO shipping_rates (zone_code, max_weight_grams, fee) VALUES ?', [rateRows]);
    }

    for (const region of regions) {
      if (!ISLAND_GROUP_ZONES.includes(region.zone_code)) {
        throw ApiError.badRequest(`A region belongs to Luzon, Visayas or Mindanao, not ${region.zone_code}`);
      }
    }
    await assertAllExist(conn, 'ph_regions', 'code', regions.map((r) => r.code), 'region');
    if (regions.length) {
      await conn.query(
        `INSERT INTO shipping_area_zones (area_type, area_code, zone_code) VALUES ?
         ON DUPLICATE KEY UPDATE zone_code = VALUES(zone_code)`,
        [regions.map((r) => ['region', r.code, r.zone_code])]
      );
    }

    await assertAllExist(conn, 'ph_provinces', 'code', provinces.map((p) => p.code), 'province');
    const provinceOverrides = provinces.filter((p) => p.zone_code != null);
    const provincesFollowingRegion = provinces.filter((p) => p.zone_code == null).map((p) => p.code);
    provinceOverrides.forEach((p) => assertZone(p.zone_code));
    if (provincesFollowingRegion.length) {
      await conn.query(
        "DELETE FROM shipping_area_zones WHERE area_type = 'province' AND area_code IN (?)",
        [provincesFollowingRegion]
      );
    }
    if (provinceOverrides.length) {
      await conn.query(
        `INSERT INTO shipping_area_zones (area_type, area_code, zone_code) VALUES ?
         ON DUPLICATE KEY UPDATE zone_code = VALUES(zone_code)`,
        [provinceOverrides.map((p) => ['province', p.code, p.zone_code])]
      );
    }

    if (products.length) {
      const [found] = await conn.query('SELECT id FROM products WHERE id IN (?) AND is_deleted = 0', [products.map((p) => p.id)]);
      const foundIds = new Set(found.map((row) => Number(row.id)));
      const missing = products.find((p) => !foundIds.has(Number(p.id)));
      if (missing) throw ApiError.badRequest(`Product ${missing.id} not found`);
      // One statement for every weight: CASE id WHEN ? THEN ? ... (ids and grams are bound, never inlined).
      await conn.query(
        `UPDATE products SET weight_grams = CASE id ${products.map(() => 'WHEN ? THEN ?').join(' ')} END
         WHERE id IN (?)`,
        [...products.flatMap((p) => [p.id, p.weight_grams]), products.map((p) => p.id)]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({ success: true, message: 'Shipping settings saved', data: await readSettings(pool) });
});

module.exports = { getShippingQuote, getShippingSettings, updateShippingSettings };
