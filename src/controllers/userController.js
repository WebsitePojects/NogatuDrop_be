const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const { resolveUserAssignment } = require('../rbac/userAssignments');
const normalizeRoleSlug = require('../utils/normalizeRoleSlug');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isMissingColumnError = (err) => err && err.code === 'ER_BAD_FIELD_ERROR';
const isDupEntryError = (err) => err && err.code === 'ER_DUP_ENTRY';

async function getWarehouseById(id) {
  const [rows] = await pool.execute(
    'SELECT id, partner_id FROM warehouses WHERE id = ? AND is_deleted = 0 LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function getRoleBySlug(slug) {
  const [rows] = await pool.execute('SELECT id, slug FROM roles WHERE slug = ? LIMIT 1', [slug]);
  return rows[0] || null;
}

async function getRoleById(id) {
  const [rows] = await pool.execute('SELECT id, slug FROM roles WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function getPartnerById(id) {
  const [rows] = await pool.execute(
    `SELECT id, business_name, stockist_level, status, is_deleted
     FROM partners
     WHERE id = ?
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

// GET /api/v1/users
const getUsers = asyncHandler(async (req, res) => {
  const { page, limit, search, role, status } = req.query;
  const params = [];
  let where = 'WHERE u.is_deleted = 0';

  // Scope: admin/staff only see users in their partner
  if (req.user.role_slug !== 'super_admin') {
    if (req.user.partner_id) {
      where += ' AND u.partner_id = ?';
      params.push(req.user.partner_id);
    } else {
      where += ' AND u.id = ?';
      params.push(req.user.id);
    }
  }

  if (search) {
    where += ' AND (u.name LIKE ? OR u.email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (role) {
    where += ' AND r.slug = ?';
    params.push(role);
  }
  if (status) {
    where += ' AND u.status = ?';
    params.push(status);
  }

  const baseQuery = `
    SELECT u.id, u.name, u.email, u.phone, u.level, u.location, u.status,
           u.last_login, u.created_at, u.updated_at,
           r.name AS role_name, r.slug AS role_slug,
           p.business_name AS partner_name, u.partner_id,
           u.warehouse_id, w.name AS warehouse_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN partners p ON p.id = u.partner_id
    LEFT JOIN warehouses w ON w.id = u.warehouse_id
    ${where}
    ORDER BY u.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN partners p ON p.id = u.partner_id
    ${where}`;

  try {
    const result = await paginate(baseQuery, countQuery, params, page, limit);
    res.json({ success: true, ...result });
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;

    const fallbackBaseQuery = `
      SELECT u.id, u.name, u.email, u.phone, u.level, u.location, u.status,
             u.last_login, u.created_at, u.updated_at,
             r.name AS role_name, r.slug AS role_slug,
             p.business_name AS partner_name, u.partner_id
      FROM users u
      JOIN roles r ON r.id = u.role_id
      LEFT JOIN partners p ON p.id = u.partner_id
      ${where}
      ORDER BY u.created_at DESC`;

    const result = await paginate(fallbackBaseQuery, countQuery, params, page, limit);
    res.json({ success: true, ...result });
  }
});

// GET /api/v1/users/:id
const getUser = asyncHandler(async (req, res) => {
  const params = [req.params.id];
  let where = 'WHERE u.id = ? AND u.is_deleted = 0';

  if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
    where += ' AND u.partner_id = ?';
    params.push(req.user.partner_id);
  }

  let users;
  try {
    [users] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.phone, u.level, u.location, u.status,
              u.last_login, u.created_at, u.updated_at,
              r.name AS role_name, r.slug AS role_slug,
              p.business_name AS partner_name, u.partner_id,
              u.warehouse_id, w.name AS warehouse_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN partners p ON p.id = u.partner_id
       LEFT JOIN warehouses w ON w.id = u.warehouse_id
       ${where}
       LIMIT 1`,
      params
    );
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    [users] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.phone, u.level, u.location, u.status,
              u.last_login, u.created_at, u.updated_at,
              r.name AS role_name, r.slug AS role_slug,
              p.business_name AS partner_name, u.partner_id
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN partners p ON p.id = u.partner_id
       ${where}
       LIMIT 1`,
      params
    );
  }

  if (users.length === 0) throw ApiError.notFound('User not found');

  res.json({ success: true, data: users[0] });
});

// POST /api/v1/users
const createUser = asyncHandler(async (req, res) => {
  const {
    name,
    first_name,
    last_name,
    email,
    password,
    phone,
    role_id,
    role_slug,
    partner_id,
    warehouse_id,
    level,
    location,
  } = req.body;

  const fullName =
    (typeof name === 'string' && name.trim()) ||
    `${first_name || ''} ${last_name || ''}`.trim();

  if (!fullName) {
    throw ApiError.badRequest('Name is required');
  }

  // Validate at the boundary: email + password are the two fields most
  // likely to blow up bcrypt.hash()/the unique index if left unchecked.
  const normalizedEmail = typeof email === 'string' ? email.trim() : '';
  if (!normalizedEmail) {
    throw ApiError.badRequest('Email is required');
  }
  if (!EMAIL_RE.test(normalizedEmail)) {
    throw ApiError.badRequest('Email must be a valid email address');
  }
  if (!password || typeof password !== 'string') {
    throw ApiError.badRequest('Password is required');
  }
  if (password.length < 8) {
    throw ApiError.badRequest('Password must be at least 8 characters');
  }

  // Check duplicate email across ALL rows (including soft-deleted) — the DB
  // unique index on users.email is not filtered by is_deleted, so a
  // soft-deleted holder of this email would otherwise surface as a raw
  // ER_DUP_ENTRY 500 at INSERT time instead of a clean 409 here.
  const [existing] = await pool.execute(
    'SELECT id, is_deleted FROM users WHERE email = ? LIMIT 1',
    [normalizedEmail]
  );
  if (existing.length > 0) {
    if (existing[0].is_deleted) {
      throw ApiError.conflict('A deleted account holds this email. Restore it or use a different email.');
    }
    throw ApiError.conflict('Email already in use');
  }

  if (normalizeRoleSlug(role_slug) === 'mobile_stockist') {
    throw ApiError.badRequest('Create Mobile Stockist accounts from the Mobile Stockists module');
  }

  // Resolve warehouse association (if any) BEFORE role/partner assignment —
  // the warehouse's own partner_id, when present, is the server-side source
  // of truth and overrides whatever partner_id the client sent.
  let warehouseRow = null;
  let effectivePartnerId = partner_id;
  if (warehouse_id !== undefined && warehouse_id !== null && warehouse_id !== '') {
    warehouseRow = await getWarehouseById(warehouse_id);
    if (!warehouseRow) throw ApiError.badRequest('Warehouse not found');
    if (warehouseRow.partner_id) {
      effectivePartnerId = warehouseRow.partner_id;
    }
  }

  const assignment = await resolveUserAssignment({
    actor: req.user,
    requested: { role_id, role_slug, partner_id: effectivePartnerId, warehouse: warehouseRow },
    getRoleBySlug,
    getPartnerById,
  });

  const hashedPassword = await bcrypt.hash(password, 12);

  let result;
  try {
    [result] = await pool.execute(
      `INSERT INTO users (name, email, password, phone, role_id, partner_id, warehouse_id, level, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fullName,
        normalizedEmail,
        hashedPassword,
        phone || null,
        assignment.roleId,
        assignment.partnerId,
        warehouseRow ? warehouseRow.id : null,
        level || 'main',
        location || 'Regional Hub - North',
      ]
    );
  } catch (err) {
    if (isDupEntryError(err)) throw ApiError.conflict('Email already in use');
    if (!isMissingColumnError(err)) throw err;
    // Older schema without users.warehouse_id — fall back gracefully.
    try {
      [result] = await pool.execute(
        `INSERT INTO users (name, email, password, phone, role_id, partner_id, level, location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [fullName, normalizedEmail, hashedPassword, phone || null, assignment.roleId, assignment.partnerId, level || 'main', location || 'Regional Hub - North']
      );
    } catch (err2) {
      if (isDupEntryError(err2)) throw ApiError.conflict('Email already in use');
      throw err2;
    }
  }

  const [created] = await pool.execute(
    `SELECT u.id, u.name, u.email, u.phone, u.level, u.location, u.status, u.created_at,
            r.name AS role_name, r.slug AS role_slug
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.id = ?`,
    [result.insertId]
  );

  res.status(201).json({ success: true, message: 'User created', data: created[0] });
});

// PUT /api/v1/users/:id
const updateUser = asyncHandler(async (req, res) => {
  const { name, email, phone, role_id, role_slug, partner_id, warehouse_id, level, location, status } = req.body;
  const userId = req.params.id;

  const normalizedEmail = typeof email === 'string' ? email.trim() : email;
  if (email !== undefined && email !== null && normalizedEmail === '') {
    throw ApiError.badRequest('Email is required');
  }
  if (normalizedEmail && !EMAIL_RE.test(normalizedEmail)) {
    throw ApiError.badRequest('Email must be a valid email address');
  }

  // Verify user exists
  const checkParams = [userId];
  let checkWhere = 'WHERE u.id = ? AND u.is_deleted = 0';
  if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
    checkWhere += ' AND u.partner_id = ?';
    checkParams.push(req.user.partner_id);
  }

  const [existing] = await pool.execute(
    `SELECT u.id, u.partner_id, r.slug AS role_slug
     FROM users u
     JOIN roles r ON r.id = u.role_id
     ${checkWhere}
     LIMIT 1`,
    checkParams
  );
  if (existing.length === 0) throw ApiError.notFound('User not found');
  const existingUser = existing[0];

  // Check email uniqueness if changing — across ALL rows (including
  // soft-deleted) since the DB unique index is not filtered by is_deleted.
  if (normalizedEmail) {
    const [dup] = await pool.execute(
      'SELECT id, is_deleted FROM users WHERE email = ? AND id != ? LIMIT 1',
      [normalizedEmail, userId]
    );
    if (dup.length > 0) {
      if (dup[0].is_deleted) {
        throw ApiError.conflict('A deleted account holds this email. Restore it or use a different email.');
      }
      throw ApiError.conflict('Email already in use');
    }
  }

  // Resolve warehouse association (if being changed) BEFORE role/partner
  // assignment — the warehouse's own partner_id, when present, is the
  // server-side source of truth and overrides any client-sent partner_id.
  let warehouseRow = null;
  let clearWarehouse = false;
  let effectivePartnerId = partner_id;
  if (warehouse_id !== undefined) {
    if (warehouse_id === null || warehouse_id === '') {
      clearWarehouse = true;
    } else {
      warehouseRow = await getWarehouseById(warehouse_id);
      if (!warehouseRow) throw ApiError.badRequest('Warehouse not found');
      if (warehouseRow.partner_id) {
        effectivePartnerId = warehouseRow.partner_id;
      }
    }
  }

  const fields = [];
  const values = [];

  const requestedRoleSlug = role_slug
    ? normalizeRoleSlug(role_slug)
    : role_id
      ? (await getRoleById(role_id))?.slug || null
      : existingUser.role_slug;

  if (
    req.user.role_slug !== 'super_admin' &&
    (
      (requestedRoleSlug && requestedRoleSlug !== existingUser.role_slug) ||
      (effectivePartnerId !== undefined && Number(effectivePartnerId || 0) !== Number(existingUser.partner_id || 0))
    )
  ) {
    throw ApiError.forbidden('Only super admins can change user roles or Stockist affiliation');
  }

  if (
    req.user.role_slug === 'super_admin' &&
    (role_slug !== undefined || role_id !== undefined || partner_id !== undefined || warehouse_id !== undefined)
  ) {
    if (requestedRoleSlug === 'mobile_stockist' && existingUser.role_slug !== 'mobile_stockist') {
      throw ApiError.badRequest('Create Mobile Stockist accounts from the Mobile Stockists module');
    }

    const assignment = await resolveUserAssignment({
      actor: req.user,
      requested: {
        role_slug: requestedRoleSlug,
        partner_id: effectivePartnerId !== undefined ? (effectivePartnerId || null) : existingUser.partner_id,
        warehouse: warehouseRow,
      },
      getRoleBySlug,
      getPartnerById,
    });

    fields.push('role_id = ?');
    values.push(assignment.roleId);
    fields.push('partner_id = ?');
    values.push(assignment.partnerId);
  }

  if (name) { fields.push('name = ?'); values.push(name); }
  if (normalizedEmail) { fields.push('email = ?'); values.push(normalizedEmail); }
  if (phone !== undefined) { fields.push('phone = ?'); values.push(phone || null); }
  if (level) { fields.push('level = ?'); values.push(level); }
  if (location) { fields.push('location = ?'); values.push(location); }
  if (status) { fields.push('status = ?'); values.push(status); }
  if (warehouse_id !== undefined) {
    fields.push('warehouse_id = ?');
    values.push(clearWarehouse ? null : warehouseRow.id);
  }

  if (fields.length === 0) throw ApiError.badRequest('No fields to update');

  values.push(userId);

  try {
    await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  } catch (err) {
    if (isDupEntryError(err)) throw ApiError.conflict('Email already in use');
    if (!isMissingColumnError(err)) throw err;
    if (warehouse_id === undefined) throw err;

    // Older schema without users.warehouse_id — retry without that field.
    const warehouseIdx = fields.indexOf('warehouse_id = ?');
    const fallbackFields = fields.filter((f) => f !== 'warehouse_id = ?');
    const fallbackValues = values.filter((_, i) => i !== warehouseIdx);
    if (fallbackFields.length === 0) throw ApiError.badRequest('No fields to update');

    try {
      await pool.execute(`UPDATE users SET ${fallbackFields.join(', ')} WHERE id = ?`, fallbackValues);
    } catch (err2) {
      if (isDupEntryError(err2)) throw ApiError.conflict('Email already in use');
      throw err2;
    }
  }

  const [updated] = await pool.execute(
    `SELECT u.id, u.name, u.email, u.phone, u.level, u.location, u.status, u.partner_id,
            r.name AS role_name, r.slug AS role_slug
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId]
  );

  res.json({ success: true, message: 'User updated', data: updated[0] });
});

