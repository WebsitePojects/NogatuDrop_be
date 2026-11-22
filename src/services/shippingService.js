const ApiError = require('../utils/ApiError');
const { assertWithinPublicItemLimit } = require('./publicOrderLimits');
const { resolvePublicFulfillmentRoute } = require('./publicFulfillmentRoute');

// Store shipping fee = rate for (delivery tier, total cart weight), from the tables Super Admin edits on the
// Shipping Fees screen (Sir Dino, 2026-11-10; rates from PROPOSAL_0026_SHIPPING_FEES). The server always
// computes it; the storefront only shows the quote. Schema and seeds: scripts/addShippingRates.js.
//
// The proposal prices parcels sent FROM NCR (Caloocan, Tycoon). A Stockist ships from its own province, so
// the fee is counted from where the parcel leaves (2026-11-23): the same distance gets the same price.
//   same region as the origin          -> NCR row    ("local": NCR -> NCR is the proposal's own local rate)
//   same island group, other region     -> LUZON row  (NCR -> rest of Luzon)
//   one island group away               -> VISAYAS row (Luzon <-> Visayas, Visayas <-> Mindanao)
//   two island groups away              -> MINDANAO row (Luzon <-> Mindanao)
//   an Island / Palawan province        -> that row, unless the parcel never leaves the province
// From the NCR hubs this reproduces the proposal's table exactly.

const PH_TIME_ZONE = 'Asia/Manila';
const DAY_MS = 24 * 60 * 60 * 1000;

// Island group of each "group" zone, by how many sea crossings apart they are.
// NCR counts as Luzon, so a region still mapped to the NCR row (older seed) is never mistaken for an island.
const ISLAND_GROUP_RANK = Object.freeze({ NCR: 0, LUZON: 0, VISAYAS: 1, MINDANAO: 2 });
const TIER_BY_GROUP_DISTANCE = Object.freeze(['LUZON', 'VISAYAS', 'MINDANAO']);
const LOCAL_TIER = 'NCR';
// The proposal's own origin: used when a fulfilling warehouse has no address on file.
const NCR_ORIGIN = Object.freeze({ region_code: '130000000', region_zone: 'LUZON', province_code: null, area_name: 'Metro Manila' });

/** Today's calendar date in the Philippines as 'YYYY-MM-DD', whatever the server's own time zone. */
function philippineToday(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: PH_TIME_ZONE }).format(now);
}

/** 'YYYY-MM-DD' plus `days` calendar days. Works in UTC so no daylight or zone shift can move the date. */
function addCalendarDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The delivery window for a parcel that starts its journey on `now` (order date, or payment date once paid). */
function deliveryWindow(minDays, maxDays, now = new Date()) {
  const start = philippineToday(now);
  return { eta_from: addCalendarDays(start, Number(minDays)), eta_to: addCalendarDays(start, Number(maxDays)) };
}

/**
 * The rate for a cart weight: the bracket with the smallest upper bound that still holds it, so exactly
 * 3.000 kg is in the "up to 3 kg" bracket. `rates` must be sorted by max_weight_grams ascending.
 * Returns null when the cart is heavier than the last bracket.
 */
function pickShippingRate(rates, weightGrams) {
  return rates.find((rate) => Number(rate.max_weight_grams) >= weightGrams) || null;
}

/**
 * Which rate row a parcel uses, from where it leaves (`origin`) to where it goes (`destination`).
 * Each place is { province_code, region_code, region_zone, province_zone? } where region_zone is the
 * region's island group (LUZON, VISAYAS, MINDANAO) and province_zone an optional province override.
 * Returns a zone code, or null when the destination has no zone (fail closed: no price, no sale).
 */
