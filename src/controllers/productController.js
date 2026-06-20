const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const cache = require('../services/cacheService');
const { canonicalRole, ROLES } = require('../rbac/roles');

const ORDERING_ROLES = new Set([
  ROLES.PROVINCIAL_STOCKIST,
  ROLES.CITY_STOCKIST,
  ROLES.MOBILE_STOCKIST,
]);

const isMissingSoftDeleteColumn = (err) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes("'is_deleted'")
);

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

async function executeSoftDeleteAware(db, primarySql, params = [], fallbackSql = null) {
  try {
    return await db.execute(primarySql, params);
  } catch (err) {
    if (isMissingSoftDeleteColumn(err) && fallbackSql) {
      return db.execute(fallbackSql, params);
    }
    throw err;
  }
}

function isAvailabilityScopedUser(user) {
  return ORDERING_ROLES.has(canonicalRole(user?.role_slug)) && Number(user?.partner_id) > 0;
}

async function getWarehouseIdByPartner(db, partnerId) {
  if (!partnerId) return null;

  try {
    const [rows] = await executeSoftDeleteAware(
      db,
      'SELECT id FROM warehouses WHERE partner_id = ? AND is_deleted = 0 LIMIT 1',
      [partnerId],
      'SELECT id FROM warehouses WHERE partner_id = ? LIMIT 1'
    );
    return rows[0]?.id || null;
  } catch (err) {
    if (!isMissingColumn(err, 'partner_id') && !isMissingColumn(err, 'w.partner_id')) {
      throw err;
    }
  }

  try {
    const [rows] = await db.execute(
      'SELECT warehouse_id AS id FROM inventories WHERE partner_id = ? AND is_active = 1 ORDER BY warehouse_id ASC LIMIT 1',
      [partnerId]
    );
    return rows[0]?.id || null;
  } catch (err) {
    if (!isMissingColumn(err, 'is_active')) {
      throw err;
    }
  }

  const [rows] = await db.execute(
    'SELECT warehouse_id AS id FROM inventories WHERE partner_id = ? ORDER BY warehouse_id ASC LIMIT 1',
    [partnerId]
  );
  return rows[0]?.id || null;
}

async function resolveSourceWarehouseIdForPartner(db, partnerId) {
  if (!partnerId) return null;

  const [partners] = await executeSoftDeleteAware(
    db,
    'SELECT id, parent_partner_id, stockist_level FROM partners WHERE id = ? AND is_deleted = 0 LIMIT 1',
    [partnerId],
    'SELECT id, parent_partner_id, stockist_level FROM partners WHERE id = ? LIMIT 1'
  );
  if (partners.length === 0) return null;

  const partner = partners[0];

  if (partner.stockist_level === 'city_stockist' && partner.parent_partner_id) {
    return getWarehouseIdByPartner(db, partner.parent_partner_id);
  }

  if (partner.stockist_level === 'provincial_stockist') {
    const [rows] = await executeSoftDeleteAware(
      db,
      "SELECT id FROM warehouses WHERE type = 'manufacturer' AND is_deleted = 0 LIMIT 1",
      [],
      "SELECT id FROM warehouses WHERE type = 'manufacturer' LIMIT 1"
    );
    return rows[0]?.id || null;
  }

  return getWarehouseIdByPartner(db, partner.id);
}

async function getAvailabilityByProductIds(db, sourceWarehouseId, productIds) {
  if (!sourceWarehouseId || !Array.isArray(productIds) || productIds.length === 0) {
    return new Map();
  }

  const uniqueProductIds = [...new Set(
    productIds
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
  )];

  if (uniqueProductIds.length === 0) {
    return new Map();
  }

  const placeholders = uniqueProductIds.map(() => '?').join(', ');
  let rows;

  try {
    [rows] = await db.execute(
      `SELECT product_id, current_stock, reserved_stock
       FROM inventories
       WHERE warehouse_id = ?
         AND product_id IN (${placeholders})
         AND is_deleted = 0`,
      [sourceWarehouseId, ...uniqueProductIds]
    );
  } catch (err) {
    if (!isMissingSoftDeleteColumn(err)) {
      throw err;
    }

    [rows] = await db.execute(
      `SELECT product_id, current_stock, reserved_stock
       FROM inventories
       WHERE warehouse_id = ?
         AND product_id IN (${placeholders})`,
      [sourceWarehouseId, ...uniqueProductIds]
    );
  }

  return new Map(
    rows.map((row) => [
      Number(row.product_id),
      Math.max(0, Number(row.current_stock || 0) - Number(row.reserved_stock || 0)),
    ])
  );
}

function annotateProductsWithAvailability(products, availabilityByProductId, sourceWarehouseId) {
  return products.map((product) => {
    const availableQty = availabilityByProductId.get(Number(product.id)) || 0;
    return {
      ...product,
      source_warehouse_id: sourceWarehouseId || null,
      available_qty: availableQty,
      is_orderable: availableQty > 0,
    };
  });
}

