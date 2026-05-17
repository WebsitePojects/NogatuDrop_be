const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const { ROLES, canonicalRole } = require('../rbac/roles');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

function isSuperAdmin(user) {
  return canonicalRole(user?.role_slug) === ROLES.SUPER_ADMIN;
}

function scopedMobileWhere(user, alias = 'ms') {
  if (isSuperAdmin(user)) {
    return { clause: '', params: [] };
  }

  if (!user?.partner_id) {
    return { clause: ' AND 1 = 0', params: [] };
  }

  return { clause: ` AND ${alias}.partner_id = ?`, params: [user.partner_id] };
}

async function getRoleIdBySlug(db, slug) {
  const [roles] = await db.execute('SELECT id FROM roles WHERE slug = ? LIMIT 1', [slug]);
  if (roles.length === 0) {
    throw ApiError.badRequest(`Required role is missing: ${slug}`);
  }
  return roles[0].id;
}

async function assertActiveStockistPartner(db, partnerId) {
  const [partners] = await db.execute(
    `SELECT id
     FROM partners
     WHERE id = ?
       AND is_deleted = 0
       AND status = 'active'
       AND stockist_level IN ('provincial_stockist', 'city_stockist')
     LIMIT 1`,
    [partnerId]
  );

  if (partners.length === 0) {
    throw ApiError.badRequest('Parent Stockist must be an active provincial or city stockist');
  }
}

async function getMobileStockistById(db, id, user) {
  const scope = scopedMobileWhere(user);
  try {
    const [rows] = await db.execute(
      `SELECT id, email, user_id, partner_id
       FROM mobile_stockists ms
       WHERE ms.id = ? AND ms.is_deleted = 0${scope.clause}
       LIMIT 1`,
      [id, ...scope.params]
    );
    return rows[0] || null;
  } catch (err) {
    if (!isMissingColumn(err, 'user_id')) {
      throw err;
    }

    const [rows] = await db.execute(
      `SELECT id, email, NULL AS user_id, partner_id
       FROM mobile_stockists ms
       WHERE ms.id = ? AND ms.is_deleted = 0${scope.clause}
       LIMIT 1`,
      [id, ...scope.params]
    );
    return rows[0] || null;
  }
}

