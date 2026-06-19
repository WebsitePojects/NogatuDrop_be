const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const paginate = require('../utils/paginate');

const isMissingColumnError = (err) => err && err.code === 'ER_BAD_FIELD_ERROR';

// GET /api/v1/couriers
const getCouriers = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const params = [];

  try {
    const where = 'WHERE is_deleted = 0';
    const baseQuery = `SELECT * FROM couriers ${where} ORDER BY CASE WHEN LOWER(name) LIKE 'j&t%' OR LOWER(name) LIKE 'jt%' THEN 0 ELSE 1 END, name ASC`;
    const countQuery = `SELECT COUNT(*) AS total FROM couriers ${where}`;
    const result = await paginate(baseQuery, countQuery, params, page, limit);
    res.json({ success: true, ...result });
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;

    const baseQuery = "SELECT * FROM couriers ORDER BY CASE WHEN LOWER(name) LIKE 'j&t%' OR LOWER(name) LIKE 'jt%' THEN 0 ELSE 1 END, name ASC";
    const countQuery = 'SELECT COUNT(*) AS total FROM couriers';
    const result = await paginate(baseQuery, countQuery, params, page, limit);
    res.json({ success: true, ...result });
  }
});

// POST /api/v1/couriers
const createCourier = asyncHandler(async (req, res) => {
  const name = (req.body.name || '').trim();
  const code = (req.body.code || '').trim().toUpperCase();
  const trackingUrlTemplate = req.body.tracking_url_template || req.body.tracking_url || null;
  const contactPerson = req.body.contact_person || req.body.contact_name || null;
  const contactPhone = req.body.contact_phone || null;
  const contactEmail = req.body.contact_email || null;
  const websiteUrl = req.body.website_url || null;
  const notes = req.body.notes || null;
  const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : 1;

  if (!name) throw ApiError.badRequest('name is required');
  if (!code) throw ApiError.badRequest('code is required');

  let result;

  try {
    [result] = await pool.execute(
      `INSERT INTO couriers (name, code, tracking_url_template, contact_person, contact_phone, contact_email, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, code, trackingUrlTemplate, contactPerson, contactPhone, contactEmail, isActive]
    );
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    [result] = await pool.execute(
      `INSERT INTO couriers (name, website_url, tracking_url_template, notes)
       VALUES (?, ?, ?, ?)`,
      [name, websiteUrl, trackingUrlTemplate, notes]
    );
  }

  res.status(201).json({ success: true, message: 'Courier created', data: { id: result.insertId } });
});

// PUT /api/v1/couriers/:id
const updateCourier = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    const [existing] = await pool.execute('SELECT id FROM couriers WHERE id = ? AND is_deleted = 0', [id]);
    if (existing.length === 0) throw ApiError.notFound('Courier not found');
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const [existing] = await pool.execute('SELECT id FROM couriers WHERE id = ?', [id]);
    if (existing.length === 0) throw ApiError.notFound('Courier not found');
  }

  const name = req.body.name || null;
  const code = req.body.code || null;
  const trackingUrlTemplate = req.body.tracking_url_template || req.body.tracking_url || null;
  const contactPerson = req.body.contact_person || req.body.contact_name || null;
  const contactPhone = req.body.contact_phone || null;
  const contactEmail = req.body.contact_email || null;
  const websiteUrl = req.body.website_url || null;
  const notes = req.body.notes || null;
  const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : null;

  try {
    await pool.execute(
      `UPDATE couriers SET name = COALESCE(?, name), code = COALESCE(?, code),
       tracking_url_template = COALESCE(?, tracking_url_template), contact_person = COALESCE(?, contact_person),
       contact_phone = COALESCE(?, contact_phone), contact_email = COALESCE(?, contact_email),
       is_active = COALESCE(?, is_active) WHERE id = ?`,
      [name, code, trackingUrlTemplate, contactPerson, contactPhone, contactEmail, isActive, id]
    );
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    await pool.execute(
      `UPDATE couriers SET name = COALESCE(?, name), website_url = COALESCE(?, website_url),
       tracking_url_template = COALESCE(?, tracking_url_template), is_active = COALESCE(?, is_active),
       notes = COALESCE(?, notes) WHERE id = ?`,
      [name, websiteUrl, trackingUrlTemplate, isActive, notes, id]
    );
  }

  res.json({ success: true, message: 'Courier updated' });
});

// DELETE /api/v1/couriers/:id
const deleteCourier = asyncHandler(async (req, res) => {
  const { id } = req.params;

  try {
    const [existing] = await pool.execute('SELECT id FROM couriers WHERE id = ? AND is_deleted = 0', [id]);
    if (existing.length === 0) throw ApiError.notFound('Courier not found');
    await pool.execute('UPDATE couriers SET is_deleted = 1 WHERE id = ?', [id]);
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const [existing] = await pool.execute('SELECT id FROM couriers WHERE id = ?', [id]);
    if (existing.length === 0) throw ApiError.notFound('Courier not found');
    await pool.execute('UPDATE couriers SET is_active = 0 WHERE id = ?', [id]);
  }

  res.json({ success: true, message: 'Courier deleted' });
});

module.exports = { getCouriers, createCourier, updateCourier, deleteCourier };
