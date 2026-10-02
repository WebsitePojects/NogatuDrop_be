// Public sales by channel: the standard store (/shop) versus each influencer link (/kawoodee, ...).
// A public order belongs to an influencer link when it has an order_attribution row (written in the
// same transaction as the order, see orderController); every other public order is the store.
// Stockist and staff orders (placed_by_type 'user') are not public sales and are left out.

// Orders that never became sales; counted separately, excluded from sales figures.
const EXCLUDED_STATUSES_SQL = "('cancelled', 'rejected')";
const STORE_CHANNEL = 'store';
const STORE_LABEL = 'Standard store (/shop)';

const toCents = (value) => Math.round(Number(value || 0) * 100);
const fromCents = (cents) => cents / 100;

const channelKey = (slug) => (slug ? `influencer:${slug}` : STORE_CHANNEL);
const channelLabel = (slug) => (slug ? `Influencer link /${slug}` : STORE_LABEL);

/**
 * Two grouped queries for the month, independent of order volume: per-channel totals (units come
 * from a derived table limited to the same window) and a per-day series for the trend chart.
 * Money is accumulated in integer cents so shares and totals never drift by float error.
 */
async function getSalesChannelReport(db, { window }) {
  const counted = `o.status NOT IN ${EXCLUDED_STATUSES_SQL}`;
  const fromWhere = `
    FROM orders o
    LEFT JOIN order_attribution a ON a.order_id = o.id
    WHERE o.is_deleted = 0 AND o.placed_by_type = 'public'
      AND o.created_at >= ? AND o.created_at < ?`;
  const windowParams = [window.start, window.end];

  const [[groups], [daily], [links]] = await Promise.all([
    db.execute(
      `SELECT a.slug,
              COALESCE(SUM(${counted}), 0) AS orders,
              COALESCE(SUM(NOT (${counted})), 0) AS excluded_orders,
              COALESCE(SUM(${counted} AND o.payment_status = 'paid'), 0) AS paid_orders,
              COALESCE(SUM(CASE WHEN ${counted} THEN o.total_amount ELSE 0 END), 0) AS gross,
              COALESCE(SUM(CASE WHEN ${counted} AND o.payment_status = 'paid' THEN o.total_amount ELSE 0 END), 0) AS paid_gross,
              COALESCE(SUM(CASE WHEN ${counted} THEN u.units ELSE 0 END), 0) AS units
       FROM orders o
       LEFT JOIN order_attribution a ON a.order_id = o.id
       LEFT JOIN (
         SELECT oi.order_id, SUM(oi.quantity) AS units
         FROM order_items oi
         JOIN orders ow ON ow.id = oi.order_id
         WHERE ow.created_at >= ? AND ow.created_at < ? AND ow.placed_by_type = 'public'
         GROUP BY oi.order_id
       ) u ON u.order_id = o.id
       WHERE o.is_deleted = 0 AND o.placed_by_type = 'public'
         AND o.created_at >= ? AND o.created_at < ?
       GROUP BY a.slug`,
      [...windowParams, ...windowParams]
    ),
    db.execute(
      `SELECT DATE_FORMAT(o.created_at, '%Y-%m-%d') AS day, a.slug,
              COALESCE(SUM(${counted}), 0) AS orders,
              COALESCE(SUM(CASE WHEN ${counted} THEN o.total_amount ELSE 0 END), 0) AS gross
       ${fromWhere}
       GROUP BY day, a.slug
       ORDER BY day`,
      windowParams
    ),
    // Active links are listed even in a month without sales, so the comparison always shows them.
    db.execute('SELECT slug FROM influencer_links WHERE enabled = 1'),
  ]);

  const seen = new Set(groups.map((g) => g.slug || null));
  const zero = { orders: 0, excluded_orders: 0, paid_orders: 0, gross: 0, paid_gross: 0, units: 0 };
  if (!seen.has(null)) groups.push({ slug: null, ...zero });
  for (const { slug } of links) if (!seen.has(slug)) groups.push({ slug, ...zero });

  const totalGrossCents = groups.reduce((sum, g) => sum + toCents(g.gross), 0);
  const channels = groups
    .map((g) => {
      const orders = Number(g.orders);
      const grossCents = toCents(g.gross);
      return {
        channel: channelKey(g.slug),
        label: channelLabel(g.slug),
        slug: g.slug || null,
        orders,
        paid_orders: Number(g.paid_orders),
        excluded_orders: Number(g.excluded_orders),
        units: Number(g.units),
        gross_sales: fromCents(grossCents),
        paid_sales: fromCents(toCents(g.paid_gross)),
        average_order_value: orders > 0 ? fromCents(Math.round(grossCents / orders)) : 0,
        share_pct: totalGrossCents > 0 ? Math.round((grossCents / totalGrossCents) * 1000) / 10 : 0,
      };
    })
    // Store first, then influencer links by sales.
    .sort((a, b) => (a.channel === STORE_CHANNEL ? -1 : b.channel === STORE_CHANNEL ? 1 : b.gross_sales - a.gross_sales));

  const totals = channels.reduce((acc, c) => ({
    orders: acc.orders + c.orders,
    paid_orders: acc.paid_orders + c.paid_orders,
    excluded_orders: acc.excluded_orders + c.excluded_orders,
    units: acc.units + c.units,
    gross_cents: acc.gross_cents + toCents(c.gross_sales),
    paid_cents: acc.paid_cents + toCents(c.paid_sales),
  }), { orders: 0, paid_orders: 0, excluded_orders: 0, units: 0, gross_cents: 0, paid_cents: 0 });

  return {
    month: window.month,
    channels,
    totals: {
      orders: totals.orders,
      paid_orders: totals.paid_orders,
      excluded_orders: totals.excluded_orders,
      units: totals.units,
      gross_sales: fromCents(totals.gross_cents),
      paid_sales: fromCents(totals.paid_cents),
    },
    daily: daily.map((d) => ({
      day: d.day,
      channel: channelKey(d.slug),
      orders: Number(d.orders),
      gross_sales: fromCents(toCents(d.gross)),
    })),
  };
}

module.exports = { getSalesChannelReport, STORE_CHANNEL, channelKey, channelLabel };
