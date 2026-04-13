const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  (
    String(err.message || '').includes(`'${columnName}'`) ||
    String(err.message || '').includes(`.${columnName}'`) ||
    String(err.message || '').includes(columnName)
  )
);

const isCompatibilityColumnError = (err) => (
  isMissingColumn(err, 'quantity_change') ||
  isMissingColumn(err, 'before_stock') ||
  isMissingColumn(err, 'after_stock') ||
  isMissingColumn(err, 'w.partner_id') ||
  isMissingColumn(err, 'i.partner_id') ||
  isMissingColumn(err, 'sm.inventory_id')
);

// GET /api/v1/stock-movements — read-only event log
const getStockMovements = asyncHandler(async (req, res) => {
  const {
    page,
    limit,
    search,
    product_id,
    warehouse_id,
    movement_type,
    date_from,
    date_to,
  } = req.query;

  const buildQueries = ({ quantityField, includeStockColumns, partnerScope }) => {
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

    if (search) {
      where += ' AND (p.name LIKE ? OR p.sku LIKE ? OR w.name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (product_id) {
      where += ' AND sm.product_id = ?';
      params.push(product_id);
    }
    if (warehouse_id) {
      where += ' AND sm.warehouse_id = ?';
      params.push(warehouse_id);
    }
    if (movement_type) {
      where += ' AND sm.movement_type = ?';
      params.push(movement_type);
    }
    if (date_from) {
      where += ' AND DATE(sm.created_at) >= ?';
      params.push(date_from);
    }
    if (date_to) {
      where += ' AND DATE(sm.created_at) <= ?';
      params.push(date_to);
    }

    const stockBeforeExpr = includeStockColumns ? 'sm.before_stock' : 'NULL';
    const stockAfterExpr = includeStockColumns ? 'sm.after_stock' : 'NULL';

    return {
      baseQuery: `
        SELECT sm.id, sm.product_id, p.name AS product_name, p.sku,
               sm.warehouse_id, w.name AS warehouse_name,
               sm.movement_type,
               ${quantityField} AS quantity,
               ${stockBeforeExpr} AS stock_before,
               ${stockAfterExpr} AS stock_after,
               sm.reference_type, sm.reference_id, sm.notes, sm.created_at
        FROM stock_movements sm
        JOIN products p ON p.id = sm.product_id
        JOIN warehouses w ON w.id = sm.warehouse_id
        LEFT JOIN inventories i ON i.id = sm.inventory_id
        ${where} ORDER BY sm.created_at DESC`,
      countQuery: `
        SELECT COUNT(*) AS total
        FROM stock_movements sm
        JOIN products p ON p.id = sm.product_id
        JOIN warehouses w ON w.id = sm.warehouse_id
        LEFT JOIN inventories i ON i.id = sm.inventory_id
        ${where}`,
      params,
    };
  };

  const variants = [
    { quantityField: 'sm.quantity_change', includeStockColumns: true, partnerScope: 'warehouse' },
    { quantityField: 'sm.quantity', includeStockColumns: true, partnerScope: 'warehouse' },
    { quantityField: 'sm.quantity', includeStockColumns: true, partnerScope: 'inventory' },
    { quantityField: 'sm.quantity', includeStockColumns: false, partnerScope: 'inventory' },
    { quantityField: 'sm.quantity_change', includeStockColumns: false, partnerScope: 'inventory' },
  ];

  let result;
  let finalError = null;

  for (const variant of variants) {
    const q = buildQueries(variant);
    try {
      result = await paginate(q.baseQuery, q.countQuery, q.params, page, limit);
      finalError = null;
      break;
    } catch (err) {
      if (isCompatibilityColumnError(err)) {
        finalError = err;
        continue;
      }
      throw err;
    }
  }

  if (finalError) {
    throw finalError;
  }

  res.json({ success: true, ...result });
});

module.exports = { getStockMovements };
