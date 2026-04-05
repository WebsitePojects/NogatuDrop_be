/**
 * Alliance API Bridge — read-only endpoints for nogatualliance.com
 * Protected by X-Alliance-API-Key header
 */
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const paginate = require('../utils/paginate');

function allianceAuth(req, res, next) {
  const key = req.headers['x-alliance-api-key'];
  if (!key || key !== env.ALLIANCE_API_KEY) {
    return next(ApiError.unauthorized('Invalid or missing Alliance API key'));
  }
  next();
}

// GET /api/v1/alliance/stockists
const getStockists = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const where = 'WHERE p.is_deleted = 0';
  const baseQuery = `
    SELECT p.id, p.business_name, p.email, p.phone, p.address,
           p.stockist_level, p.discount_pct, p.parent_partner_id, p.created_at
    FROM partners p ${where} ORDER BY p.created_at DESC`;
  const countQuery = `SELECT COUNT(*) AS total FROM partners p ${where}`;
  const result = await paginate(baseQuery, countQuery, [], page, limit);
  res.json({ success: true, ...result });
});

// GET /api/v1/alliance/sales
const getSales = asyncHandler(async (req, res) => {
  const { date_from, date_to } = req.query;
  const params = [];
  let where = 'WHERE o.status = \'delivered\' AND o.is_deleted = 0';
  if (date_from) { where += ' AND DATE(o.delivered_at) >= ?'; params.push(date_from); }
  if (date_to) { where += ' AND DATE(o.delivered_at) <= ?'; params.push(date_to); }

  const [rows] = await pool.execute(
    `SELECT o.id, o.order_number, o.partner_id, p.business_name AS stockist_name,
            o.total_amount, o.delivered_at,
            p.stockist_level
     FROM orders o
     JOIN partners p ON p.id = o.partner_id
     ${where} ORDER BY o.delivered_at DESC`,
    params
  );

  const totalSales = rows.reduce((sum, r) => sum + parseFloat(r.total_amount || 0), 0);
  res.json({ success: true, data: { total_sales: totalSales, orders: rows } });
});

// GET /api/v1/alliance/mobile-stockists
const getMobileStockists = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const where = 'WHERE ms.is_deleted = 0';
  const baseQuery = `
    SELECT ms.id, ms.name, ms.email, ms.phone, ms.address,
           ms.parent_partner_id, p.business_name AS parent_name, ms.created_at
    FROM mobile_stockists ms
    LEFT JOIN partners p ON p.id = ms.parent_partner_id
    ${where} ORDER BY ms.created_at DESC`;
  const countQuery = `SELECT COUNT(*) AS total FROM mobile_stockists ms ${where}`;
  const result = await paginate(baseQuery, countQuery, [], page, limit);
  res.json({ success: true, ...result });
});

module.exports = { allianceAuth, getStockists, getSales, getMobileStockists };
