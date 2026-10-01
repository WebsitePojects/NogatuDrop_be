// Single place that turns "goods arrived" into stock. Shared by POST /grn/quick-receive and
// scripts/seedStoreRelaunch.js so the GRN + inventory + stock-movement trio can never drift apart.
//
// Every function takes a caller-owned connection that is ALREADY inside a transaction; this
// module never begins, commits or rolls back. Callers own authorization (who may receive where).

const ApiError = require('../utils/ApiError');
const generateOrderNum = require('../utils/generateOrderNum');
const { ROLES, canonicalRole } = require('../rbac/roles');

const MAX_RECEIVE_QUANTITY = 1000000;
const CLIENT_REF_UNIQUE_INDEX = 'uq_grn_client_ref';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

/** True when `value` is a real calendar date (YYYY-MM-DD) strictly after today in Manila time. */
function isFutureIsoDate(value, now = new Date()) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  const todayInManila = new Date(now.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
  return value > todayInManila;
}

/** True when a MySQL error is the goods_receipts.client_ref unique index firing (i.e. a replay). */
function isClientRefDuplicate(err) {
  return Boolean(
    err &&
    err.code === 'ER_DUP_ENTRY' &&
    String(err.sqlMessage || err.message || '').includes(CLIENT_REF_UNIQUE_INDEX)
  );
}

/**
 * Decides which warehouse a user may receive stock into. Pure so the authorization matrix is
 * testable without a database; fails closed for any role that is not explicitly allowed.
 *
 * @param {{roleSlug: string, partnerId: number|null, requestedWarehouseId: number|null,
 *          ownedWarehouseIds: number[]}} input  ownedWarehouseIds = active warehouses of partnerId
 * @returns {number} the warehouse id to receive into
 */
function resolveReceivingWarehouse({ roleSlug, partnerId, requestedWarehouseId, ownedWarehouseIds }) {
  const role = canonicalRole(roleSlug);
  const requested = requestedWarehouseId == null ? null : Number(requestedWarehouseId);

  if (role === ROLES.SUPER_ADMIN) {
    if (!requested) throw ApiError.badRequest('warehouse_id is required');
    return requested;
  }

  const isPartnerReceiver = [ROLES.PROVINCIAL_STOCKIST, ROLES.CITY_STOCKIST, ROLES.STAFF].includes(role);
  if (!isPartnerReceiver || !partnerId) {
    throw ApiError.forbidden('You do not have permission to receive stock');
  }

  const owned = ownedWarehouseIds.map(Number);
  if (requested) {
    if (!owned.includes(requested)) throw ApiError.forbidden('That warehouse does not belong to your account');
    return requested;
  }
  if (owned.length === 1) return owned[0];
  throw ApiError.badRequest('warehouse_id is required');
}