// GET /api/v1/mobile-stockists
const getMobileStockists = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.query;
  const params = [];
  let where = 'WHERE ms.is_deleted = 0';

  // City/Provincial Stockist: only see their own mobile stockists
  if (!['super_admin'].includes(req.user.role_slug)) {
    where += ' AND ms.partner_id = ?';
    params.push(req.user.partner_id);
  }
  if (search) {
    where += ' AND (ms.name LIKE ? OR ms.email LIKE ? OR ms.address LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const baseQuery = `
    SELECT ms.id, ms.name, ms.email, ms.phone, ms.address, ms.status,
           ms.partner_id, p.business_name AS parent_name,
           ms.created_at, ms.last_login
    FROM mobile_stockists ms
    LEFT JOIN partners p ON p.id = ms.partner_id
    ${where} ORDER BY ms.created_at DESC`;
  const countQuery = `SELECT COUNT(*) AS total FROM mobile_stockists ms LEFT JOIN partners p ON p.id = ms.partner_id ${where}`;

  let result;
  try {
    result = await paginate(baseQuery, countQuery, params, page, limit);
  } catch (err) {
    if (!isMissingColumn(err, 'ms.last_login')) {
      throw err;
    }

    const fallbackQuery = `
      SELECT ms.id, ms.name, ms.email, ms.phone, ms.address, ms.status,
             ms.partner_id, p.business_name AS parent_name,
             ms.created_at, NULL AS last_login
      FROM mobile_stockists ms
      LEFT JOIN partners p ON p.id = ms.partner_id
      ${where} ORDER BY ms.created_at DESC`;
    result = await paginate(fallbackQuery, countQuery, params, page, limit);
  }

  res.json({ success: true, ...result });
});

// POST /api/v1/mobile-stockists
const createMobileStockist = asyncHandler(async (req, res) => {
  const { name, email, phone, address, parent_partner_id, password } = req.body;
  if (!name || !email) throw ApiError.badRequest('name and email are required');
  if (!password || password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');

  const parentId = isSuperAdmin(req.user) ? (parent_partner_id || req.user.partner_id) : req.user.partner_id;
  if (!parentId) throw ApiError.badRequest('Parent Stockist is required');

  await assertActiveStockistPartner(pool, parentId);

  const [existingMobile] = await pool.execute(
    'SELECT id FROM mobile_stockists WHERE email = ? LIMIT 1',
    [email]
  );
  if (existingMobile.length > 0) throw ApiError.conflict('Email already registered as a Mobile Stockist');

  const [existingUser] = await pool.execute(
    'SELECT id FROM users WHERE email = ? LIMIT 1',
    [email]
  );
  if (existingUser.length > 0) throw ApiError.conflict('Email already in use');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const mobileRoleId = await getRoleIdBySlug(conn, ROLES.MOBILE_STOCKIST);
    const hashedPassword = await bcrypt.hash(password, 12);

    const [userResult] = await conn.execute(
      `INSERT INTO users (name, email, password, phone, role_id, partner_id, level, location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, email, hashedPassword, phone || null, mobileRoleId, parentId, 'mobile', address || 'Mobile Stockist']
    );

    let result;
    try {
      [result] = await conn.execute(
        `INSERT INTO mobile_stockists (user_id, name, email, phone, address, partner_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [userResult.insertId, name, email, phone || null, address || null, parentId]
      );
    } catch (err) {
      if (!isMissingColumn(err, 'user_id')) {
        throw err;
      }

      [result] = await conn.execute(
        `INSERT INTO mobile_stockists (name, email, phone, address, partner_id, status)
         VALUES (?, ?, ?, ?, ?, 'active')`,
        [name, email, phone || null, address || null, parentId]
      );
    }

    await conn.commit();
    res.status(201).json({
      success: true,
      message: 'Mobile Stockist account created',
      data: { id: result.insertId, user_id: userResult.insertId },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PUT /api/v1/mobile-stockists/:id
const updateMobileStockist = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await getMobileStockistById(pool, id, req.user);
  if (!existing) throw ApiError.notFound('Mobile Stockist not found');

  const { name, phone, address, status } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `UPDATE mobile_stockists SET name = COALESCE(?, name), phone = COALESCE(?, phone),
       address = COALESCE(?, address), status = COALESCE(?, status) WHERE id = ?`,
      [name, phone, address, status, id]
    );

    if (status) {
      const userStatus = status === 'active' ? 'active' : 'inactive';
      if (existing.user_id) {
        await conn.execute(
          'UPDATE users SET status = ? WHERE id = ? AND partner_id = ?',
          [userStatus, existing.user_id, existing.partner_id]
        );
      } else {
        await conn.execute(
          'UPDATE users SET status = ? WHERE email = ? AND partner_id = ? AND is_deleted = 0',
          [userStatus, existing.email, existing.partner_id]
        );
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({ success: true, message: 'Mobile Stockist updated' });
});

// DELETE /api/v1/mobile-stockists/:id
const deleteMobileStockist = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await getMobileStockistById(pool, id, req.user);
  if (!existing) throw ApiError.notFound('Mobile Stockist not found');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE mobile_stockists SET is_deleted = 1, status = ? WHERE id = ?', ['inactive', id]);
    if (existing.user_id) {
      await conn.execute(
        'UPDATE users SET is_deleted = 1, status = ? WHERE id = ? AND partner_id = ?',
        ['inactive', existing.user_id, existing.partner_id]
      );
    } else {
      await conn.execute(
        'UPDATE users SET is_deleted = 1, status = ? WHERE email = ? AND partner_id = ? AND is_deleted = 0',
        ['inactive', existing.email, existing.partner_id]
      );
    }
    await conn.commit();
    res.json({ success: true, message: 'Mobile Stockist removed' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

module.exports = { getMobileStockists, createMobileStockist, updateMobileStockist, deleteMobileStockist };
