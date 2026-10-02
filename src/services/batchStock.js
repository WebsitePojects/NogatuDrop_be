// Stock for one product in one warehouse can sit in several inventories rows, one per batch (that is
// how the Tycoon team recorded its counted stock on 2026-07-10). Reserving, releasing and delivering
// an order quantity must therefore be spread across those rows. Updating "every row of the product"
// instead reserved or deducted the full quantity once per batch row.
//
// Each operation locks the product's rows in the warehouse (SELECT ... FOR UPDATE, inside the
// caller's transaction), plans the split earliest-expiry first, and applies it row by row with a
// guarded UPDATE. Concurrent orders for the same product serialize on the row locks.

const isMissingSoftDeleteColumn = (err) => (
  err && err.code === 'ER_BAD_FIELD_ERROR' && String(err.message || '').includes("'is_deleted'")
);

// Rows without a real expiry (NULL or MariaDB zero date) are used last.
const BATCH_ORDER = `ORDER BY (expiry_date IS NULL OR expiry_date < '1000-01-01'), expiry_date, id`;

/** Locks and returns the product's rows in the warehouse, earliest expiry first. */
async function lockBatches(conn, productId, warehouseId) {
  const columns = 'SELECT id, current_stock, reserved_stock, batch_number, expiry_date FROM inventories';
  try {
    const [rows] = await conn.execute(
      `${columns} WHERE product_id = ? AND warehouse_id = ? AND is_deleted = 0 ${BATCH_ORDER} FOR UPDATE`,
      [productId, warehouseId]
    );
    return rows;
  } catch (err) {
    // Some deployments' inventories table has no is_deleted column (same fallback as availability).
    if (!isMissingSoftDeleteColumn(err)) throw err;
    const [rows] = await conn.execute(
      `${columns} WHERE product_id = ? AND warehouse_id = ? ${BATCH_ORDER} FOR UPDATE`,
      [productId, warehouseId]
    );
    return rows;
  }
}

const num = (value) => Number(value || 0);

/** Free stock (on hand minus already reserved) summed over all batch rows. */
function availableOf(rows) {
  return rows.reduce((sum, row) => sum + Math.max(0, num(row.current_stock) - num(row.reserved_stock)), 0);
}

/**
 * Splits `quantity` over rows in their given order, taking at most capacity(row) from each.
 * Returns [{ id, quantity }] covering the whole quantity, or null when the rows cannot cover it.
 */
function planAcross(rows, quantity, capacity) {
  const plan = [];
  let remaining = quantity;
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, capacity(row)));
    if (take > 0) {
      plan.push({ id: row.id, quantity: take });
      remaining -= take;
    }
  }
  return remaining === 0 ? plan : null;
}

const planReserve = (rows, quantity) => planAcross(rows, quantity, (row) => num(row.current_stock) - num(row.reserved_stock));
// Delivery consumes stock that was reserved for the order, so it draws only on reserved quantities.
const planConsume = (rows, quantity) => planAcross(rows, quantity, (row) => Math.min(num(row.reserved_stock), num(row.current_stock)));

/**
 * Releases up to `quantity` of reservations. Unlike reserve and consume this never fails: releasing
 * more than is reserved (older data) releases what there is, like the GREATEST(0, ...) it replaces.
 */
function planRelease(rows, quantity) {
  const plan = [];
  let remaining = quantity;
  for (const row of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, num(row.reserved_stock));
    if (take > 0) {
      plan.push({ id: row.id, quantity: take });
      remaining -= take;
    }
  }
  return plan;
}

async function applyEach(conn, plan, sql, paramsFor, what) {
  for (const step of plan) {
    const [result] = await conn.execute(sql, paramsFor(step));
    if (result.affectedRows !== 1) {
      // The rows are locked, so this means the data changed underneath us: abort the transaction.
      throw new Error(`Stock ${what} on inventory row ${step.id} did not apply`);
    }
  }
}

/**
 * Reserves `quantity` across the product's batch rows. Returns { reserved: true } or
 * { reserved: false, available } when the warehouse cannot cover it (nothing is written then).
 */
async function reserveStock(conn, { productId, warehouseId, quantity }) {
  const rows = await lockBatches(conn, productId, warehouseId);
  const plan = planReserve(rows, quantity);
  if (!plan) return { reserved: false, available: availableOf(rows) };
  await applyEach(
    conn,
    plan,
    `UPDATE inventories SET reserved_stock = reserved_stock + ?, last_movement_at = NOW()
     WHERE id = ? AND current_stock >= reserved_stock + ?`,
    (step) => [step.quantity, step.id, step.quantity],
    'reservation'
  );
  return { reserved: true };
}

/** Releases up to `quantity` of reservations; returns how much was released. */
async function releaseStock(conn, { productId, warehouseId, quantity }) {
  const rows = await lockBatches(conn, productId, warehouseId);
  const plan = planRelease(rows, quantity);
  await applyEach(
    conn,
    plan,
    `UPDATE inventories SET reserved_stock = reserved_stock - ?, last_movement_at = NOW()
     WHERE id = ? AND reserved_stock >= ?`,
    (step) => [step.quantity, step.id, step.quantity],
    'release'
  );
  return plan.reduce((sum, step) => sum + step.quantity, 0);
}

/**
 * Delivers `quantity`: removes it from on-hand and from reservations together. Returns false (and
 * writes nothing) when less than that is reserved.
 */
async function consumeReservedStock(conn, { productId, warehouseId, quantity }) {
  const rows = await lockBatches(conn, productId, warehouseId);
  const plan = planConsume(rows, quantity);
  if (!plan) return false;
  await applyEach(
    conn,
    plan,
    `UPDATE inventories
     SET current_stock = current_stock - ?, reserved_stock = reserved_stock - ?, last_movement_at = NOW()
     WHERE id = ? AND current_stock >= ? AND reserved_stock >= ?`,
    (step) => [step.quantity, step.quantity, step.id, step.quantity, step.quantity],
    'delivery'
  );
  return true;
}

module.exports = {
  availableOf,
  planReserve,
  planConsume,
  planRelease,
  lockBatches,
  reserveStock,
  releaseStock,
  consumeReservedStock,
};
