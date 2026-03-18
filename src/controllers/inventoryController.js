const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');

// GET /api/v1/inventory
const getInventory = asyncHandler(async (req, res) => {
  const { page, limit, search, warehouse_id, status: stockStatus } = req.query;
  const params = [];
  let where = 'WHERE i.is_active = 1 AND p.is_deleted = 0 AND w.is_deleted = 0';

  if (search) {
    where += ' AND (p.name LIKE ? OR p.sku LIKE ? OR w.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (warehouse_id) {
    where += ' AND i.warehouse_id = ?';
    params.push(warehouse_id);
  }
  if (stockStatus) {
    where += ' AND i.status = ?';
    params.push(stockStatus);
  }

  const baseQuery = `
    SELECT i.id, i.product_id, i.warehouse_id, i.partner_id,
           p.name AS product_name, p.sku, p.category, p.image_url,
           w.name AS warehouse_name, w.type AS warehouse_type, w.location,
           i.current_stock, i.reorder_threshold, i.status,
           i.batch_number, i.expiry_date, i.updated_at
    FROM inventories i
    JOIN products p ON p.id = i.product_id
    JOIN warehouses w ON w.id = i.warehouse_id
    ${where}
    ORDER BY i.updated_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM inventories i
    JOIN products p ON p.id = i.product_id
    JOIN warehouses w ON w.id = i.warehouse_id
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// GET /api/v1/inventory/:id
const getInventoryItem = asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT i.id, i.product_id, i.warehouse_id, i.partner_id,
            p.name AS product_name, p.sku, p.category, p.image_url,
            w.name AS warehouse_name, w.type AS warehouse_type, w.location,
            i.current_stock, i.reorder_threshold, i.status,
            i.batch_number, i.expiry_date, i.created_at, i.updated_at
     FROM inventories i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     WHERE i.id = ? AND i.is_active = 1
     LIMIT 1`,
    [req.params.id]
  );
  if (rows.length === 0) throw ApiError.notFound('Inventory item not found');
  res.json({ success: true, data: rows[0] });
});

// POST /api/v1/inventory
const addInventory = asyncHandler(async (req, res) => {
  const { product_id, warehouse_id, partner_id, current_stock, reorder_threshold, batch_number, expiry_date } = req.body;

  // Verify product and warehouse exist
  const [product] = await pool.execute('SELECT id FROM products WHERE id = ? AND is_deleted = 0', [product_id]);
  if (product.length === 0) throw ApiError.notFound('Product not found');

  const [warehouse] = await pool.execute('SELECT id FROM warehouses WHERE id = ? AND is_deleted = 0', [warehouse_id]);
  if (warehouse.length === 0) throw ApiError.notFound('Warehouse not found');

  const [result] = await pool.execute(
    `INSERT INTO inventories (product_id, warehouse_id, partner_id, current_stock, reorder_threshold, batch_number, expiry_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [product_id, warehouse_id, partner_id || null, current_stock || 0, reorder_threshold || 500, batch_number, expiry_date]
  );

  const [created] = await pool.execute(
    `SELECT i.*, p.name AS product_name, w.name AS warehouse_name
     FROM inventories i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     WHERE i.id = ?`,
    [result.insertId]
  );

  res.status(201).json({ success: true, message: 'Inventory added', data: created[0] });
});

// PUT /api/v1/inventory/:id
const updateInventory = asyncHandler(async (req, res) => {
  const inventoryId = req.params.id;
  const { current_stock, reorder_threshold, batch_number, expiry_date, is_active } = req.body;

  const [existing] = await pool.execute('SELECT id FROM inventories WHERE id = ? AND is_active = 1', [inventoryId]);
  if (existing.length === 0) throw ApiError.notFound('Inventory item not found');

  // Never update the `status` generated column
  const fields = [];
  const values = [];

  if (current_stock !== undefined) { fields.push('current_stock = ?'); values.push(current_stock); }
  if (reorder_threshold !== undefined) { fields.push('reorder_threshold = ?'); values.push(reorder_threshold); }
  if (batch_number) { fields.push('batch_number = ?'); values.push(batch_number); }
  if (expiry_date) { fields.push('expiry_date = ?'); values.push(expiry_date); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active); }

  if (fields.length === 0) throw ApiError.badRequest('No fields to update');

  values.push(inventoryId);
  await pool.execute(`UPDATE inventories SET ${fields.join(', ')} WHERE id = ?`, values);

  const [updated] = await pool.execute(
    `SELECT i.*, p.name AS product_name, w.name AS warehouse_name
     FROM inventories i
     JOIN products p ON p.id = i.product_id
     JOIN warehouses w ON w.id = i.warehouse_id
     WHERE i.id = ?`,
    [inventoryId]
  );

  res.json({ success: true, message: 'Inventory updated', data: updated[0] });
});

module.exports = { getInventory, getInventoryItem, addInventory, updateInventory };
