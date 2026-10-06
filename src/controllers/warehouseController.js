const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const { canonicalRole, ROLES } = require('../rbac/roles');
const { resolveAffiliationContext } = require('../rbac/affiliationScopes');
const { buildWarehouseListScope, canManageWarehouse } = require('../rbac/warehouseScopes');
const { resolveAddress, hasAddressParts, readCoordinates } = require('../services/addressInput');
const { addressPartsJoins, addressPartsSelect } = require('../utils/addressPartsSql');
const { withAdvisoryLock } = require('../utils/advisoryLock');

// warehouses.location is varchar(200); the composed address text is shortened to fit.
const LOCATION_MAX_LENGTH = 200;

async function getContext(req, db = pool) {
  return resolveAffiliationContext(db, req.user);
}

function defaultWarehouseTypeForContext(context) {
  if (canonicalRole(context?.partnerLevel) === ROLES.CITY_STOCKIST) return 'city';
  if (canonicalRole(context?.partnerLevel) === ROLES.PROVINCIAL_STOCKIST) return 'region';
  return 'region';
}

function mobileLocationQueries(where) {
  return {
    baseQuery: `
      SELECT ms.id, NULL AS warehouse_id, ms.partner_id,
             ms.name, 'mobile' AS type, ms.address AS location,
             NULL AS capacity_total, NULL AS capacity_used,
             NULL AS capacity_available, NULL AS capacity_percent,
             ms.name AS manager_name, ms.email AS manager_email, ms.phone AS manager_phone,
             ms.lat, ms.lng, (ms.status = 'active') AS is_active,
             ms.created_at, ms.updated_at,
             ${addressPartsSelect('ms', 'address')},
             p.business_name AS owner_stockist_name,
             'network' AS scope_kind, 'mobile_stockist' AS record_kind
      FROM mobile_stockists ms
      JOIN partners p ON p.id = ms.partner_id
      ${addressPartsJoins('ms')}
      ${where}
      ORDER BY ms.name ASC`,
    countQuery: `SELECT COUNT(*) AS total FROM mobile_stockists ms ${where}`,
  };
}

