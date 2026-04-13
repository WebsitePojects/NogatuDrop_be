const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const { insertStockMovement } = require('../utils/stockMovementLogger');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

const normalizeAdjustmentType = (rawType) => {
  const t = String(rawType || '').trim().toLowerCase();
  if (t === 'remove') return 'subtract';
  if (t === 'correction') return 'set';
  return t;
};

async function resolveInventoryId(db, { inventoryId, productId, warehouseId }) {
  if (inventoryId) return Number(inventoryId);
  if (!productId || !warehouseId) return null;

  const [rows] = await db.execute(
    'SELECT id FROM inventories WHERE product_id = ? AND warehouse_id = ? LIMIT 1',
    [productId, warehouseId]
  );
  return rows[0]?.id || null;
}

// GET /api/v1/stock-adjustments
const getAdjustments = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const buildQueries = (partnerScope = 'inventory') => {
    const params = [];
    let where = 'WHERE 1=1';

    if (req.user.role_slug !== 'super_admin') {
      if (partnerScope === 'warehouse') {
        where += ' AND w.partner_id = ?';
      } else {
        where += ' AND i.partner_id = ?';
      }
      params.push(req.user.partner_id);
    }
    if (status) {
      where += ' AND sa.status = ?';
      params.push(status);
    }

    return {
      baseQuery: `
        SELECT sa.id, sa.inventory_id,
               i.product_id, i.warehouse_id,
               p.name AS product_name,
               w.name AS warehouse_name,
               sa.adjustment_type AS type,
               sa.quantity, sa.reason, sa.status,
               sa.requested_by, ru.name AS requested_by_name,
               sa.reviewed_by AS approved_by, au.name AS approved_by_name,
               sa.reviewed_at AS approved_at,
               sa.rejection_reason,
               sa.created_at, sa.updated_at
        FROM stock_adjustments sa
        JOIN inventories i ON i.id = sa.inventory_id
        JOIN products p ON p.id = i.product_id
        JOIN warehouses w ON w.id = i.warehouse_id
        LEFT JOIN users ru ON ru.id = sa.requested_by
        LEFT JOIN users au ON au.id = sa.reviewed_by
        ${where} ORDER BY sa.created_at DESC`,
      countQuery: `
        SELECT COUNT(*) AS total
        FROM stock_adjustments sa
        JOIN inventories i ON i.id = sa.inventory_id
        JOIN products p ON p.id = i.product_id
        JOIN warehouses w ON w.id = i.warehouse_id
        ${where}`,
      params,
    };
  };

  let result;
  const primary = buildQueries('inventory');
  try {
    result = await paginate(primary.baseQuery, primary.countQuery, primary.params, page, limit);
  } catch (err) {
    if (!(req.user.role_slug !== 'super_admin' && isMissingColumn(err, 'i.partner_id'))) {
      throw err;
    }

    const fallback = buildQueries('warehouse');
    result = await paginate(fallback.baseQuery, fallback.countQuery, fallback.params, page, limit);
  }

  res.json({ success: true, ...result });
});

// POST /api/v1/stock-adjustments — request an adjustment
const createAdjustment = asyncHandler(async (req, res) => {
  const quantity = Number(req.body.quantity);
  const type = normalizeAdjustmentType(req.body.type || req.body.adjustment_type);

  const inventoryId = await resolveInventoryId(pool, {
    inventoryId: req.body.inventory_id,
    productId: req.body.product_id,
    warehouseId: req.body.warehouse_id,
  });

  if (!inventoryId || !type || !Number.isFinite(quantity)) {
    throw ApiError.badRequest('inventory_id (or product_id + warehouse_id), type, and quantity are required');
  }

  if (!['add', 'subtract', 'set'].includes(type)) {
    throw ApiError.badRequest('type must be one of: add, subtract, set');
  }

  if (quantity < 0) {
    throw ApiError.badRequest('quantity cannot be negative');
  }

  // Ensure inventory exists and follows partner scope for non-super users
  const invParams = [inventoryId];
  let invWhere = 'WHERE i.id = ?';
  if (req.user.role_slug !== 'super_admin') {
    invWhere += ' AND i.partner_id = ?';
    invParams.push(req.user.partner_id);
  }

  const [inventoryRows] = await pool.execute(
    `SELECT i.id FROM inventories i ${invWhere} LIMIT 1`,
    invParams
  );

  if (inventoryRows.length === 0) {
    throw ApiError.notFound('Inventory item not found for this user scope');
  }

  const [result] = await pool.execute(
    `INSERT INTO stock_adjustments (inventory_id, adjustment_type, quantity, reason, requested_by, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [inventoryId, type, quantity, req.body.reason || null, req.user.id]
  );

  res.status(201).json({ success: true, message: 'Adjustment requested', data: { id: result.insertId } });
});

// PATCH /api/v1/stock-adjustments/:id/approve — super_admin approves and applies
const approveAdjustment = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [rows] = await pool.execute(
    `SELECT sa.*, i.product_id, i.warehouse_id, i.current_stock
     FROM stock_adjustments sa
     JOIN inventories i ON i.id = sa.inventory_id
     WHERE sa.id = ? AND sa.status = 'pending'
     LIMIT 1`,
    [id]
  );
  if (rows.length === 0) throw ApiError.notFound('Pending adjustment not found');

  const adj = rows[0];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Apply to inventory
    let delta = 0;
    if (adj.adjustment_type === 'add') {
      delta = Number(adj.quantity);
      await conn.execute(
        `UPDATE inventories
         SET current_stock = GREATEST(0, current_stock + ?),
             last_movement_at = NOW()
         WHERE id = ?`,
        [delta, adj.inventory_id]
      );
    } else if (adj.adjustment_type === 'subtract') {
      delta = -Number(adj.quantity);
      await conn.execute(
        `UPDATE inventories
         SET current_stock = GREATEST(0, current_stock - ?),
             last_movement_at = NOW()
         WHERE id = ?`,
        [Math.abs(delta), adj.inventory_id]
      );
    } else {
      const target = Math.max(0, Number(adj.quantity));
      delta = target - Number(adj.current_stock || 0);
      await conn.execute(
        `UPDATE inventories
         SET current_stock = ?,
             last_movement_at = NOW()
         WHERE id = ?`,
        [target, adj.inventory_id]
      );
    }

    // Log movement
    await insertStockMovement(conn, {
      productId: adj.product_id,
      warehouseId: adj.warehouse_id,
      movementType: 'adjustment',
      quantity: delta,
      referenceType: 'adjustment',
      referenceId: adj.id,
      notes: adj.reason || 'Manual adjustment',
      createdBy: req.user.id,
    });

    await conn.execute(
      `UPDATE stock_adjustments
       SET status = 'approved', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = NULL
       WHERE id = ?`,
      [req.user.id, id]
    );

    await conn.commit();
    res.json({ success: true, message: 'Adjustment approved and applied' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/stock-adjustments/:id/reject — super_admin rejects request
const rejectAdjustment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const reason = req.body?.reason || null;

  const [rows] = await pool.execute(
    `SELECT id FROM stock_adjustments WHERE id = ? AND status = 'pending' LIMIT 1`,
    [id]
  );
  if (rows.length === 0) throw ApiError.notFound('Pending adjustment not found');

  await pool.execute(
    `UPDATE stock_adjustments
     SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = ?
     WHERE id = ?`,
    [req.user.id, reason, id]
  );

  res.json({ success: true, message: 'Adjustment rejected' });
});

module.exports = { getAdjustments, createAdjustment, approveAdjustment, rejectAdjustment };
