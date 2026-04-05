const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');

// GET /api/v1/couriers
const getCouriers = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const params = [];
  const where = 'WHERE is_deleted = 0';
  const baseQuery = `SELECT * FROM couriers ${where} ORDER BY name ASC`;
  const countQuery = `SELECT COUNT(*) AS total FROM couriers ${where}`;
  const result = await paginate(baseQuery, countQuery, params, page, limit);
  res.json({ success: true, ...result });
});

// POST /api/v1/couriers
const createCourier = asyncHandler(async (req, res) => {
  const { name, website_url, tracking_url_template, notes } = req.body;
  if (!name) throw ApiError.badRequest('name is required');

  const [result] = await pool.execute(
    `INSERT INTO couriers (name, website_url, tracking_url_template, notes) VALUES (?, ?, ?, ?)`,
    [name, website_url || null, tracking_url_template || null, notes || null]
  );
  res.status(201).json({ success: true, message: 'Courier created', data: { id: result.insertId } });
});

// PUT /api/v1/couriers/:id
const updateCourier = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [existing] = await pool.execute('SELECT id FROM couriers WHERE id = ? AND is_deleted = 0', [id]);
  if (existing.length === 0) throw ApiError.notFound('Courier not found');

  const { name, website_url, tracking_url_template, is_active, notes } = req.body;
  await pool.execute(
    `UPDATE couriers SET name = COALESCE(?, name), website_url = COALESCE(?, website_url),
     tracking_url_template = COALESCE(?, tracking_url_template), is_active = COALESCE(?, is_active),
     notes = COALESCE(?, notes) WHERE id = ?`,
    [name, website_url, tracking_url_template, is_active !== undefined ? is_active : null, notes, id]
  );
  res.json({ success: true, message: 'Courier updated' });
});

module.exports = { getCouriers, createCourier, updateCourier };
