const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');

// GET /api/v1/stock-adjustments
const getAdjustments = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const params = [];
  let where = 'WHERE sa.is_deleted = 0';

  if (req.user.role_slug !== 'super_admin') {
    where += ' AND w.partner_id = ?';
    params.push(req.user.partner_id);
  }
  if (status) { where += ' AND sa.status = ?'; params.push(status); }

  const baseQuery = `
    SELECT sa.id, sa.product_id, p.name AS product_name, sa.warehouse_id, w.name AS warehouse_name,
           sa.adjustment_type, sa.quantity, sa.reason, sa.status,
           sa.requested_by, ru.name AS requested_by_name,
           sa.approved_by, au.name AS approved_by_name,
           sa.created_at, sa.approved_at
    FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id
    JOIN warehouses w ON w.id = sa.warehouse_id
    LEFT JOIN users ru ON ru.id = sa.requested_by
    LEFT JOIN users au ON au.id = sa.approved_by
    ${where} ORDER BY sa.created_at DESC`;
  const countQuery = `SELECT COUNT(*) AS total FROM stock_adjustments sa
    JOIN products p ON p.id = sa.product_id JOIN warehouses w ON w.id = sa.warehouse_id ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// POST /api/v1/stock-adjustments — request an adjustment
const createAdjustment = asyncHandler(async (req, res) => {
  const { product_id, warehouse_id, adjustment_type, quantity, reason } = req.body;
  if (!product_id || !warehouse_id || !adjustment_type || !quantity) {
    throw ApiError.badRequest('product_id, warehouse_id, adjustment_type, and quantity are required');
  }
  if (!['add', 'remove', 'correction'].includes(adjustment_type)) {
    throw ApiError.badRequest('adjustment_type must be: add, remove, or correction');
  }

  const [result] = await pool.execute(
    `INSERT INTO stock_adjustments (product_id, warehouse_id, adjustment_type, quantity, reason, requested_by, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [product_id, warehouse_id, adjustment_type, quantity, reason || null, req.user.id]
  );
  res.status(201).json({ success: true, message: 'Adjustment requested', data: { id: result.insertId } });
});

// PATCH /api/v1/stock-adjustments/:id/approve — super_admin approves and applies
const approveAdjustment = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [rows] = await pool.execute(
    'SELECT * FROM stock_adjustments WHERE id = ? AND status = \'pending\' AND is_deleted = 0 LIMIT 1',
    [id]
  );
  if (rows.length === 0) throw ApiError.notFound('Pending adjustment not found');

  const adj = rows[0];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Apply to inventory
    const delta = adj.adjustment_type === 'remove' ? -adj.quantity : adj.quantity;
    await conn.execute(
      `UPDATE inventories SET current_stock = GREATEST(0, current_stock + ?) WHERE product_id = ? AND warehouse_id = ?`,
      [delta, adj.product_id, adj.warehouse_id]
    );

    // Log movement
    const movType = delta > 0 ? 'in' : 'out';
    await conn.execute(
      `INSERT INTO stock_movements (product_id, warehouse_id, movement_type, quantity_change, reference_type, reference_id, notes)
       VALUES (?, ?, ?, ?, 'adjustment', ?, ?)`,
      [adj.product_id, adj.warehouse_id, movType, Math.abs(delta), adj.id, adj.reason || 'Manual adjustment']
    );

    await conn.execute(
      `UPDATE stock_adjustments SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?`,
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

module.exports = { getAdjustments, createAdjustment, approveAdjustment };