// GET /api/v1/warehouses?view=owned|network
const getWarehouses = asyncHandler(async (req, res) => {
  const { page, limit, search, type } = req.query;
  const view = req.query.view === 'network' ? 'network' : 'owned';
  const context = await getContext(req);
  const scope = buildWarehouseListScope(context, { view });
  const params = [...scope.params];

  if (scope.kind === 'mobile_stockists') {
    let where = `WHERE ms.is_deleted = 0${scope.clause}`;
    if (search) {
      where += ' AND (ms.name LIKE ? OR ms.address LIKE ? OR ms.region LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    const queries = mobileLocationQueries(where);
    const result = await paginate(queries.baseQuery, queries.countQuery, params, page, limit);
    return res.json({ success: true, scope_view: view, ...result });
  }

  let where = `WHERE w.is_deleted = 0${scope.clause}`;
  if (search) {
    where += ' AND (w.name LIKE ? OR w.location LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (type) {
    where += ' AND w.type = ?';
    params.push(type);
  }

  const baseQuery = `
    SELECT w.id, w.id AS warehouse_id, w.partner_id, w.name, w.type, w.location,
           w.capacity_total, w.capacity_used,
           (w.capacity_total - w.capacity_used) AS capacity_available,
           ROUND((w.capacity_used / NULLIF(w.capacity_total, 0)) * 100, 1) AS capacity_percent,
           w.manager_name, w.manager_email, w.manager_phone,
           w.lat, w.lng, w.is_active, w.created_at, w.updated_at,
           ${addressPartsSelect('w', 'location')},
           p.business_name AS owner_stockist_name,
           NULL AS scope_kind, 'warehouse' AS record_kind
    FROM warehouses w
    LEFT JOIN partners p ON p.id = w.partner_id
    ${addressPartsJoins('w')}
    ${where}
    ORDER BY w.name ASC`;
  const countQuery = `SELECT COUNT(*) AS total FROM warehouses w ${where}`;
  const result = await paginate(baseQuery, countQuery, params, page, limit);

  // paginate shares parameters between select and count, so scope_kind is
  // attached after the query rather than burdening the count query.
  result.data = result.data.map((warehouse) => ({ ...warehouse, scope_kind: view }));
  res.json({ success: true, scope_view: view, ...result });
});

async function findWarehouseForRead(req, warehouseId) {
  const context = await getContext(req);
  if (canonicalRole(context.role) === ROLES.SUPER_ADMIN) {
    const [rows] = await pool.execute(
      `SELECT w.*, ${addressPartsSelect('w', 'location')}
       FROM warehouses w ${addressPartsJoins('w')}
       WHERE w.id = ? AND w.is_deleted = 0 LIMIT 1`,
      [warehouseId]
    );
    return { context, warehouse: rows[0] || null };
  }

  const owned = buildWarehouseListScope(context, { view: 'owned' });
  const network = buildWarehouseListScope(context, { view: 'network' });
  const clauses = [owned, network].filter((scope) => scope.kind === 'warehouses');
  if (clauses.length === 0) return { context, warehouse: null };
  const predicate = clauses.map((scope) => `(1 = 1${scope.clause})`).join(' OR ');
  const params = clauses.flatMap((scope) => scope.params);
  const [rows] = await pool.execute(
    `SELECT w.*, ${addressPartsSelect('w', 'location')}
     FROM warehouses w ${addressPartsJoins('w')}
     WHERE w.id = ? AND w.is_deleted = 0 AND (${predicate}) LIMIT 1`,
    [warehouseId, ...params]
  );
  return { context, warehouse: rows[0] || null };
}

const getWarehouse = asyncHandler(async (req, res) => {
  const { warehouse } = await findWarehouseForRead(req, req.params.id);
  if (!warehouse) throw ApiError.notFound('Warehouse not found');
  res.json({ success: true, data: warehouse });
});

const createWarehouse = asyncHandler(async (req, res) => {
  const context = await getContext(req);
  const role = canonicalRole(context.role);
  const { name, type, capacity_total, manager_name, manager_email, manager_phone } = req.body;
  const partnerId = role === ROLES.SUPER_ADMIN ? null : context.partnerId;
  if (role === ROLES.SUPER_ADMIN && type && type !== 'manufacturer') {
    throw ApiError.forbidden('Super Admin can create only main manufacturer warehouses from this view');
  }
  if (role !== ROLES.SUPER_ADMIN && !partnerId) throw ApiError.forbidden('Stockist scope is required');
  if (role !== ROLES.SUPER_ADMIN && type === 'manufacturer') {
    throw ApiError.forbidden('Only Super Admin can create main manufacturer warehouses');
  }
  const warehouseType = role === ROLES.SUPER_ADMIN ? 'manufacturer' : (type || defaultWarehouseTypeForContext(context));

  const address = await resolveAddress(pool, req.body, { maxLength: LOCATION_MAX_LENGTH });
  const { lat, lng } = readCoordinates(req.body);

  // warehouses has no unique index on the name, so the lock is what makes a double-click or a retry
  // create one warehouse: the second request waits, finds the first, and gets a clean 409.
  const created = await withAdvisoryLock('warehouse-create', `${partnerId ?? 'company'}|${name.toLowerCase()}`, async (conn) => {
    const [duplicates] = await conn.execute(
      'SELECT id FROM warehouses WHERE partner_id <=> ? AND name = ? AND is_deleted = 0 LIMIT 1',
      [partnerId, name]
    );
    if (duplicates.length > 0) throw ApiError.conflict('A warehouse with this name already exists');
    const [result] = await conn.execute(
      `INSERT INTO warehouses
         (partner_id, name, type, location, address_line, barangay_code, postal_code,
          capacity_total, manager_name, manager_email, manager_phone, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [partnerId, name, warehouseType, address.text, address.addressLine, address.barangayCode, address.postalCode,
       capacity_total || 100000, manager_name, manager_email || null, manager_phone || null, lat, lng]
    );
    const [rows] = await conn.execute('SELECT * FROM warehouses WHERE id = ?', [result.insertId]);
    return rows[0];
  });
  res.status(201).json({ success: true, message: 'Warehouse created', data: created });
});

const updateWarehouse = asyncHandler(async (req, res) => {
  const warehouseId = req.params.id;
  const context = await getContext(req);
  const [existingRows] = await pool.execute(
    'SELECT id, partner_id, type FROM warehouses WHERE id = ? AND is_deleted = 0 LIMIT 1',
    [warehouseId]
  );
  if (existingRows.length === 0 || !canManageWarehouse(context, existingRows[0])) {
    throw ApiError.notFound('Warehouse not found');
  }

  const allowedFields = [
    'name', 'type', 'capacity_total', 'capacity_used', 'manager_name',
    'manager_email', 'manager_phone', 'lat', 'lng', 'is_active',
  ];
  const fields = [];
  const values = [];
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      if (field === 'type' && canonicalRole(context.role) !== ROLES.SUPER_ADMIN && req.body[field] === 'manufacturer') {
        throw ApiError.forbidden('Only Super Admin can manage main manufacturer warehouses');
      }
      fields.push(`${field} = ?`);
      values.push(req.body[field] === '' ? null : req.body[field]);
    }
  }
  // The street, barangay and postal code replace the stored address as a unit, and the old location
  // text is rewritten from them.
  if (hasAddressParts(req.body)) {
    const address = await resolveAddress(pool, req.body, { maxLength: LOCATION_MAX_LENGTH });
    fields.push('location = ?', 'address_line = ?', 'barangay_code = ?', 'postal_code = ?');
    values.push(address.text, address.addressLine, address.barangayCode, address.postalCode);
  }
  if (fields.length === 0) throw ApiError.badRequest('No fields to update');
  values.push(warehouseId);
  await pool.execute(`UPDATE warehouses SET ${fields.join(', ')} WHERE id = ?`, values);
  const [updated] = await pool.execute('SELECT * FROM warehouses WHERE id = ?', [warehouseId]);
  res.json({ success: true, message: 'Warehouse updated', data: updated[0] });
});

const deleteWarehouse = asyncHandler(async (req, res) => {
  const context = await getContext(req);
  const [existingRows] = await pool.execute(
    'SELECT id, partner_id, type FROM warehouses WHERE id = ? AND is_deleted = 0 LIMIT 1',
    [req.params.id]
  );
  if (existingRows.length === 0 || !canManageWarehouse(context, existingRows[0])) {
    throw ApiError.notFound('Warehouse not found');
  }
  await pool.execute('UPDATE warehouses SET is_deleted = 1, is_active = 0 WHERE id = ?', [req.params.id]);
  res.json({ success: true, message: 'Warehouse deleted' });
});

module.exports = { getWarehouses, getWarehouse, createWarehouse, updateWarehouse, deleteWarehouse };