async function scopeProductsForOrderingUser(db, user, products) {
  if (!isAvailabilityScopedUser(user) || !Array.isArray(products) || products.length === 0) {
    return products;
  }

  const sourceWarehouseId = await resolveSourceWarehouseIdForPartner(db, user.partner_id);
  const availabilityByProductId = await getAvailabilityByProductIds(
    db,
    sourceWarehouseId,
    products.map((product) => product.id)
  );

  return annotateProductsWithAvailability(products, availabilityByProductId, sourceWarehouseId);
}

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
  result.data = await scopeProductsForOrderingUser(pool, req.user, result.data);
  res.json({ success: true, ...result });
});

async function scopePublicProducts(db, products) {
  if (!Array.isArray(products) || products.length === 0) {
    return products;
  }

  // Get active candidate warehouses
  let candidateWarehouseIds = [];
  try {
    const [rows] = await db.execute(
      `SELECT w.id AS warehouse_id
       FROM partners p
       JOIN warehouses w ON w.partner_id = p.id
       WHERE p.stockist_level IN ('city_stockist', 'provincial_stockist')
         AND p.is_deleted = 0 AND w.is_deleted = 0`
    );
    candidateWarehouseIds = rows.map((r) => r.warehouse_id);
  } catch (err) {
    try {
      const [rows] = await db.execute(
        `SELECT w.id AS warehouse_id
         FROM partners p
         JOIN warehouses w ON w.partner_id = p.id
         WHERE p.stockist_level IN ('city_stockist', 'provincial_stockist')`
      );
      candidateWarehouseIds = rows.map((r) => r.warehouse_id);
    } catch (innerErr) {
      return products.map(p => ({ ...p, available_qty: 999, is_orderable: true }));
    }
  }

  if (candidateWarehouseIds.length === 0) {
    return products.map(p => ({ ...p, available_qty: 0, is_orderable: false }));
  }

  const productIds = products.map((p) => p.id);
  const placeholders = productIds.map(() => '?').join(', ');
  const warehousePlaceholders = candidateWarehouseIds.map(() => '?').join(', ');

  let inventoryRows = [];
  try {
    [inventoryRows] = await db.execute(
      `SELECT product_id, current_stock, reserved_stock
       FROM inventories
       WHERE warehouse_id IN (${warehousePlaceholders})
         AND product_id IN (${placeholders})
         AND is_deleted = 0`,
      [...candidateWarehouseIds, ...productIds]
    );
  } catch (err) {
    try {
      [inventoryRows] = await db.execute(
        `SELECT product_id, current_stock, reserved_stock
         FROM inventories
         WHERE warehouse_id IN (${warehousePlaceholders})
           AND product_id IN (${placeholders})`,
        [...candidateWarehouseIds, ...productIds]
      );
    } catch (innerErr) {
      return products.map(p => ({ ...p, available_qty: 999, is_orderable: true }));
    }
  }

  const stockMap = new Map();
  for (const row of inventoryRows) {
    const pId = Number(row.product_id);
    const available = Math.max(0, Number(row.current_stock || 0) - Number(row.reserved_stock || 0));
    stockMap.set(pId, (stockMap.get(pId) || 0) + available);
  }

  return products.map((product) => {
    const availableQty = stockMap.get(Number(product.id)) || 0;
    return {
      ...product,
      available_qty: availableQty,
      is_orderable: availableQty > 0,
    };
  });
}

// GET /api/v1/products/public
const getPublicProducts = asyncHandler(async (req, res) => {
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

  const baseQuery = `
    SELECT id, name, category, retail_price, unit, description, image_url
    FROM products ${where}
    ORDER BY name ASC`;
  const countQuery = `SELECT COUNT(*) AS total FROM products ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  result.data = await scopePublicProducts(pool, result.data);
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

  const [product] = await scopeProductsForOrderingUser(pool, req.user, rows);
  res.json({ success: true, data: product });
});

// POST /api/v1/products
const createProduct = asyncHandler(async (req, res) => {
  const { name, sku, category, retail_price, partner_price, unit, description, is_active } = req.body;

  const [existing] = await pool.execute(
    'SELECT id FROM products WHERE sku = ? AND is_deleted = 0 LIMIT 1', [sku]
  );
  if (existing.length > 0) throw ApiError.conflict('SKU already exists');

  const image_url = req.file ? req.file.path : null;

  const [result] = await pool.execute(
    `INSERT INTO products (name, sku, category, retail_price, partner_price, unit, description, image_url, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      sku,
      category || 'Drink Mixes',
      retail_price,
      partner_price,
      unit || '420g Boxes',
      description || null,
      image_url,
      is_active === undefined ? 1 : Number(is_active === true || is_active === 'true' || is_active === 1 || is_active === '1'),
    ]
  );

  const [created] = await pool.execute('SELECT * FROM products WHERE id = ?', [result.insertId]);
  await cache.delPattern('products:*');

  res.status(201).json({ success: true, message: 'Product created', data: created[0] });
});

// PUT /api/v1/products/:id
const updateProduct = asyncHandler(async (req, res) => {
  const productId = req.params.id;
  const { name, sku, category, retail_price, partner_price, unit, description, is_active } = req.body;

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
  if (is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(Number(is_active === true || is_active === 'true' || is_active === 1 || is_active === '1'));
  }

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

module.exports = {
  getProducts,
  getPublicProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  __testables: {
    annotateProductsWithAvailability,
    isAvailabilityScopedUser,
  },
};