function shippingTier(origin, destination) {
  const destZone = destination.province_zone || destination.region_zone;
  if (!destZone) return null;
  const from = origin && origin.region_zone in ISLAND_GROUP_RANK ? origin : NCR_ORIGIN;

  if (!(destZone in ISLAND_GROUP_RANK)) {
    // Island / Palawan: the sea crossing is the cost, unless the Stockist ships inside its own province.
    return from.province_code && from.province_code === destination.province_code ? LOCAL_TIER : destZone;
  }
  if (from.region_code === destination.region_code) return LOCAL_TIER;
  return TIER_BY_GROUP_DISTANCE[Math.abs(ISLAND_GROUP_RANK[from.region_zone] - ISLAND_GROUP_RANK[destZone])];
}

const formatKg = (grams) => `${(grams / 1000).toFixed(2)} kg`;

// Province, region and their shipping zones for barangay alias `b`. NCR cities have no province, so the
// region comes from the city.
const PLACE_COLUMNS = `c.province_code, r.code AS region_code, COALESCE(pr.name, r.name) AS area_name,
       pz.zone_code AS province_zone, rz.zone_code AS region_zone`;
const PLACE_JOINS = `JOIN ph_cities_municipalities c ON c.code = b.city_code
     LEFT JOIN ph_provinces pr ON pr.code = c.province_code
     LEFT JOIN ph_regions r ON r.code = COALESCE(c.region_code, pr.region_code)
     LEFT JOIN shipping_area_zones pz ON pz.area_type = 'province' AND pz.area_code = c.province_code
     LEFT JOIN shipping_area_zones rz ON rz.area_type = 'region' AND rz.area_code = r.code`;

async function loadDestination(db, barangayCode) {
  const [rows] = await db.execute(
    `SELECT ${PLACE_COLUMNS} FROM ph_barangays b ${PLACE_JOINS} WHERE b.code = ? LIMIT 1`,
    [barangayCode]
  );
  if (rows.length === 0) throw ApiError.badRequest('Please choose your barangay from the list.');
  return rows[0];
}

/** Where a warehouse ships from: its own address, else its Stockist's. Null when neither is on file. */
async function loadOrigin(db, warehouseId) {
  if (!warehouseId) return null;
  const [rows] = await db.execute(
    `SELECT ${PLACE_COLUMNS}
     FROM warehouses w
     LEFT JOIN partners p ON p.id = w.partner_id
     JOIN ph_barangays b ON b.code = COALESCE(w.barangay_code, p.barangay_code)
     ${PLACE_JOINS}
     WHERE w.id = ? LIMIT 1`,
    [warehouseId]
  );
  return rows[0] || null;
}

/** Name and grams of every product in the cart, one query. Refuses a product that has no weight yet. */
async function loadCartProducts(db, items) {
  const productIds = [...new Set(items.map((item) => Number(item.product_id)))];
  const placeholders = productIds.map(() => '?').join(', ');
  const [products] = await db.execute(
    `SELECT id, name, weight_grams FROM products
     WHERE id IN (${placeholders}) AND is_deleted = 0 AND is_active = 1`,
    productIds
  );
  const byId = new Map(products.map((product) => [Number(product.id), product]));
  for (const id of productIds) {
    const product = byId.get(id);
    if (!product) throw ApiError.badRequest(`Product ${id} not found`);
    if (product.weight_grams == null || Number(product.weight_grams) <= 0) {
      throw ApiError.conflict(`${product.name} cannot be shipped yet because its weight is not set. Please contact Nogatu.`);
    }
  }
  return byId;
}

