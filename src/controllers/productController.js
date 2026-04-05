const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const cache = require('../services/cacheService');

// GET /api/v1/products
const getProducts = asyncHandler(async (req, res) => {
  const { page, limit, search, category } = req.query;
  const params = [];
  let where = 'WHERE is_deleted = 0 AND is_active = 1';

  if (search) {
    where += ' AND (name LIKE ? OR sku LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    where += ' AND category = ?';
    params.push(category);
  }

  const baseQuery = `SELECT id, name, sku, category, retail_price, partner_price, unit, description, image_url, created_at, updated_at FROM products ${where} ORDER BY name ASC`;
  const countQuery = `SELECT COUNT(*) AS total FROM products ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// GET /api/v1/products/:id
const getProduct = asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, name, sku, category, retail_price, partner_price, unit, description, image_url, created_at, updated_at
     FROM products WHERE id = ? AND is_deleted = 0 LIMIT 1`,
    [req.params.id]
  );
  if (rows.length === 0) throw ApiError.notFound('Product not found');
  res.json({ success: true, data: rows[0] });
});

// POST /api/v1/products
const createProduct = asyncHandler(async (req, res) => {
  const { name, sku, category, retail_price, partner_price, unit, description } = req.body;

  const [existing] = await pool.execute(
    'SELECT id FROM products WHERE sku = ? AND is_deleted = 0 LIMIT 1', [sku]
  );
  if (existing.length > 0) throw ApiError.conflict('SKU already exists');

  const image_url = req.file ? req.file.path : null;

  const [result] = await pool.execute(
    `INSERT INTO products (name, sku, category, retail_price, partner_price, unit, description, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, sku, category || 'Drink Mixes', retail_price, partner_price, unit || '420g Boxes', description || null, image_url]
  );

  const [created] = await pool.execute('SELECT * FROM products WHERE id = ?', [result.insertId]);
  await cache.delPattern('products:*');

  res.status(201).json({ success: true, message: 'Product created', data: created[0] });
});

// PUT /api/v1/products/:id
const updateProduct = asyncHandler(async (req, res) => {
  const productId = req.params.id;
  const { name, sku, category, retail_price, partner_price, unit, description } = req.body;

  const [existing] = await pool.execute(
    'SELECT id FROM products WHERE id = ? AND is_deleted = 0 LIMIT 1', [productId]
  );
  if (existing.length === 0) throw ApiError.notFound('Product not found');

  if (sku) {
    const [dup] = await pool.execute(
      'SELECT id FROM products WHERE sku = ? AND id != ? AND is_deleted = 0 LIMIT 1', [sku, productId]
    );
    if (dup.length > 0) throw ApiError.conflict('SKU already exists');
  }

  const fields = [];
  const values = [];

  if (name) { fields.push('name = ?'); values.push(name); }
  if (sku) { fields.push('sku = ?'); values.push(sku); }
  if (category) { fields.push('category = ?'); values.push(category); }
  if (retail_price !== undefined) { fields.push('retail_price = ?'); values.push(retail_price); }
  if (partner_price !== undefined) { fields.push('partner_price = ?'); values.push(partner_price); }
  if (unit) { fields.push('unit = ?'); values.push(unit); }
  if (description !== undefined) { fields.push('description = ?'); values.push(description || null); }

  if (req.file) {
    fields.push('image_url = ?');
    values.push(req.file.path);
  }

  if (fields.length === 0) throw ApiError.badRequest('No fields to update');

  values.push(productId);
  await pool.execute(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, values);

  const [updated] = await pool.execute('SELECT * FROM products WHERE id = ?', [productId]);
  await cache.delPattern('products:*');

  res.json({ success: true, message: 'Product updated', data: updated[0] });
});

// DELETE /api/v1/products/:id (soft delete)
const deleteProduct = asyncHandler(async (req, res) => {
  const [existing] = await pool.execute(
    'SELECT id FROM products WHERE id = ? AND is_deleted = 0 LIMIT 1', [req.params.id]
  );
  if (existing.length === 0) throw ApiError.notFound('Product not found');

  await pool.execute('UPDATE products SET is_deleted = 1, is_active = 0 WHERE id = ?', [req.params.id]);
  await cache.delPattern('products:*');

  res.json({ success: true, message: 'Product deleted' });
});

module.exports = { getProducts, getProduct, createProduct, updateProduct, deleteProduct };
