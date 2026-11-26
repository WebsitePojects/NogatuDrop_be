// Removing a Stockist or a warehouse (Sir Dino, 2026-11-26: "Can super admin delete stockist and warehouses?").
// A removal is allowed only when nothing live depends on it, so no buyer's order, reserved stock or transfer is
// ever left pointing at a deleted place. Everything here runs on the caller's transaction connection.
const ApiError = require('../utils/ApiError');

const OPEN_ORDER_STATUSES = ['pending', 'approved', 'delivering'];
const OPEN_TRANSFER_STATUSES = ['pending', 'in_transit'];

// `IN (?)` with an empty list is invalid SQL; 0 matches no row (ids start at 1).
const orNone = (ids) => (ids.length ? ids : [0]);

/**
 * What still ties these warehouses (and, for a Stockist, the business itself) to live work: open orders it
 * ships or placed, stock on hand, transfers in or out that are not finished, and City Stockists under it.
 */
async function findRemovalBlockers(conn, { warehouseIds, partnerIds = [] }) {
  const wh = orNone(warehouseIds);
  const pt = orNone(partnerIds);
  const [[row]] = await conn.query(
    `SELECT
       (SELECT COUNT(*) FROM orders o
         WHERE o.is_deleted = 0 AND o.status IN (?)
           AND (o.source_warehouse_id IN (?) OR o.partner_id IN (?)
                OR o.id IN (SELECT oi.order_id FROM order_items oi WHERE oi.source_warehouse_id IN (?)))) AS open_orders,
       (SELECT COALESCE(SUM(i.current_stock), 0) FROM inventories i WHERE i.warehouse_id IN (?)) AS units_in_stock,
       (SELECT COUNT(*) FROM stock_transfers t
         WHERE t.is_deleted = 0 AND t.status IN (?) AND (t.from_warehouse_id IN (?) OR t.to_warehouse_id IN (?))) AS open_transfers,
       (SELECT COUNT(*) FROM partners c WHERE c.is_deleted = 0 AND c.parent_partner_id IN (?)) AS child_stockists`,
    [OPEN_ORDER_STATUSES, wh, pt, wh, wh, OPEN_TRANSFER_STATUSES, wh, wh, pt]
  );
  return {
    openOrders: Number(row.open_orders),
    unitsInStock: Number(row.units_in_stock),
    openTransfers: Number(row.open_transfers),
    childStockists: Number(row.child_stockists),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Refuses (409) with every reason at once, so Super Admin knows all that must be finished first. */
function assertNothingOpen(blockers, subject) {
  const reasons = [];
  if (blockers.openOrders) reasons.push(plural(blockers.openOrders, 'open order'));
  if (blockers.unitsInStock) reasons.push(`${blockers.unitsInStock} units in stock`);
  if (blockers.openTransfers) reasons.push(plural(blockers.openTransfers, 'unfinished stock transfer'));
  if (blockers.childStockists) reasons.push(plural(blockers.childStockists, 'City Stockist') + ' under it');
  if (reasons.length === 0) return;
  throw ApiError.conflict(
    `${subject} still has ${reasons.join(', ')}. Finish or cancel the orders, move the stock out`
    + `${blockers.childStockists ? ' and move or delete its City Stockists' : ''} first, then delete again.`
  );
}

/** Soft-deletes one warehouse and the payment accounts buyers paid into there. */
async function softDeleteWarehouse(conn, warehouseId) {
  await conn.execute('UPDATE bank_accounts SET is_deleted = 1 WHERE warehouse_id = ? AND is_deleted = 0', [warehouseId]);
  await conn.execute('UPDATE warehouses SET is_deleted = 1, is_active = 0 WHERE id = ? AND is_deleted = 0', [warehouseId]);
}

/**
 * Soft-deletes Stockists with everything that belongs to them: logins, Mobile Stockists, warehouses and their
 * payment accounts. Their store territories are removed (rows, so the area can be given to another Stockist).
 * Orders are not touched here: callers either refuse while any is open (delete) or settle them first (clean-up).
 */
async function softDeleteStockists(conn, partnerIds) {
  if (partnerIds.length === 0) return;
  await conn.query("UPDATE users SET is_deleted = 1, status = 'inactive' WHERE partner_id IN (?) AND is_deleted = 0", [partnerIds]);
  await conn.query("UPDATE mobile_stockists SET is_deleted = 1, status = 'inactive' WHERE partner_id IN (?) AND is_deleted = 0", [partnerIds]);
  await conn.query(
    `UPDATE bank_accounts ba JOIN warehouses w ON w.id = ba.warehouse_id
     SET ba.is_deleted = 1 WHERE w.partner_id IN (?) AND ba.is_deleted = 0`, [partnerIds]
  );
  await conn.query('UPDATE warehouses SET is_deleted = 1, is_active = 0 WHERE partner_id IN (?) AND is_deleted = 0', [partnerIds]);
  await conn.query('DELETE FROM stockist_territories WHERE partner_id IN (?)', [partnerIds]);
  await conn.query("UPDATE partners SET is_deleted = 1, status = 'inactive' WHERE id IN (?) AND is_deleted = 0", [partnerIds]);
}

module.exports = {
  OPEN_ORDER_STATUSES,
  findRemovalBlockers,
  assertNothingOpen,
  softDeleteWarehouse,
  softDeleteStockists,
};
