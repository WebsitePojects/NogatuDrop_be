const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');

async function getRoleBySlug(slug) {
  const [rows] = await pool.execute('SELECT id, slug FROM roles WHERE slug = ? LIMIT 1', [slug]);
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
           p.business_name AS partner_name, u.partner_id
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN partners p ON p.id = u.partner_id
    ${where}
    ORDER BY u.created_at DESC`;

  const countQuery = `
    SELECT COUNT(*) AS total
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN partners p ON p.id = u.partner_id
    ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);

  res.json({ success: true, ...result });
});

// GET /api/v1/users/:id
const getUser = asyncHandler(async (req, res) => {
  const params = [req.params.id];
  let where = 'WHERE u.id = ? AND u.is_deleted = 0';

  if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
    where += ' AND u.partner_id = ?';
    params.push(req.user.partner_id);
  }

  const [users] = await pool.execute(
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
    level,
    location,
  } = req.body;

  const fullName =
    (typeof name === 'string' && name.trim()) ||
    `${first_name || ''} ${last_name || ''}`.trim();

  if (!fullName) {
    throw ApiError.badRequest('Name is required');
  }

  // Check duplicate email
  const [existing] = await pool.execute(
    'SELECT id FROM users WHERE email = ? AND is_deleted = 0 LIMIT 1',
    [email]
  );
  if (existing.length > 0) throw ApiError.conflict('Email already in use');

  // Admin can only create staff under their own partner
  let assignedPartnerId = partner_id || null;
  let assignedRoleId = role_id;

  if (!assignedRoleId && role_slug) {
    const role = await getRoleBySlug(role_slug);
    if (!role) {
      throw ApiError.badRequest('Invalid role');
    }
    assignedRoleId = role.id;
  }

  if (req.user.role_slug === 'admin') {
    assignedPartnerId = req.user.partner_id;
    // Admin can only create staff
    const staffRole = await getRoleBySlug('staff');
    assignedRoleId = staffRole.id;
  }

  if (['provincial_stockist', 'city_stockist'].includes(req.user.role_slug)) {
    assignedPartnerId = req.user.partner_id;
    const requestedRoleSlug = role_slug || 'staff';

    if (!['staff', 'mobile_stockist'].includes(requestedRoleSlug)) {
      throw ApiError.forbidden('Stockists can only create staff or mobile stockist users');
    }

    const scopedRole = await getRoleBySlug(requestedRoleSlug);
    if (!scopedRole) {
      throw ApiError.badRequest('Invalid role');
    }
    assignedRoleId = scopedRole.id;
  }

  if (!assignedRoleId) {
    throw ApiError.badRequest('Role is required');
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const [result] = await pool.execute(
    `INSERT INTO users (name, email, password, phone, role_id, partner_id, level, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [fullName, email, hashedPassword, phone || null, assignedRoleId, assignedPartnerId, level || 'main', location || 'Regional Hub - North']
  );

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
  const { name, email, phone, role_id, partner_id, level, location, status } = req.body;
  const userId = req.params.id;

  // Verify user exists
  const checkParams = [userId];
  let checkWhere = 'WHERE id = ? AND is_deleted = 0';
  if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
    checkWhere += ' AND partner_id = ?';
    checkParams.push(req.user.partner_id);
  }

  const [existing] = await pool.execute(`SELECT id FROM users ${checkWhere} LIMIT 1`, checkParams);
  if (existing.length === 0) throw ApiError.notFound('User not found');

  // Check email uniqueness if changing
  if (email) {
    const [dup] = await pool.execute(
      'SELECT id FROM users WHERE email = ? AND id != ? AND is_deleted = 0 LIMIT 1',
      [email, userId]
    );
    if (dup.length > 0) throw ApiError.conflict('Email already in use');
  }

  const fields = [];
  const values = [];

  if (name) { fields.push('name = ?'); values.push(name); }
  if (email) { fields.push('email = ?'); values.push(email); }
  if (phone !== undefined) { fields.push('phone = ?'); values.push(phone || null); }
  if (role_id && req.user.role_slug === 'super_admin') { fields.push('role_id = ?'); values.push(role_id); }
  if (partner_id !== undefined && req.user.role_slug === 'super_admin') { fields.push('partner_id = ?'); values.push(partner_id || null); }
  if (level) { fields.push('level = ?'); values.push(level); }
  if (location) { fields.push('location = ?'); values.push(location); }
  if (status) { fields.push('status = ?'); values.push(status); }

  if (fields.length === 0) throw ApiError.badRequest('No fields to update');

  values.push(userId);
  await pool.execute(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

  const [updated] = await pool.execute(
    `SELECT u.id, u.name, u.email, u.phone, u.level, u.location, u.status, u.partner_id,
            r.name AS role_name, r.slug AS role_slug
     FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
    [userId]
  );

  res.json({ success: true, message: 'User updated', data: updated[0] });
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

module.exports = { getUsers, getUser, createUser, updateUser, deleteUser };
