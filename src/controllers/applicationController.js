const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');
const bcrypt = require('bcryptjs');
const { sendEmail, EMAIL } = require('../services/emailService');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

const isApplicationSchemaMismatch = (err) => (
  isMissingColumn(err, 'full_name') ||
  isMissingColumn(err, 'stockist_level') ||
  isMissingColumn(err, 'id_front_url') ||
  isMissingColumn(err, 'id_back_url') ||
  isMissingColumn(err, 'notes') ||
  isMissingColumn(err, 'is_deleted')
);

const normalizeApplication = (row = {}) => ({
  ...row,
  full_name: row.full_name || row.applicant_name || null,
  stockist_level: row.stockist_level || row.requested_level || null,
  id_front_url: row.id_front_url || row.id_document_url || null,
  id_back_url: row.id_back_url || row.business_permit_url || null,
  notes: row.notes || row.message || row.rejection_reason || null,
});

async function getActiveSuperAdmins() {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active'`
    );
    return rows;
  } catch (err) {
    if (!isMissingColumn(err, 'is_deleted')) {
      throw err;
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.slug = 'super_admin' AND u.status = 'active'`
    );
    return rows;
  }
}

// GET /api/v1/applications
const getApplications = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const oldParams = [];
  let oldWhere = 'WHERE is_deleted = 0';
  if (status) {
    oldWhere += ' AND status = ?';
    oldParams.push(status);
  }

  const oldBaseQuery = `
    SELECT id, full_name, business_name, email, phone, address, stockist_level,
           id_front_url, id_back_url, status, notes, created_at, reviewed_at
    FROM dta_applications ${oldWhere}
    ORDER BY created_at DESC`;
  const oldCountQuery = `SELECT COUNT(*) AS total FROM dta_applications ${oldWhere}`;

  const newParams = [];
  let newWhere = 'WHERE 1=1';
  if (status) {
    newWhere += ' AND status = ?';
    newParams.push(status);
  }

  const newBaseQuery = `
    SELECT id,
           applicant_name AS full_name,
           business_name,
           email,
           phone,
           address,
           requested_level AS stockist_level,
           id_document_url AS id_front_url,
           business_permit_url AS id_back_url,
           status,
           message AS notes,
           reviewed_at,
           created_at
    FROM dta_applications ${newWhere}
    ORDER BY created_at DESC`;
  const newCountQuery = `SELECT COUNT(*) AS total FROM dta_applications ${newWhere}`;

  let result;
  try {
    result = await paginate(oldBaseQuery, oldCountQuery, oldParams, page, limit);
  } catch (err) {
    if (!isApplicationSchemaMismatch(err)) {
      throw err;
    }
    result = await paginate(newBaseQuery, newCountQuery, newParams, page, limit);
  }

  result.data = result.data.map(normalizeApplication);
  res.json({ success: true, ...result });
});

// GET /api/v1/applications/:id
const getApplication = asyncHandler(async (req, res) => {
  let rows;
  try {
    [rows] = await pool.execute(
      'SELECT * FROM dta_applications WHERE id = ? AND is_deleted = 0 LIMIT 1',
      [req.params.id]
    );
  } catch (err) {
    if (!isMissingColumn(err, 'is_deleted')) {
      throw err;
    }
    [rows] = await pool.execute(
      'SELECT * FROM dta_applications WHERE id = ? LIMIT 1',
      [req.params.id]
    );
  }

  if (rows.length === 0) throw ApiError.notFound('Application not found');
  res.json({ success: true, data: normalizeApplication(rows[0]) });
});

// POST /api/v1/applications/dta — public, no auth
const submitDTA = asyncHandler(async (req, res) => {
  const fullName = req.body.full_name || req.body.applicant_name;
  const businessName = req.body.business_name || null;
  const email = req.body.email;
  const phone = req.body.phone;
  const address = req.body.address;
  const stockistLevel = req.body.stockist_level || req.body.requested_level;
  const notes = req.body.notes || req.body.message || null;

  if (!fullName || !email || !phone || !address || !stockistLevel) {
    throw ApiError.badRequest('full_name, email, phone, address, and stockist_level are required');
  }
  if (!['provincial_stockist', 'city_stockist'].includes(stockistLevel)) {
    throw ApiError.badRequest('stockist_level must be provincial_stockist or city_stockist');
  }

  const [existing] = await pool.execute(
    `SELECT id FROM dta_applications WHERE email = ? AND status IN ('pending', 'approved') LIMIT 1`,
    [email]
  );
  if (existing.length > 0) throw ApiError.conflict('An application with this email already exists');

  const idFrontUrl = req.files?.id_front?.[0]?.path || null;
  const idBackUrl = req.files?.id_back?.[0]?.path || null;

  let result;
  try {
    [result] = await pool.execute(
      `INSERT INTO dta_applications (full_name, business_name, email, phone, address, stockist_level, id_front_url, id_back_url, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fullName, businessName, email, phone, address, stockistLevel, idFrontUrl, idBackUrl, notes]
    );
  } catch (err) {
    if (!isApplicationSchemaMismatch(err)) {
      throw err;
    }

    [result] = await pool.execute(
      `INSERT INTO dta_applications (applicant_name, business_name, email, phone, address, requested_level, id_document_url, business_permit_url, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fullName, businessName, email, phone, address, stockistLevel, idFrontUrl, idBackUrl, notes]
    );
  }

  // Notify all super admins
  const admins = await getActiveSuperAdmins();

  for (const admin of admins) {
    const tmpl = EMAIL.dtaReceived(fullName, businessName || email);
    await sendEmail({ to: admin.email, toName: admin.name, ...tmpl });

    await pool.execute(
      `INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id)
       VALUES (?, 'dta_received', ?, ?, 'application', ?)`,
      [admin.id, `New Stockist Application: ${fullName}`, `${fullName} applied for ${stockistLevel.replace('_', ' ')}.`, result.insertId]
    );
  }

  res.status(201).json({ success: true, message: 'Application submitted successfully. We will contact you soon.' });
});

// PATCH /api/v1/applications/:id/approve
const approveApplication = asyncHandler(async (req, res) => {
  const { id } = req.params;
  let rows;
  try {
    [rows] = await pool.execute(
      'SELECT * FROM dta_applications WHERE id = ? AND status = \'pending\' AND is_deleted = 0 LIMIT 1',
      [id]
    );
  } catch (err) {
    if (!isMissingColumn(err, 'is_deleted')) {
      throw err;
    }
    [rows] = await pool.execute(
      'SELECT * FROM dta_applications WHERE id = ? AND status = \'pending\' LIMIT 1',
      [id]
    );
  }

  if (rows.length === 0) throw ApiError.notFound('Pending application not found');

  const app = normalizeApplication(rows[0]);
  const fullName = app.full_name;
  const stockistLevel = app.stockist_level;

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
      [app.business_name || fullName, app.email, app.phone, app.address, stockistLevel]
    );
    const partnerId = partnerResult.insertId;

    // Get role id for the stockist level
    const [roleRow] = await conn.execute(
      'SELECT id FROM roles WHERE slug = ? LIMIT 1',
      [stockistLevel]
    );
    if (roleRow.length === 0) throw ApiError.serverError('Role not found for stockist level');

    // Create user account
    await conn.execute(
      `INSERT INTO users (name, email, phone, password, role_id, partner_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [fullName, app.email, app.phone, hashed, roleRow[0].id, partnerId]
    );

    // Mark application approved
    try {
      await conn.execute(
        'UPDATE dta_applications SET status = \'approved\', reviewed_by = ?, reviewed_at = NOW(), created_partner_id = ? WHERE id = ?',
        [req.user.id, partnerId, id]
      );
    } catch (err) {
      if (!isMissingColumn(err, 'created_partner_id')) {
        throw err;
      }
      await conn.execute(
        'UPDATE dta_applications SET status = \'approved\', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?',
        [req.user.id, id]
      );
    }

    await conn.commit();

    // Send welcome email with credentials
    const tmpl = EMAIL.dtaApproved(fullName, app.email, tempPassword);
    await sendEmail({ to: app.email, toName: fullName, ...tmpl });

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
  const reason = req.body?.notes || req.body?.reason || null;

  try {
    await pool.execute(
      'UPDATE dta_applications SET status = \'rejected\', reviewed_by = ?, reviewed_at = NOW(), notes = COALESCE(?, notes) WHERE id = ?',
      [req.user.id, reason, req.params.id]
    );
  } catch (err) {
    if (!isMissingColumn(err, 'notes')) {
      throw err;
    }

    await pool.execute(
      'UPDATE dta_applications SET status = \'rejected\', reviewed_by = ?, reviewed_at = NOW(), rejection_reason = COALESCE(?, rejection_reason) WHERE id = ?',
      [req.user.id, reason, req.params.id]
    );
  }

  res.json({ success: true, message: 'Application rejected' });
});

module.exports = { getApplications, getApplication, submitDTA, approveApplication, rejectApplication };
