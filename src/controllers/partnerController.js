const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');

// GET /api/v1/partners
const getPartners = asyncHandler(async (req, res) => {
  const { page, limit, search, status, stockist_level } = req.query;
  const params = [];
  let where = 'WHERE p.is_deleted = 0';

  if (search) {
    where += ' AND (p.business_name LIKE ? OR p.email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status) { where += ' AND p.status = ?'; params.push(status); }
  if (stockist_level) { where += ' AND p.stockist_level = ?'; params.push(stockist_level); }

  const baseQuery = `
    SELECT p.id, p.business_name, p.email, p.phone, p.address,
           p.stockist_level, p.discount_pct, p.parent_partner_id,
           parent.business_name AS parent_name,
           p.status, p.created_at, p.updated_at
    FROM partners p
    LEFT JOIN partners parent ON parent.id = p.parent_partner_id
    ${where}
    ORDER BY p.business_name ASC`;

  const countQuery = `SELECT COUNT(*) AS total FROM partners p ${where}`;
  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// GET /api/v1/partners/:id
const getPartner = asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT p.id, p.business_name, p.email, p.phone, p.address,
            p.stockist_level, p.discount_pct, p.parent_partner_id,
            parent.business_name AS parent_name,
            p.status, p.created_at, p.updated_at
     FROM partners p
     LEFT JOIN partners parent ON parent.id = p.parent_partner_id
     WHERE p.id = ? AND p.is_deleted = 0 LIMIT 1`,
    [req.params.id]
  );
  if (rows.length === 0) throw ApiError.notFound('Stockist not found');
  res.json({ success: true, data: rows[0] });
});

// POST /api/v1/partners
const createPartner = asyncHandler(async (req, res) => {
  const {
    business_name, email, phone, address, stockist_level,
    parent_partner_id, discount_pct,
    admin_name, admin_email, admin_password,
  } = req.body;

  if (!business_name || !email || !stockist_level) {
    throw ApiError.badRequest('business_name, email, and stockist_level are required');
  }
  if (!['provincial_stockist', 'city_stockist'].includes(stockist_level)) {
    throw ApiError.badRequest('stockist_level must be provincial_stockist or city_stockist');
  }

  const [dupPartner] = await pool.execute(
    'SELECT id FROM partners WHERE email = ? AND is_deleted = 0', [email]
  );
  if (dupPartner.length > 0) throw ApiError.conflict('Stockist email already exists');

  const adminMail = admin_email || email;
  const [dupUser] = await pool.execute('SELECT id FROM users WHERE email = ? AND is_deleted = 0', [adminMail]);
  if (dupUser.length > 0) throw ApiError.conflict('User email already in use');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [partnerResult] = await conn.execute(
      `INSERT INTO partners (business_name, email, phone, address, stockist_level, parent_partner_id, discount_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [business_name, email, phone || null, address || null, stockist_level,
       parent_partner_id || null, discount_pct !== undefined ? discount_pct : 0]
    );
    const partnerId = partnerResult.insertId;

    const [roleRow] = await conn.execute('SELECT id FROM roles WHERE slug = ? LIMIT 1', [stockist_level]);
    if (roleRow.length === 0) throw ApiError.serverError('Role not found for stockist_level');

    const tempPassword = admin_password || `Nogatu@${Date.now().toString(36)}`;
    const hashed = await bcrypt.hash(tempPassword, 12);

    await conn.execute(
      `INSERT INTO users (name, email, password, phone, role_id, partner_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [admin_name || business_name, adminMail, hashed, phone || null, roleRow[0].id, partnerId]
    );

    await conn.commit();

    res.status(201).json({
      success: true,
      message: 'Stockist created with user account',
      data: {
        partner_id: partnerId,
        admin_credentials: { email: adminMail, temporary_password: tempPassword },
      },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PUT /api/v1/partners/:id
const updatePartner = asyncHandler(async (req, res) => {
  const partnerId = req.params.id;
  const { business_name, email, phone, address, status, parent_partner_id } = req.body;

  const [existing] = await pool.execute('SELECT id FROM partners WHERE id = ? AND is_deleted = 0', [partnerId]);
  if (existing.length === 0) throw ApiError.notFound('Stockist not found');

  if (email) {
    const [dup] = await pool.execute(
      'SELECT id FROM partners WHERE email = ? AND id != ? AND is_deleted = 0', [email, partnerId]
    );
    if (dup.length > 0) throw ApiError.conflict('Email already in use');
  }

  const fields = [];
  const values = [];
  if (business_name) { fields.push('business_name = ?'); values.push(business_name); }
  if (email) { fields.push('email = ?'); values.push(email); }
  if (phone !== undefined) { fields.push('phone = ?'); values.push(phone); }
  if (address !== undefined) { fields.push('address = ?'); values.push(address); }
  if (status) { fields.push('status = ?'); values.push(status); }
  if (parent_partner_id !== undefined) { fields.push('parent_partner_id = ?'); values.push(parent_partner_id || null); }

  if (fields.length === 0) throw ApiError.badRequest('No fields to update');

  values.push(partnerId);
  await pool.execute(`UPDATE partners SET ${fields.join(', ')} WHERE id = ?`, values);

  res.json({ success: true, message: 'Stockist updated' });
});

// PATCH /api/v1/partners/:id/discount — super_admin sets discount
const updateDiscount = asyncHandler(async (req, res) => {
  const { discount_pct } = req.body;
  const partnerId = req.params.id;

  if (discount_pct === undefined || discount_pct < 0 || discount_pct > 100) {
    throw ApiError.badRequest('discount_pct must be between 0 and 100');
  }

  const [existing] = await pool.execute('SELECT id FROM partners WHERE id = ? AND is_deleted = 0', [partnerId]);
  if (existing.length === 0) throw ApiError.notFound('Stockist not found');

  await pool.execute('UPDATE partners SET discount_pct = ? WHERE id = ?', [discount_pct, partnerId]);
  res.json({ success: true, message: `Discount set to ${discount_pct}%` });
});

module.exports = { getPartners, getPartner, createPartner, updatePartner, updateDiscount };
