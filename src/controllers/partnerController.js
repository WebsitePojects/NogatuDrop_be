const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');

// GET /api/v1/partners
const getPartners = asyncHandler(async (req, res) => {
  const { page, limit, search, status, partner_type } = req.query;
  const params = [];
  let where = 'WHERE p.is_deleted = 0';

  if (search) {
    where += ' AND (p.business_name LIKE ? OR p.email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (status) { where += ' AND p.status = ?'; params.push(status); }
  if (partner_type) { where += ' AND p.partner_type = ?'; params.push(partner_type); }

  const baseQuery = `
    SELECT p.id, p.business_name, p.email, p.phone, p.address, p.partner_type,
           p.credit_limit, p.credit_used,
           (p.credit_limit - p.credit_used) AS credit_available,
           p.status, p.region, p.created_at, p.updated_at
    FROM partners p
    ${where}
    ORDER BY p.business_name ASC`;

  const countQuery = `SELECT COUNT(*) AS total FROM partners p ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// GET /api/v1/partners/:id
const getPartner = asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT p.id, p.business_name, p.email, p.phone, p.address, p.partner_type,
            p.credit_limit, p.credit_used,
            (p.credit_limit - p.credit_used) AS credit_available,
            p.status, p.region, p.created_at, p.updated_at
     FROM partners p WHERE p.id = ? AND p.is_deleted = 0 LIMIT 1`,
    [req.params.id]
  );
  if (rows.length === 0) throw ApiError.notFound('Partner not found');
  res.json({ success: true, data: rows[0] });
});

// POST /api/v1/partners
const createPartner = asyncHandler(async (req, res) => {
  const { business_name, email, phone, address, partner_type, credit_limit, region,
          admin_name, admin_email, admin_password } = req.body;

  // Check duplicate partner email
  const [dupPartner] = await pool.execute(
    'SELECT id FROM partners WHERE email = ? AND is_deleted = 0', [email]
  );
  if (dupPartner.length > 0) throw ApiError.conflict('Partner email already exists');

  // Check duplicate admin email
  const adminMail = admin_email || email;
  const [dupUser] = await pool.execute(
    'SELECT id FROM users WHERE email = ? AND is_deleted = 0', [adminMail]
  );
  if (dupUser.length > 0) throw ApiError.conflict('Admin email already in use');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Create partner
    const [partnerResult] = await conn.execute(
      `INSERT INTO partners (business_name, email, phone, address, partner_type, credit_limit, region)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [business_name, email, phone, address, partner_type || 'distributor', credit_limit || 0, region || null]
    );

    const partnerId = partnerResult.insertId;

    // Get admin role id
    const [adminRole] = await conn.execute("SELECT id FROM roles WHERE slug = 'admin' LIMIT 1");
    const roleId = adminRole[0].id;

    // Generate temp password or use provided
    const tempPassword = admin_password || `Temp@${Date.now().toString(36)}`;
    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    // Create admin user for partner
    await conn.execute(
      `INSERT INTO users (name, email, password, phone, role_id, partner_id, level, location)
       VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
      [admin_name || business_name, adminMail, hashedPassword, phone, roleId, partnerId, region || 'Regional Hub - North']
    );

    await conn.commit();

    const [created] = await pool.execute('SELECT * FROM partners WHERE id = ?', [partnerId]);

    res.status(201).json({
      success: true,
      message: 'Partner created with admin account',
      data: {
        partner: created[0],
        admin_credentials: {
          email: adminMail,
          temporary_password: tempPassword,
        },
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
  const { business_name, email, phone, address, partner_type, credit_limit, credit_used, status, region } = req.body;

  const [existing] = await pool.execute('SELECT id FROM partners WHERE id = ? AND is_deleted = 0', [partnerId]);
  if (existing.length === 0) throw ApiError.notFound('Partner not found');

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
  if (phone) { fields.push('phone = ?'); values.push(phone); }
  if (address) { fields.push('address = ?'); values.push(address); }
  if (partner_type) { fields.push('partner_type = ?'); values.push(partner_type); }
  if (credit_limit !== undefined) { fields.push('credit_limit = ?'); values.push(credit_limit); }
  if (credit_used !== undefined) { fields.push('credit_used = ?'); values.push(credit_used); }
  if (status) { fields.push('status = ?'); values.push(status); }
  if (region !== undefined) { fields.push('region = ?'); values.push(region || null); }

  if (fields.length === 0) throw ApiError.badRequest('No fields to update');

  values.push(partnerId);
  await pool.execute(`UPDATE partners SET ${fields.join(', ')} WHERE id = ?`, values);

  const [updated] = await pool.execute('SELECT * FROM partners WHERE id = ?', [partnerId]);
  res.json({ success: true, message: 'Partner updated', data: updated[0] });
});

module.exports = { getPartners, getPartner, createPartner, updatePartner };