// POST /api/v1/users/:id/reset-password
const resetUserPassword = asyncHandler(async (req, res) => {
  const userId = req.params.id;

  const checkParams = [userId];
  let checkWhere = 'WHERE id = ? AND is_deleted = 0';
  if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
    checkWhere += ' AND partner_id = ?';
    checkParams.push(req.user.partner_id);
  }

  const [existing] = await pool.execute(
    `SELECT id FROM users ${checkWhere} LIMIT 1`,
    checkParams
  );
  if (existing.length === 0) throw ApiError.notFound('User not found');

  // Generate a strong random temporary password (16 hex chars = 64 bits entropy)
  const crypto = require('crypto');
  const temporaryPassword = crypto.randomBytes(8).toString('hex');

  const hashedPassword = await bcrypt.hash(temporaryPassword, 12);

  await pool.execute(
    'UPDATE users SET password = ? WHERE id = ? AND is_deleted = 0',
    [hashedPassword, userId]
  );

  res.json({
    success: true,
    data: { temporary_password: temporaryPassword },
    message: 'Password reset',
  });
});

// DELETE /api/v1/users/:id (soft delete)
const deleteUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;

  // Prevent self-delete
  if (parseInt(userId) === req.user.id) {
    throw ApiError.badRequest('Cannot delete your own account');
  }

  const checkParams = [userId];
  let checkWhere = 'WHERE id = ? AND is_deleted = 0';
  if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
    checkWhere += ' AND partner_id = ?';
    checkParams.push(req.user.partner_id);
  }

  const [existing] = await pool.execute(`SELECT id FROM users ${checkWhere} LIMIT 1`, checkParams);
  if (existing.length === 0) throw ApiError.notFound('User not found');

  await pool.execute('UPDATE users SET is_deleted = 1, status = ? WHERE id = ?', ['inactive', userId]);

  res.json({ success: true, message: 'User deleted' });
});

module.exports = { getUsers, getUser, createUser, updateUser, deleteUser, resetUserPassword };
