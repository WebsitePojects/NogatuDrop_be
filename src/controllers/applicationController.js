const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const bcrypt = require('bcryptjs');
const { sendEmail, EMAIL } = require('../services/emailService');

// GET /api/v1/applications
const getApplications = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const params = [];
  let where = 'WHERE is_deleted = 0';
  if (status) { where += ' AND status = ?'; params.push(status); }

  const baseQuery = `SELECT id, full_name, business_name, email, phone, address, stockist_level,
    id_front_url, id_back_url, status, notes, created_at, reviewed_at
    FROM dta_applications ${where} ORDER BY created_at DESC`;
  const countQuery = `SELECT COUNT(*) AS total FROM dta_applications ${where}`;

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// GET /api/v1/applications/:id
const getApplication = asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    'SELECT * FROM dta_applications WHERE id = ? AND is_deleted = 0 LIMIT 1',
    [req.params.id]
  );
  if (rows.length === 0) throw ApiError.notFound('Application not found');
  res.json({ success: true, data: rows[0] });
});

// POST /api/v1/applications/dta — public, no auth
const submitDTA = asyncHandler(async (req, res) => {
  const {
    full_name, business_name, email, phone, address, stockist_level, notes
  } = req.body;

  if (!full_name || !email || !phone || !address || !stockist_level) {
    throw ApiError.badRequest('full_name, email, phone, address, and stockist_level are required');
  }
  if (!['provincial_stockist', 'city_stockist'].includes(stockist_level)) {
    throw ApiError.badRequest('stockist_level must be provincial_stockist or city_stockist');
  }

  const [existing] = await pool.execute(
    `SELECT id FROM dta_applications WHERE email = ? AND status IN ('pending', 'approved') LIMIT 1`,
    [email]
  );
  if (existing.length > 0) throw ApiError.conflict('An application with this email already exists');

  const idFrontUrl = req.files?.id_front?.[0]?.path || null;
  const idBackUrl = req.files?.id_back?.[0]?.path || null;

  const [result] = await pool.execute(
    `INSERT INTO dta_applications (full_name, business_name, email, phone, address, stockist_level, id_front_url, id_back_url, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [full_name, business_name || null, email, phone, address, stockist_level, idFrontUrl, idBackUrl, notes || null]
  );

  // Notify all super admins
  const [admins] = await pool.execute(
    `SELECT u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active'`
  );
  for (const admin of admins) {
    const tmpl = EMAIL.dtaReceived(full_name, business_name || email);
    await sendEmail({ to: admin.email, toName: admin.name, ...tmpl });

    await pool.execute(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
       VALUES (?, 'dta_received', ?, ?, 'application', ?)`,
      [admin.id, `New Stockist Application: ${full_name}`, `${full_name} applied for ${stockist_level.replace('_', ' ')}.`, result.insertId]
    );
  }

  res.status(201).json({ success: true, message: 'Application submitted successfully. We will contact you soon.' });
});

// PATCH /api/v1/applications/:id/approve
const approveApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.execute(
    'SELECT * FROM dta_applications WHERE id = ? AND status = \'pending\' AND is_deleted = 0 LIMIT 1',
    [id]
  );
  if (rows.length === 0) throw ApiError.notFound('Pending application not found');

  const app = rows[0];

  // Generate a temporary password
  const tempPassword = Math.random().toString(36).slice(-8) + 'N1!';
  const hashed = await bcrypt.hash(tempPassword, 12);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Create partner record
    const [partnerResult] = await conn.execute(
      `INSERT INTO partners (business_name, email, phone, address, stockist_level, discount_pct)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [app.business_name || app.full_name, app.email, app.phone, app.address, app.stockist_level]
    );
    const partnerId = partnerResult.insertId;

    // Get role id for the stockist level
    const [roleRow] = await conn.execute(
      'SELECT id FROM roles WHERE slug = ? LIMIT 1',
      [app.stockist_level]
    );
    if (roleRow.length === 0) throw ApiError.serverError('Role not found for stockist level');

    // Create user account
    await conn.execute(
      `INSERT INTO users (name, email, phone, password, role_id, partner_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [app.full_name, app.email, app.phone, hashed, roleRow[0].id, partnerId]
    );

    // Mark application approved
    await conn.execute(
      'UPDATE dta_applications SET status = \'approved\', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?',
      [req.user.id, id]
    );

    await conn.commit();

    // Send welcome email with credentials
    const tmpl = EMAIL.dtaApproved(app.full_name, app.email, tempPassword);
    await sendEmail({ to: app.email, toName: app.full_name, ...tmpl });

    res.json({ success: true, message: 'Application approved. Account created and credentials sent via email.' });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// PATCH /api/v1/applications/:id/reject
const rejectApplication = asyncHandler(async (req, res) => {
  const { notes } = req.body;
  await pool.execute(
    'UPDATE dta_applications SET status = \'rejected\', reviewed_by = ?, reviewed_at = NOW(), notes = COALESCE(?, notes) WHERE id = ?',
    [req.user.id, notes || null, req.params.id]
  );
  res.json({ success: true, message: 'Application rejected' });
});

module.exports = { getApplications, getApplication, submitDTA, approveApplication, rejectApplication };
