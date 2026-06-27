const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const cache = require('../services/cacheService');

const isMissingColumn = (err, columnName) => (
  err &&
  err.code === 'ER_BAD_FIELD_ERROR' &&
  String(err.message || '').includes(`'${columnName}'`)
);

// Helper: parse date param, return null if empty string
const parseDateParam = (val) => (val && val.trim() !== '' ? val.trim() : null);

// GET /api/v1/reports/revenue
const getRevenueReport = asyncHandler(async (req, res) => {
  const fromDate = parseDateParam(req.query.from);
  const toDate = parseDateParam(req.query.to);
  const cacheKey = `report:revenue:${req.user.role_slug}:${req.user.partner_id || 'all'}:${fromDate}:${toDate}`;

  const data = await cache.getOrSet(cacheKey, 300, async () => {
    let partnerFilter = '';
    const params = [];

    if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
      partnerFilter = 'AND o.partner_id = ?';
      params.push(req.user.partner_id);
    }

    let dateFilter = 'AND o.delivered_at >= DATE_SUB(NOW(), INTERVAL 8 WEEK)';
    if (fromDate) {
      dateFilter = 'AND o.delivered_at >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      dateFilter += ' AND o.delivered_at <= ?';
      params.push(toDate + ' 23:59:59');
    }

    // Weekly revenue trend
    const [weekly] = await pool.execute(`
      SELECT
        DATE_FORMAT(o.delivered_at, '%Y-%u') AS week_label,
        MIN(DATE(o.delivered_at)) AS week_start,
        COALESCE(SUM(o.total_amount), 0) AS revenue,
        COUNT(*) AS order_count
      FROM orders o
      WHERE o.status = 'delivered' AND o.payment_status = 'paid'
        AND o.is_deleted = 0 ${dateFilter}
        ${partnerFilter}
      GROUP BY week_label
      ORDER BY week_start ASC
    `, params);

    // Total revenue (no date filter)
    const totalParams = req.user.role_slug !== 'super_admin' && req.user.partner_id
      ? [req.user.partner_id] : [];
    const totalFilter = req.user.role_slug !== 'super_admin' && req.user.partner_id
      ? 'AND partner_id = ?' : '';
    const [total] = await pool.execute(`
      SELECT COALESCE(SUM(total_amount), 0) AS total_revenue,
             COUNT(*) AS total_orders
      FROM orders
      WHERE status = 'delivered' AND payment_status = 'paid' AND is_deleted = 0
        ${totalFilter}
    `, totalParams);

    // Revenue by source warehouse (powers the "Revenue by Warehouse" bar chart)
    const [byWarehouse] = await pool.execute(`
      SELECT w.name AS warehouse_name,
             COALESCE(SUM(o.total_amount), 0) AS revenue,
             COUNT(*) AS order_count
      FROM orders o
      JOIN warehouses w ON w.id = o.source_warehouse_id
      WHERE o.status = 'delivered' AND o.payment_status = 'paid'
        AND o.is_deleted = 0 ${dateFilter}
        ${partnerFilter}
      GROUP BY w.id, w.name
      ORDER BY revenue DESC
    `, params);

    // Revenue by stockist (public orders have no partner and are excluded here)
    const [byStockist] = await pool.execute(`
      SELECT p.business_name AS stockist_name,
             COUNT(*) AS total_orders,
             COALESCE(SUM(o.total_amount), 0) AS total_revenue,
             COALESCE(AVG(o.total_amount), 0) AS avg_order_value
      FROM orders o
      JOIN partners p ON p.id = o.partner_id
      WHERE o.status = 'delivered' AND o.payment_status = 'paid'
        AND o.is_deleted = 0 ${dateFilter}
        ${partnerFilter}
      GROUP BY p.id, p.business_name
      ORDER BY total_revenue DESC
    `, params);

    return {
      weekly_trend: weekly,
      total_revenue: total[0].total_revenue,
      total_orders: total[0].total_orders,
      by_warehouse: byWarehouse,
      by_stockist: byStockist,
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

// GET /api/v1/reports/movements
const getMovementsReport = asyncHandler(async (req, res) => {
  const fromDate = parseDateParam(req.query.from);
  const toDate = parseDateParam(req.query.to);
  const cacheKey = `report:movements:${req.user.role_slug}:${req.user.partner_id || 'all'}:${fromDate}:${toDate}`;

  const data = await cache.getOrSet(cacheKey, 120, async () => {
    const buildQuery = ({ includeSoftDelete = true, partnerScope = 'warehouse' } = {}) => {
      const whereParts = [];
      const params = [];

      if (includeSoftDelete) {
        whereParts.push('sm.is_deleted = 0');
      }

      // Filter by partner; fallback can scope via inventory ownership on older schemas.
      if (req.user.role_slug !== 'super_admin' && req.user.partner_id) {
        if (partnerScope === 'warehouse') {
          whereParts.push('w.partner_id = ?');
        } else {
          whereParts.push('i.partner_id = ?');
        }
        params.push(req.user.partner_id);
      }

      if (fromDate) {
        whereParts.push('sm.created_at >= ?');
        params.push(fromDate);
      }
      if (toDate) {
        whereParts.push('sm.created_at <= ?');
        params.push(toDate + ' 23:59:59');
      }

      const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
      return {
        sql: `
          SELECT sm.id, sm.movement_type, sm.quantity, sm.reference_type, sm.reference_id,
                 sm.notes, sm.created_at,
                 p.name AS product_name, p.sku,
                 w.name AS warehouse_name
          FROM stock_movements sm
          JOIN inventories i ON i.id = sm.inventory_id
          JOIN products p ON p.id = i.product_id
          JOIN warehouses w ON w.id = i.warehouse_id
          ${whereClause}
          ORDER BY sm.created_at DESC
          LIMIT 200
        `,
        params,
      };
    };

    const variants = [
      { includeSoftDelete: true, partnerScope: 'warehouse' },
      { includeSoftDelete: false, partnerScope: 'warehouse' },
      { includeSoftDelete: false, partnerScope: 'inventory' },
      { includeSoftDelete: true, partnerScope: 'inventory' },
    ];

    let movements = [];
    let finalError = null;

    for (const variant of variants) {
      const query = buildQuery(variant);
      try {
        [movements] = await pool.execute(query.sql, query.params);
        finalError = null;
        break;
      } catch (err) {
        if (
          isMissingColumn(err, 'sm.is_deleted') ||
          isMissingColumn(err, 'w.partner_id') ||
          isMissingColumn(err, 'i.partner_id')
        ) {
          finalError = err;
          continue;
        }
        throw err;
      }
    }

    if (finalError) {
      throw finalError;
    }

    return { movements };
  });

  res.json({ success: true, data });
});

module.exports = { getRevenueReport, getPurchaseReport, getProductReport, getMovementsReport };
