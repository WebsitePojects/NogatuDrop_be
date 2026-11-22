const ApiError = require('../utils/ApiError');
const { executeSoftDeleteAware } = require('./bankAccountResolver');
const { findTerritoryStockists } = require('./territoryRouting');

// Who ships a store order (and so where its shipping fee is counted from, and whose account the buyer pays).
// Used by checkout (orderController.createPublicOrder) and by the shipping quote shown before it, so both
// always agree on the same fulfiller.

// Company fulfillment centers. They take every store order outside a Stockist territory, every order a
// territory Stockist cannot fill from stock, and every affiliate-link order (management, 2026-10-08).
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

/**
 * The territory Stockist that ships a store order: the first (city before province) whose warehouse has
 * every item. The buyer pays that Stockist's own account (Sir Dino, 2026-11-10); bankAccountResolver falls
 * back to the company account when the Stockist has none for the chosen provider. Centers never take over
 * a territory order, so a Stockist without a warehouse or without the stock refuses it with a clear reason.
 */
async function routeToTerritoryStockist(db, territoryStockists, items) {
  let shortage = null;
  for (const stockist of territoryStockists) {
    if (!stockist.warehouse_id) continue;
    const check = await canWarehouseFulfillItems(db, stockist.warehouse_id, items);
    if (check.ok) {
      return {
        partner_id: stockist.partner_id,
        warehouse_id: stockist.warehouse_id,
        payment_warehouse_id: stockist.warehouse_id,
        routed_by: 'territory',
      };
    }
    shortage = shortage || check;
  }
  if (shortage) {
    throw ApiError.conflict(
      `The Stockist serving your area does not have enough ${shortage.productName || 'stock'} right now. `
      + 'Please lower the quantity or try again later.'
    );
  }
  throw ApiError.conflict('The Stockist serving your area is not taking store orders yet. Please contact Nogatu.');
}

/**
 * Who fulfils a store order. A buyer inside a Stockist's territory is served by that Stockist only; everyone
 * else (and every affiliate-link order, `centersOnly`) by the best center, who also receives the payment.
 */
async function resolvePublicFulfillmentRoute(db, items, location = {}) {
  if (!location.centersOnly) {
    const territoryStockists = await findTerritoryStockists(db, location.barangayCode);
    if (territoryStockists.length > 0) return routeToTerritoryStockist(db, territoryStockists, items);
  }

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

  const center = rankPublicFulfillmentCandidates(capable, location)[0];
  return { ...center, payment_warehouse_id: center.warehouse_id, routed_by: 'center' };
}

module.exports = {
  resolvePublicFulfillmentRoute,
  rankPublicFulfillmentCandidates,
  canWarehouseFulfillItems,
};
