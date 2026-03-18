const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const cache = require('../services/cacheService');

// GET /api/v1/dashboard/kpis
const getKPIs = asyncHandler(async (req, res) => {
  const cacheKey = `dashboard:kpis:${req.user.role_slug}:${req.user.partner_id || 'all'}`;

  const data = await cache.getOrSet(cacheKey, 120, async () => {
    if (req.user.role_slug === 'super_admin') {
      // Use the view for super admin
      const [rows] = await pool.execute('SELECT * FROM vw_dashboard_kpis');
      return rows[0];
    }

    // Partner-scoped KPIs
    const partnerId = req.user.partner_id;
    const params = [partnerId];

    const [revenue] = await pool.execute(
      `SELECT COALESCE(SUM(total_amount), 0) AS total_revenue
       FROM orders WHERE status = 'delivered' AND payment_status = 'paid' AND is_deleted = 0 AND partner_id = ?`,
      params
    );

    const [pending] = await pool.execute(
      `SELECT COUNT(*) AS pending_orders
       FROM orders WHERE status = 'pending' AND is_deleted = 0 AND partner_id = ?`,
      params
    );

    const [totalOrders] = await pool.execute(
      `SELECT COUNT(*) AS total_orders
       FROM orders WHERE is_deleted = 0 AND partner_id = ?`,
      params
    );

    const [delivered] = await pool.execute(
      `SELECT COUNT(*) AS delivered_orders
       FROM orders WHERE status = 'delivered' AND is_deleted = 0 AND partner_id = ?`,
      params
    );

    return {
      total_revenue: revenue[0].total_revenue,
      pending_orders: pending[0].pending_orders,
      total_orders: totalOrders[0].total_orders,
      delivered_orders: delivered[0].delivered_orders,
    };
  });

  res.json({ success: true, data });
});

// GET /api/v1/dashboard/recent-orders
const getRecentOrders = asyncHandler(async (req, res) => {
  const cacheKey = `dashboard:recent:${req.user.role_slug}:${req.user.partner_id || 'all'}`;

  const data = await cache.getOrSet(cacheKey, 120, async () => {
    let where = 'WHERE o.is_deleted = 0';
    const params = [];

    if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
      where += ' AND o.partner_id = ?';
      params.push(req.user.partner_id);
    }

    const [orders] = await pool.execute(`
      SELECT o.id, o.order_number, o.status, o.payment_status, o.total_amount,
             o.created_at, pt.business_name AS partner_name, u.name AS placed_by_name
      FROM orders o
      JOIN partners pt ON pt.id = o.partner_id
      JOIN users u ON u.id = o.placed_by
      ${where}
      ORDER BY o.created_at DESC
      LIMIT 10
    `, params);

    return orders;
  });

  res.json({ success: true, data });
});

module.exports = { getKPIs, getRecentOrders };
