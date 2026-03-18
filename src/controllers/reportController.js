const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const cache = require('../services/cacheService');

// GET /api/v1/reports/revenue
const getRevenueReport = asyncHandler(async (req, res) => {
  const cacheKey = `report:revenue:${req.user.role_slug}:${req.user.partner_id || 'all'}`;

  const data = await cache.getOrSet(cacheKey, 300, async () => {
    let partnerFilter = '';
    const params = [];

    if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
      partnerFilter = 'AND o.partner_id = ?';
      params.push(req.user.partner_id);
    }

    // Weekly revenue trend (last 8 weeks)
    const [weekly] = await pool.execute(`
      SELECT
        DATE_FORMAT(o.delivered_at, '%Y-%u') AS week_label,
        MIN(DATE(o.delivered_at)) AS week_start,
        COALESCE(SUM(o.total_amount), 0) AS revenue,
        COUNT(*) AS order_count
      FROM orders o
      WHERE o.status = 'delivered' AND o.payment_status = 'paid'
        AND o.is_deleted = 0 AND o.delivered_at >= DATE_SUB(NOW(), INTERVAL 8 WEEK)
        ${partnerFilter}
      GROUP BY week_label
      ORDER BY week_start ASC
    `, params);

    // Total revenue
    const [total] = await pool.execute(`
      SELECT COALESCE(SUM(total_amount), 0) AS total_revenue,
             COUNT(*) AS total_orders
      FROM orders
      WHERE status = 'delivered' AND payment_status = 'paid' AND is_deleted = 0
        ${partnerFilter}
    `, params);

    return {
      weekly_trend: weekly,
      total_revenue: total[0].total_revenue,
      total_orders: total[0].total_orders,
    };
  });

  res.json({ success: true, data });
});

// GET /api/v1/reports/purchases
const getPurchaseReport = asyncHandler(async (req, res) => {
  const cacheKey = `report:purchases:${req.user.partner_id || 'all'}`;

  const data = await cache.getOrSet(cacheKey, 300, async () => {
    let where = 'WHERE o.is_deleted = 0';
    const params = [];

    if (req.user.partner_id) {
      where += ' AND o.partner_id = ?';
      params.push(req.user.partner_id);
    }

    const [purchases] = await pool.execute(`
      SELECT o.id, o.order_number, o.status, o.payment_status, o.total_amount,
             o.created_at, o.delivered_at, pt.business_name AS partner_name
      FROM orders o
      JOIN partners pt ON pt.id = o.partner_id
      ${where}
      ORDER BY o.created_at DESC
      LIMIT 100
    `, params);

    // Monthly summary
    const [monthly] = await pool.execute(`
      SELECT DATE_FORMAT(o.created_at, '%Y-%m') AS month,
             COUNT(*) AS order_count,
             COALESCE(SUM(o.total_amount), 0) AS total_amount,
             SUM(CASE WHEN o.status = 'delivered' THEN 1 ELSE 0 END) AS delivered_count
      FROM orders o
      ${where}
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `, params);

    return { purchases, monthly_summary: monthly };
  });

  res.json({ success: true, data });
});

// GET /api/v1/reports/products
const getProductReport = asyncHandler(async (req, res) => {
  const cacheKey = `report:products:${req.user.role_slug}:${req.user.partner_id || 'all'}`;

  const data = await cache.getOrSet(cacheKey, 300, async () => {
    let partnerFilter = '';
    const params = [];

    if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
      partnerFilter = 'AND o.partner_id = ?';
      params.push(req.user.partner_id);
    }

    const [products] = await pool.execute(`
      SELECT p.id, p.name, p.sku, p.category,
             COALESCE(SUM(oi.quantity), 0) AS total_qty_sold,
             COALESCE(SUM(oi.subtotal), 0) AS total_revenue,
             COUNT(DISTINCT o.id) AS order_count
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'delivered' AND o.payment_status = 'paid' AND o.is_deleted = 0
        ${partnerFilter}
      WHERE p.is_deleted = 0
      GROUP BY p.id, p.name, p.sku, p.category
      ORDER BY total_revenue DESC
    `, params);

    return { products };
  });

  res.json({ success: true, data });
});

module.exports = { getRevenueReport, getPurchaseReport, getProductReport };