// grn_items carries two legacy column pairs (expected_qty/expected_quantity); the GRN draft flow
// already tolerates databases that only have one, so the fallback lives here, next to its only writer.
async function insertGRNItem(db, grnId, item) {
  const expectedQty = item.expected_qty || item.expected_quantity || 0;
  const receivedQty = item.received_qty || item.received_quantity || 0;
  const values = [
    grnId,
    item.product_id,
    expectedQty,
    receivedQty,
    item.batch_number || null,
    item.expiry_date || null,
    item.unit_cost || null,
    item.notes || null,
  ];

  try {
    await db.execute(
      `INSERT INTO grn_items (grn_id, product_id, expected_qty, received_qty, batch_number, expiry_date, unit_cost, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      values
    );
  } catch (err) {
    if (!isMissingColumn(err, 'expected_qty')) throw err;
    await db.execute(
      `INSERT INTO grn_items (grn_id, product_id, expected_quantity, received_quantity, batch_number, expiry_date, unit_cost, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      values
    );
  }
}

/**
 * Records an incoming stock receipt: a completed GRN with one line, the inventory increment
 * for (product, warehouse), and an 'in' stock movement with before/after stock.
 *
 * Duplicate safety is the caller's: pass `clientRef` and treat isClientRefDuplicate(err) as a replay.
 * The warehouse row is locked first so concurrent receipts into one warehouse serialize and
 * cannot both INSERT the first inventory row for the same product.
 *
 * @returns {Promise<{grnId:number, grnNumber:string, inventoryId:number, warehouseId:number,
 *                    productId:number, newStock:number}>}
 */
async function receiveStock(conn, {
  productId, warehouseId, quantity, batchNumber, expiryDate,
  supplier = null, notes = null, createdBy, clientRef = null,
}) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_RECEIVE_QUANTITY) {
    throw ApiError.badRequest(`quantity must be a whole number between 1 and ${MAX_RECEIVE_QUANTITY}`);
  }
  if (!batchNumber || !expiryDate) throw ApiError.badRequest('batch_number and expiry_date are required');

  const [warehouses] = await conn.execute(
    `SELECT id, partner_id FROM warehouses
     WHERE id = ? AND is_deleted = 0 AND is_active = 1
     FOR UPDATE`,
    [warehouseId]
  );
  if (warehouses.length === 0) throw ApiError.notFound('Warehouse not found');

  const [products] = await conn.execute(
    'SELECT id FROM products WHERE id = ? AND is_deleted = 0 AND is_active = 1',
    [productId]
  );
  if (products.length === 0) throw ApiError.notFound('Product not found');

  const grnNumber = await generateOrderNum('GRN', 'goods_receipts', 'grn_number');
  const [grn] = await conn.execute(
    `INSERT INTO goods_receipts (grn_number, warehouse_id, received_by, status, supplier, notes, completed_at, client_ref)
     VALUES (?, ?, ?, 'completed', ?, ?, NOW(), ?)`,
    [grnNumber, warehouseId, createdBy, supplier, notes, clientRef]
  );
  const grnId = grn.insertId;

  await insertGRNItem(conn, grnId, {
    product_id: productId,
    expected_qty: quantity,
    received_qty: quantity,
    batch_number: batchNumber,
    expiry_date: expiryDate,
  });

  // Inventory identity is (product, warehouse); the first receipt's batch/expiry label the row,
  // later receipts only add quantity (same convention as completeGRN). The batch of every
  // receipt is still preserved on its grn_items line.
  const [existing] = await conn.execute(
    `SELECT id, current_stock FROM inventories
     WHERE product_id = ? AND warehouse_id = ? AND is_active = 1
     ORDER BY id
     LIMIT 1
     FOR UPDATE`,
    [productId, warehouseId]
  );

  let inventoryId;
  let beforeStock;
  if (existing.length > 0) {
    inventoryId = existing[0].id;
    beforeStock = Number(existing[0].current_stock);
    await conn.execute(
      'UPDATE inventories SET current_stock = current_stock + ?, last_movement_at = NOW() WHERE id = ?',
      [quantity, inventoryId]
    );
  } else {
    beforeStock = 0;
    const [inserted] = await conn.execute(
      `INSERT INTO inventories (product_id, warehouse_id, partner_id, current_stock, batch_number, expiry_date, last_movement_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [productId, warehouseId, warehouses[0].partner_id || null, quantity, batchNumber, expiryDate]
    );
    inventoryId = inserted.insertId;
  }
  const newStock = beforeStock + quantity;

  await conn.execute(
    `INSERT INTO stock_movements
       (inventory_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id,
        before_stock, after_stock, notes, created_by)
     VALUES (?, ?, ?, 'in', ?, 'grn', ?, ?, ?, ?, ?)`,
    [inventoryId, productId, warehouseId, quantity, grnId, beforeStock, newStock, `Stock received via GRN ${grnNumber}`, createdBy]
  );

  return { grnId, grnNumber, inventoryId, warehouseId: Number(warehouseId), productId: Number(productId), newStock };
}

const toReceiptResult = (receipt) => ({
  grnId: Number(receipt.grnId),
  inventoryId: Number(receipt.inventoryId),
  productId: Number(receipt.productId),
  warehouseId: Number(receipt.warehouseId),
  newStock: Number(receipt.newStock),
});

// Re-reads a committed receipt by its client_ref. Must run on a connection that is NOT inside the
// aborted transaction (the loser's rollback has already happened by the time this is called).
async function findReceiptByClientRef(db, clientRef) {
  const [rows] = await db.execute(
    `SELECT g.id AS grnId, g.warehouse_id AS warehouseId, gi.product_id AS productId,
            gi.received_qty AS quantity, gi.batch_number AS batchNumber, gi.expiry_date AS expiryDate,
            sm.inventory_id AS inventoryId, sm.after_stock AS newStock
     FROM goods_receipts g
     JOIN grn_items gi ON gi.grn_id = g.id
     JOIN stock_movements sm ON sm.reference_type = 'grn' AND sm.reference_id = g.id AND sm.product_id = gi.product_id
     WHERE g.client_ref = ?
     LIMIT 1`,
    [clientRef]
  );
  return rows[0] || null;
}

/**
 * receiveStock in its own transaction, safe to fire twice: the unique client_ref decides the
 * winner, and the loser gets the winner's original result instead of a second effect.
 * Reusing a clientRef with a different payload is a client bug and is rejected with 409.
 *
 * @param db  anything with getConnection() and execute() (the mysql2 pool in production)
 * @returns {Promise<{replayed:boolean, result:{grnId,inventoryId,productId,warehouseId,newStock}}>}
 */
async function receiveStockOnce(db, receipt) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const created = await receiveStock(conn, receipt);
    await conn.commit();
    return { replayed: false, result: toReceiptResult(created) };
  } catch (err) {
    await conn.rollback();
    if (!isClientRefDuplicate(err)) throw err;
  } finally {
    conn.release();
  }

  const original = await findReceiptByClientRef(db, receipt.clientRef);
  if (!original) throw ApiError.conflict('Duplicate receipt reference could not be resolved, please retry');

  const samePayload =
    Number(original.productId) === Number(receipt.productId) &&
    Number(original.warehouseId) === Number(receipt.warehouseId) &&
    Number(original.quantity) === receipt.quantity &&
    original.batchNumber === receipt.batchNumber &&
    String(original.expiryDate).slice(0, 10) === receipt.expiryDate;
  if (!samePayload) throw ApiError.conflict('Idempotency-Key was already used with a different receipt');

  return { replayed: true, result: toReceiptResult(original) };
}

module.exports = {
  MAX_RECEIVE_QUANTITY,
  CLIENT_REF_UNIQUE_INDEX,
  isFutureIsoDate,
  isClientRefDuplicate,
  resolveReceivingWarehouse,
  insertGRNItem,
  receiveStock,
  receiveStockOnce,
};
