const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');

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

  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// POST /api/v1/mobile-stockists
const createMobileStockist = asyncHandler(async (req, res) => {
  const { name, email, phone, address, parent_partner_id } = req.body;
  if (!name || !email) throw ApiError.badRequest('name and email are required');

  const [existing] = await pool.execute(
    'SELECT id FROM mobile_stockists WHERE email = ? AND is_deleted = 0 LIMIT 1',
    [email]
  );
  if (existing.length > 0) throw ApiError.conflict('Email already registered as a Mobile Stockist');

  const parentId = parent_partner_id || req.user.partner_id;

  const [result] = await pool.execute(
    `INSERT INTO mobile_stockists (name, email, phone, address, partner_id, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [name, email, phone || null, address || null, parentId]
  );
  res.status(201).json({ success: true, message: 'Mobile Stockist created', data: { id: result.insertId } });
});

// PUT /api/v1/mobile-stockists/:id
const updateMobileStockist = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [existing] = await pool.execute('SELECT id FROM mobile_stockists WHERE id = ? AND is_deleted = 0', [id]);
  if (existing.length === 0) throw ApiError.notFound('Mobile Stockist not found');

  const { name, phone, address, status } = req.body;
  await pool.execute(
    `UPDATE mobile_stockists SET name = COALESCE(?, name), phone = COALESCE(?, phone),
     address = COALESCE(?, address), status = COALESCE(?, status) WHERE id = ?`,
    [name, phone, address, status, id]
  );
  res.json({ success: true, message: 'Mobile Stockist updated' });
});

module.exports = { getMobileStockists, createMobileStockist, updateMobileStockist };
