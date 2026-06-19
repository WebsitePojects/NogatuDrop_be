const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const { appendPartnerScope } = require('../rbac/resourceScopes');

// GET /api/v1/warehouses
const getWarehouses = asyncHandler(async (req, res) => {
  const { page, limit, search, type } = req.query;
  const params = [];
  let where = 'WHERE w.is_deleted = 0';
  where = appendPartnerScope({
    where,
    params,
    user: req.user,
    condition: `EXISTS (
      SELECT 1 FROM inventories i
      WHERE i.warehouse_id = w.id AND i.is_active = 1 AND i.partner_id = ?
    )`,
  });

  if (search) {
    where += ' AND (w.name LIKE ? OR w.location LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (type) {
    where += ' AND w.type = ?';
    params.push(type);
  }

  const baseQuery = `
    SELECT w.id, w.name, w.type, w.location, w.capacity_total, w.capacity_used,
           (w.capacity_total - w.capacity_used) AS capacity_available,
           ROUND((w.capacity_used / w.capacity_total) * 100, 1) AS capacity_percent,
           w.manager_name, w.manager_email, w.manager_phone,
           w.lat, w.lng, w.is_active, w.created_at, w.updated_at
    FROM warehouses w
    ${where}
    ORDER BY w.name ASC`;

  const countQuery = `SELECT COUNT(*) AS total FROM warehouses w ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// GET /api/v1/warehouses/:id
const getWarehouse = asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT w.id, w.name, w.type, w.location, w.capacity_total, w.capacity_used,
            (w.capacity_total - w.capacity_used) AS capacity_available,
            ROUND((w.capacity_used / w.capacity_total) * 100, 1) AS capacity_percent,
            w.manager_name, w.manager_email, w.manager_phone,
            w.lat, w.lng, w.is_active, w.created_at, w.updated_at
     FROM warehouses w
     WHERE w.id = ? AND w.is_deleted = 0
       AND (
         ? = 'super_admin'
         OR EXISTS (
           SELECT 1 FROM inventories i
           WHERE i.warehouse_id = w.id AND i.is_active = 1 AND i.partner_id = ?
         )
       )
     LIMIT 1`,
    [req.params.id, req.user.role_slug, req.user.partner_id || null]
  );
  if (rows.length === 0) throw ApiError.notFound('Warehouse not found');
  res.json({ success: true, data: rows[0] });
});

// POST /api/v1/warehouses
const createWarehouse = asyncHandler(async (req, res) => {
  const {
    name,
    type,
    location,
    address,
    city,
    province,
    region,
    capacity_total,
    capacity,
    manager_name,
    manager_email,
    manager_phone,
    lat,
    lng,
  } = req.body;
  const normalizedLocation = location || [address, city, province, region].filter(Boolean).join(', ') || null;
  const normalizedCapacity = capacity_total ?? capacity ?? 100000;

  const [result] = await pool.execute(
    `INSERT INTO warehouses (name, type, location, capacity_total, manager_name, manager_email, manager_phone, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      type || 'region',
      normalizedLocation,
      normalizedCapacity,
      manager_name,
      manager_email || null,
      manager_phone || null,
      lat || null,
      lng || null,
    ]
  );

  const [created] = await pool.execute('SELECT * FROM warehouses WHERE id = ?', [result.insertId]);
  res.status(201).json({ success: true, message: 'Warehouse created', data: created[0] });
});

// PUT /api/v1/warehouses/:id
const updateWarehouse = asyncHandler(async (req, res) => {
  const warehouseId = req.params.id;
  const {
    name,
    type,
    location,
    address,
    city,
    province,
    region,
    capacity_total,
    capacity,
    capacity_used,
    manager_name,
    manager_email,
    manager_phone,
    lat,
    lng,
    is_active,
  } = req.body;
  const normalizedLocation = location || [address, city, province, region].filter(Boolean).join(', ');

  const [existing] = await pool.execute('SELECT id FROM warehouses WHERE id = ? AND is_deleted = 0', [warehouseId]);
  if (existing.length === 0) throw ApiError.notFound('Warehouse not found');

  const fields = [];
  const values = [];

  if (name) { fields.push('name = ?'); values.push(name); }
  if (type) { fields.push('type = ?'); values.push(type); }
  if (normalizedLocation) { fields.push('location = ?'); values.push(normalizedLocation); }
  if (capacity_total !== undefined || capacity !== undefined) {
    fields.push('capacity_total = ?');
    values.push(capacity_total ?? capacity);
  }
  if (capacity_used !== undefined) { fields.push('capacity_used = ?'); values.push(capacity_used); }
  if (manager_name) { fields.push('manager_name = ?'); values.push(manager_name); }
  if (manager_email !== undefined) { fields.push('manager_email = ?'); values.push(manager_email || null); }
  if (manager_phone !== undefined) { fields.push('manager_phone = ?'); values.push(manager_phone || null); }
  if (lat !== undefined) { fields.push('lat = ?'); values.push(lat); }
  if (lng !== undefined) { fields.push('lng = ?'); values.push(lng); }
  if (is_active !== undefined) { fields.push('is_active = ?'); values.push(is_active); }

  if (fields.length === 0) throw ApiError.badRequest('No fields to update');

  values.push(warehouseId);
  await pool.execute(`UPDATE warehouses SET ${fields.join(', ')} WHERE id = ?`, values);

  const [updated] = await pool.execute('SELECT * FROM warehouses WHERE id = ?', [warehouseId]);
  res.json({ success: true, message: 'Warehouse updated', data: updated[0] });
});

// DELETE /api/v1/warehouses/:id (soft delete)
const deleteWarehouse = asyncHandler(async (req, res) => {
  const [existing] = await pool.execute('SELECT id FROM warehouses WHERE id = ? AND is_deleted = 0', [req.params.id]);
  if (existing.length === 0) throw ApiError.notFound('Warehouse not found');

  await pool.execute('UPDATE warehouses SET is_deleted = 1, is_active = 0 WHERE id = ?', [req.params.id]);
  res.json({ success: true, message: 'Warehouse deleted' });
});

module.exports = { getWarehouses, getWarehouse, createWarehouse, updateWarehouse, deleteWarehouse };
