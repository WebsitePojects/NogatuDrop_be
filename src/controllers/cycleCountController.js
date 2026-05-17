const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const generateOrderNum = require('../utils/generateOrderNum');
const { insertStockMovement } = require('../utils/stockMovementLogger');
const { ROLES, canonicalRole } = require('../rbac/roles');

function isSuperAdmin(user) {
  return canonicalRole(user?.role_slug) === ROLES.SUPER_ADMIN;
}

function scopedWarehouseClause(user, alias = 'w') {
  if (isSuperAdmin(user)) {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return {
    clause: ` AND (${alias}.partner_id = ? OR EXISTS (
      SELECT 1 FROM inventories si
      WHERE si.warehouse_id = ${alias}.id
        AND si.partner_id = ?
    ))`,
    params: [user.partner_id, user.partner_id],
  };
}

async function getScopedWarehouse(db, user, warehouseId) {
  const scope = scopedWarehouseClause(user, 'w');
  const [rows] = await db.execute(
    `SELECT w.id, w.partner_id
     FROM warehouses w
     WHERE w.id = ? AND w.is_deleted = 0${scope.clause}
     LIMIT 1`,
    [warehouseId, ...scope.params]
  );
  return rows[0] || null;
}

async function getCycleCountItems(db, cycleCountId) {
  const [rows] = await db.execute(
    `SELECT cci.id, cci.product_id, p.name AS product_name, p.sku,
            cci.inventory_id, cci.system_qty, cci.counted_qty, cci.variance_qty, cci.notes,
            COALESCE(i.reserved_stock, 0) AS reserved_stock
     FROM cycle_count_items cci
     JOIN products p ON p.id = cci.product_id
     LEFT JOIN inventories i ON i.id = cci.inventory_id
     WHERE cci.cycle_count_id = ?
     ORDER BY p.name ASC`,
    [cycleCountId]
  );
  return rows;
}

const getCycleCounts = asyncHandler(async (req, res) => {
  const { page, limit, status, warehouse_id } = req.query;
  const scope = scopedWarehouseClause(req.user, 'w');
  const params = [...scope.params];
  let where = `WHERE cc.is_deleted = 0${scope.clause}`;

  if (status) {
    where += ' AND cc.status = ?';
    params.push(status);
  }
  if (warehouse_id) {
    where += ' AND cc.warehouse_id = ?';
    params.push(warehouse_id);
  }

  const baseQuery = `
    SELECT cc.id, cc.count_number, cc.warehouse_id, w.name AS warehouse_name,
           cc.status, cc.created_by, cu.name AS created_by_name,
           cc.reviewed_by, ru.name AS reviewed_by_name,
           cc.notes, cc.review_notes, cc.created_at, cc.submitted_at, cc.reviewed_at
    FROM cycle_counts cc
    JOIN warehouses w ON w.id = cc.warehouse_id
    JOIN users cu ON cu.id = cc.created_by
    LEFT JOIN users ru ON ru.id = cc.reviewed_by
    ${where}
    ORDER BY cc.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM cycle_counts cc
    JOIN warehouses w ON w.id = cc.warehouse_id
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

const getCycleCount = asyncHandler(async (req, res) => {
  const scope = scopedWarehouseClause(req.user, 'w');
  const [rows] = await pool.execute(
    `SELECT cc.id, cc.count_number, cc.warehouse_id, w.name AS warehouse_name,
            cc.status, cc.created_by, cu.name AS created_by_name,
            cc.reviewed_by, ru.name AS reviewed_by_name,
            cc.notes, cc.review_notes, cc.created_at, cc.submitted_at, cc.reviewed_at
     FROM cycle_counts cc
     JOIN warehouses w ON w.id = cc.warehouse_id
     JOIN users cu ON cu.id = cc.created_by
     LEFT JOIN users ru ON ru.id = cc.reviewed_by
     WHERE cc.id = ? AND cc.is_deleted = 0${scope.clause}
     LIMIT 1`,
    [req.params.id, ...scope.params]
  );
  if (rows.length === 0) throw ApiError.notFound('Cycle count not found');

  const data = rows[0];
  data.items = await getCycleCountItems(pool, data.id);
  res.json({ success: true, data });
});

const createCycleCount = asyncHandler(async (req, res) => {
  const { warehouse_id, items, notes } = req.body;
  if (!warehouse_id) throw ApiError.badRequest('warehouse_id is required');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const warehouse = await getScopedWarehouse(conn, req.user, warehouse_id);
    if (!warehouse) throw ApiError.notFound('Warehouse not found');

    const countNumber = await generateOrderNum('CC', 'cycle_counts', 'count_number');
    const [created] = await conn.execute(
      `INSERT INTO cycle_counts (count_number, warehouse_id, status, created_by, notes)
       VALUES (?, ?, 'draft', ?, ?)`,
      [countNumber, warehouse_id, req.user.id, notes || null]
    );
    const cycleCountId = created.insertId;

    let rows = Array.isArray(items) && items.length > 0 ? items : null;
    if (!rows) {
      const [inventoryRows] = await conn.execute(
        `SELECT i.id AS inventory_id, i.product_id, i.current_stock
         FROM inventories i
         WHERE i.warehouse_id = ? AND i.is_active = 1
         ORDER BY i.product_id ASC`,
        [warehouse_id]
      );
      rows = inventoryRows.map((row) => ({
        inventory_id: row.inventory_id,
        product_id: row.product_id,
        system_qty: Number(row.current_stock || 0),
        counted_qty: Number(row.current_stock || 0),
        notes: null,
      }));
    }

    for (const item of rows) {
      const [inventory] = await conn.execute(
        `SELECT i.id, i.current_stock
         FROM inventories i
         WHERE i.product_id = ? AND i.warehouse_id = ? AND i.is_active = 1
         LIMIT 1`,
        [item.product_id, warehouse_id]
      );
      const systemQty = item.system_qty !== undefined
        ? Number(item.system_qty)
        : Number(inventory[0]?.current_stock || 0);
      const countedQty = item.counted_qty !== undefined
        ? Number(item.counted_qty)
        : systemQty;

      await conn.execute(
        `INSERT INTO cycle_count_items (cycle_count_id, product_id, inventory_id, system_qty, counted_qty, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [cycleCountId, item.product_id, inventory[0]?.id || null, systemQty, countedQty, item.notes || null]
      );
    }

    await conn.commit();
    res.status(201).json({
      success: true,
      message: 'Cycle count created',
      data: { id: cycleCountId, count_number: countNumber },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

const updateCycleCountItems = asyncHandler(async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    throw ApiError.badRequest('items are required');
  }

  const scope = scopedWarehouseClause(req.user, 'w');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [counts] = await conn.execute(
      `SELECT cc.id
       FROM cycle_counts cc
       JOIN warehouses w ON w.id = cc.warehouse_id
       WHERE cc.id = ? AND cc.status = 'draft' AND cc.is_deleted = 0${scope.clause}
       LIMIT 1
       FOR UPDATE`,
      [req.params.id, ...scope.params]
    );

    if (counts.length === 0) {
      throw ApiError.badRequest('Cycle count is not editable');
    }

    for (const item of items) {
      const itemId = Number(item.id || item.item_id);
      const countedQty = Number(item.counted_qty);
      if (!Number.isInteger(itemId) || itemId <= 0) {
        throw ApiError.badRequest('Each item must include a valid id');
      }
      if (!Number.isFinite(countedQty) || countedQty < 0) {
        throw ApiError.badRequest('counted_qty must be zero or greater');
      }

      const [updated] = await conn.execute(
        `UPDATE cycle_count_items
         SET counted_qty = ?, notes = ?
         WHERE id = ? AND cycle_count_id = ?`,
        [countedQty, item.notes || null, itemId, req.params.id]
      );

      if (updated.affectedRows === 0) {
        throw ApiError.badRequest(`Cycle count item ${itemId} was not found`);
      }
    }

    await conn.commit();
    res.json({ success: true, message: 'Cycle count items updated' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

const submitCycleCount = asyncHandler(async (req, res) => {
  const scope = scopedWarehouseClause(req.user, 'w');
  const [result] = await pool.execute(
    `UPDATE cycle_counts cc
     JOIN warehouses w ON w.id = cc.warehouse_id
     SET cc.status = 'submitted', cc.submitted_by = ?, cc.submitted_at = NOW(), cc.updated_at = NOW()
     WHERE cc.id = ? AND cc.status = 'draft' AND cc.is_deleted = 0${scope.clause}`,
    [req.user.id, req.params.id, ...scope.params]
  );
  if (result.affectedRows === 0) throw ApiError.badRequest('Cycle count is not eligible for submission');
  res.json({ success: true, message: 'Cycle count submitted' });
});

const approveCycleCount = asyncHandler(async (req, res) => {
  const { review_notes } = req.body;
  const cycleCountId = req.params.id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [counts] = await conn.execute(
      `SELECT cc.*, w.partner_id AS warehouse_partner_id
       FROM cycle_counts cc
       JOIN warehouses w ON w.id = cc.warehouse_id
       WHERE cc.id = ? AND cc.is_deleted = 0
       LIMIT 1
       FOR UPDATE`,
      [cycleCountId]
    );
    if (counts.length === 0) throw ApiError.notFound('Cycle count not found');
    if (counts[0].status !== 'submitted') throw ApiError.badRequest('Cycle count must be submitted before approval');

    const count = counts[0];
    const items = await getCycleCountItems(conn, cycleCountId);

    for (const item of items) {
      if (Number(item.variance_qty || 0) === 0) continue;
      if (item.inventory_id && Number(item.counted_qty) < Number(item.reserved_stock || 0)) {
        throw ApiError.badRequest(
          `Counted quantity for ${item.product_name} cannot be below reserved stock (${item.reserved_stock})`
        );
      }

      if (item.inventory_id) {
        await conn.execute(
          `UPDATE inventories
           SET current_stock = ?, last_movement_at = NOW()
           WHERE id = ?`,
          [item.counted_qty, item.inventory_id]
        );
      } else {
        await conn.execute(
          `INSERT INTO inventories (product_id, warehouse_id, partner_id, current_stock, last_movement_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [item.product_id, count.warehouse_id, count.warehouse_partner_id || null, item.counted_qty]
        );
      }

      await insertStockMovement(conn, {
        productId: item.product_id,
        warehouseId: count.warehouse_id,
        movementType: Number(item.variance_qty) >= 0 ? 'cycle_count_increase' : 'cycle_count_decrease',
        quantity: Math.abs(Number(item.variance_qty)),
        referenceType: 'cycle_count',
        referenceId: cycleCountId,
        notes: `Cycle count approved. System ${item.system_qty}, counted ${item.counted_qty}`,
        createdBy: req.user.id,
      });
    }

    await conn.execute(
      `UPDATE cycle_counts
       SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?, updated_at = NOW()
       WHERE id = ?`,
      [req.user.id, review_notes || null, cycleCountId]
    );

    await conn.commit();
    res.json({ success: true, message: 'Cycle count approved and inventory adjusted' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

const rejectCycleCount = asyncHandler(async (req, res) => {
  const { review_notes } = req.body;
  const [result] = await pool.execute(
    `UPDATE cycle_counts
     SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), review_notes = ?, updated_at = NOW()
     WHERE id = ? AND status = 'submitted' AND is_deleted = 0`,
    [req.user.id, review_notes || null, req.params.id]
  );
  if (result.affectedRows === 0) throw ApiError.badRequest('Cycle count is not eligible for rejection');
  res.json({ success: true, message: 'Cycle count rejected' });
});

module.exports = {
  getCycleCounts,
  getCycleCount,
  createCycleCount,
  updateCycleCountItems,
  submitCycleCount,
  approveCycleCount,
  rejectCycleCount,
};
