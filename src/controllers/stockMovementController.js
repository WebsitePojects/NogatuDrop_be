const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');

// GET /api/v1/stock-movements — read-only event log
const getStockMovements = asyncHandler(async (req, res) => {
  const { page, limit, product_id, warehouse_id, movement_type, date_from, date_to } = req.query;
  const params = [];
  let where = 'WHERE 1=1';

  if (req.user.role_slug !== 'super_admin') {
    where += ' AND w.partner_id = ?';
    params.push(req.user.partner_id);
  }
  if (product_id) { where += ' AND sm.product_id = ?'; params.push(product_id); }
  if (warehouse_id) { where += ' AND sm.warehouse_id = ?'; params.push(warehouse_id); }
  if (movement_type) { where += ' AND sm.movement_type = ?'; params.push(movement_type); }
  if (date_from) { where += ' AND DATE(sm.created_at) >= ?'; params.push(date_from); }
  if (date_to) { where += ' AND DATE(sm.created_at) <= ?'; params.push(date_to); }

  const baseQuery = `
    SELECT sm.id, sm.product_id, p.name AS product_name, sm.warehouse_id, w.name AS warehouse_name,
           sm.movement_type, sm.quantity_change, sm.reference_type, sm.reference_id, sm.notes, sm.created_at
    FROM stock_movements sm
    JOIN products p ON p.id = sm.product_id
    JOIN warehouses w ON w.id = sm.warehouse_id
    ${where} ORDER BY sm.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total FROM stock_movements sm
    JOIN products p ON p.id = sm.product_id
    JOIN warehouses w ON w.id = sm.warehouse_id
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

module.exports = { getStockMovements };