async function computeQuote(db, { barangayCode, items, originWarehouseId, now }) {
  const destination = await loadDestination(db, barangayCode);
  const origin = await loadOrigin(db, originWarehouseId);
  if (originWarehouseId && !origin) {
    // Priced from NCR, the proposal's origin, so the buyer is never undercharged; logged so the address gets filled.
    console.warn(`[shipping] warehouse ${originWarehouseId} has no address; quoting from NCR`);
  }
  const tier = shippingTier(origin, destination);
  if (!tier) {
    // Fail closed: an area nobody mapped to a zone has no price, so it cannot be charged one.
    throw ApiError.badRequest(`We cannot ship to ${destination.area_name || 'this area'} yet. Please contact Nogatu.`);
  }

  const products = await loadCartProducts(db, items);
  const weightGrams = items.reduce(
    (sum, item) => sum + Number(products.get(Number(item.product_id)).weight_grams) * Number(item.quantity), 0
  );
  const [[zones], [rates]] = await Promise.all([
    db.execute('SELECT name, eta_min_days, eta_max_days FROM shipping_zones WHERE code = ? LIMIT 1', [tier]),
    db.execute('SELECT max_weight_grams, fee FROM shipping_rates WHERE zone_code = ? ORDER BY max_weight_grams ASC', [tier]),
  ]);
  const rate = pickShippingRate(rates, weightGrams);
  if (!zones[0] || !rate) {
    if (zones[0] && rates.length) {
      throw ApiError.badRequest(
        `This order weighs ${formatKg(weightGrams)}, more than one parcel can carry. Please split it into two orders.`
      );
    }
    throw ApiError.serviceUnavailable('Shipping rates are not set up yet. Please try again later.');
  }

  const zone = zones[0];
  return {
    zone_code: tier,
    zone_name: zone.name,
    area_name: destination.area_name,
    origin_name: (origin || NCR_ORIGIN).area_name,
    weight_grams: weightGrams,
    fee: Number(rate.fee),
    eta_min_days: Number(zone.eta_min_days),
    eta_max_days: Number(zone.eta_max_days),
    ...deliveryWindow(zone.eta_min_days, zone.eta_max_days, now),
  };
}

/**
 * The shipping fee and delivery window for a store cart going to `barangayCode`, shipped from
 * `originWarehouseId` (the fulfilling warehouse; null = the NCR hubs).
 * `items` are [{ product_id, quantity }] with whole positive quantities (the route validates them).
 * Returns { zone_code, zone_name, area_name, origin_name, weight_grams, fee, eta_min_days, eta_max_days,
 * eta_from, eta_to }; the dates assume the order is paid today.
 */
async function quoteShipping(db, { barangayCode, items, originWarehouseId = null, now = new Date() }) {
  if (!Array.isArray(items) || items.length === 0) throw ApiError.badRequest('items are required');
  assertWithinPublicItemLimit(items);

  try {
    return await computeQuote(db, { barangayCode, items, originWarehouseId, now });
  } catch (err) {
    // A database the migration has not reached yet: say which script fixes it instead of a bare 500.
    if (err.code === 'ER_NO_SUCH_TABLE' || (err.code === 'ER_BAD_FIELD_ERROR' && /weight_grams/.test(err.message))) {
      console.error('[shipping] schema missing, run scripts/addShippingRates.js --apply:', err.message);
      throw ApiError.serviceUnavailable('Shipping rates are not set up yet. Please try again later.');
    }
    throw err;
  }
}

/**
 * The checkout preview: works out who would ship this cart (the same routing the order uses, including
 * "not enough stock at the Stockist serving your area"), then quotes from that warehouse.
 */
async function quotePublicCart(db, { barangayCode, items, centersOnly = false }) {
  if (!Array.isArray(items) || items.length === 0) throw ApiError.badRequest('items are required');
  assertWithinPublicItemLimit(items);
  const products = await loadCartProducts(db, items);
  const named = items.map((item) => ({ ...item, name: products.get(Number(item.product_id)).name }));
  const route = await resolvePublicFulfillmentRoute(db, named, { barangayCode, centersOnly });
  return quoteShipping(db, { barangayCode, items, originWarehouseId: route.warehouse_id });
}

module.exports = {
  quoteShipping,
  quotePublicCart,
  pickShippingRate,
  shippingTier,
  deliveryWindow,
  philippineToday,
  addCalendarDays,
};
