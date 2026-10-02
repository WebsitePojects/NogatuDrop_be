const ApiError = require('../utils/ApiError');
const { toCsv } = require('../utils/csvExport');
const { orderCustomerJoins, orderCustomerAddressSql } = require('../utils/orderCustomerSql');

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MIN_REPORT_YEAR = 2000;
const MAX_REPORT_YEAR = 2100;

// Orders that never became sales. They stay in the row list (nothing hidden)
// but are excluded from order_count and gross_sales.
const EXCLUDED_STATUSES_SQL = "('cancelled', 'rejected')";

// JSON responses stay small for the screen; the CSV export is the full dataset.
const JSON_ROW_LIMIT = 1000;
const EXPORT_ROW_LIMIT = 20000;

const UNSPECIFIED_PROVIDER = 'UNSPECIFIED';
const UNASSIGNED_CENTER = 'UNASSIGNED';

const CSV_HEADERS = [
  'Order Number',
  'Order Date/Time (Asia/Manila)',
  'Influencer',
  'Payment Provider',
  'Fulfillment Center',
  'Customer Location',
  'Total Amount (PHP)',
  'Order Status',
  'Payment Status',
];

const pad2 = (n) => String(n).padStart(2, '0');

/** Current YYYY-MM as read on a clock in Asia/Manila, regardless of the server's zone. */
function currentManilaMonth(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  return `${year}-${month}`;
}

/**
 * Validate `?month=` and return the half-open window [start, end) as Manila
 * wall-clock strings. The DB session runs at +08:00, so they compare directly
 * against timestamp columns. Missing/empty means the current Manila month.
 */
function parseReportMonth(input, now = new Date()) {
  const raw = input === undefined || input === '' ? currentManilaMonth(now) : input;
  const match = typeof raw === 'string' ? MONTH_PATTERN.exec(raw) : null;
  if (!match) throw ApiError.badRequest('month must be in YYYY-MM format');

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < MIN_REPORT_YEAR || year > MAX_REPORT_YEAR) {
    throw ApiError.badRequest(`month year must be between ${MIN_REPORT_YEAR} and ${MAX_REPORT_YEAR}`);
  }

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    month: `${match[1]}-${match[2]}`,
    start: `${match[1]}-${match[2]}-01 00:00:00`,
    end: `${nextYear}-${pad2(nextMonth)}-01 00:00:00`,
  };
}

const toCents = (decimalText) => Math.round(Number(decimalText) * 100);
const fromCents = (cents) => cents / 100;

function addTo(map, key, orders, cents) {
  const entry = map.get(key) || { orders: 0, cents: 0 };
  entry.orders += orders;
  entry.cents += cents;
  map.set(key, entry);
}

const breakdown = (map, labelKey) => [...map.entries()]
  .filter(([, entry]) => entry.orders > 0)
  .map(([label, entry]) => ({ [labelKey]: label, orders: entry.orders, gross: fromCents(entry.cents) }))
  .sort((a, b) => b.gross - a.gross || String(a[labelKey]).localeCompare(String(b[labelKey])));

/**
 * Fold the (provider, center) groups the DB returned into the summary block.
 * Money is summed as integer cents so the total never drifts by float error.
 */
function buildSummary(groups) {
  const byProvider = new Map();
  const byCenter = new Map();
  let orderCount = 0;
  let excludedOrderCount = 0;
  let grossCents = 0;

  for (const group of groups) {
    const orders = Number(group.counted_orders);
    const cents = toCents(group.gross);
    orderCount += orders;
    excludedOrderCount += Number(group.excluded_orders);
    grossCents += cents;
    addTo(byProvider, group.provider_label, orders, cents);
    addTo(byCenter, group.center_label, orders, cents);
  }

  return {
    order_count: orderCount,
    excluded_order_count: excludedOrderCount,
    gross_sales: fromCents(grossCents),
    by_provider: breakdown(byProvider, 'provider'),
    by_center: breakdown(byCenter, 'center'),
  };
}

/**
 * Influencer sales for one month, optionally for one slug.
 * Two set-based queries regardless of volume: grouped totals (never capped) and
 * the order rows (capped at `rowLimit`; `truncated` says so).
 * Filters on orders.created_at, the order's real placement time, not the
 * attribution row's.
 */
async function getInfluencerReportData(db, { window, slug, rowLimit }) {
  const slugClause = slug ? ' AND a.slug = ?' : '';
  const params = slug ? [window.start, window.end, slug] : [window.start, window.end];
  const from = `
    FROM order_attribution a
    JOIN orders o ON o.id = a.order_id
    LEFT JOIN warehouses w ON w.id = o.source_warehouse_id`;
  const where = `
    WHERE o.is_deleted = 0 AND o.created_at >= ? AND o.created_at < ?${slugClause}`;
  const fromWhere = `${from}${where}`;
  const fromWhereWithCustomer = `${from}
    ${orderCustomerJoins('o')}${where}`;

  const [[groups], [rows]] = await Promise.all([
    db.execute(
      `SELECT COALESCE(NULLIF(o.payment_provider, ''), '${UNSPECIFIED_PROVIDER}') AS provider_label,
              COALESCE(w.name, '${UNASSIGNED_CENTER}') AS center_label,
              COALESCE(SUM(o.status NOT IN ${EXCLUDED_STATUSES_SQL}), 0) AS counted_orders,
              COALESCE(SUM(o.status IN ${EXCLUDED_STATUSES_SQL}), 0) AS excluded_orders,
              COALESCE(SUM(CASE WHEN o.status NOT IN ${EXCLUDED_STATUSES_SQL} THEN o.total_amount ELSE 0 END), 0) AS gross
       ${fromWhere}
       GROUP BY provider_label, center_label`,
      params,
    ),
    db.execute(
      `SELECT o.order_number, o.created_at, a.slug AS influencer_slug, o.payment_provider,
              w.name AS fulfillment_center, ${orderCustomerAddressSql('o')} AS customer_location,
              o.total_amount, o.status, o.payment_status
       ${fromWhereWithCustomer}
       ORDER BY o.created_at ASC, o.id ASC
       LIMIT ?`,
      // mysql2 prepared statements reject a numeric LIMIT bind; same convention as utils/paginate.
      [...params, String(rowLimit)],
    ),
  ]);

  const summary = buildSummary(groups);
  const totalOrders = summary.order_count + summary.excluded_order_count;
  return {
    month: window.month,
    slug: slug || null,
    summary,
    rows: rows.map((row) => ({ ...row, total_amount: Number(row.total_amount) })),
    row_limit: rowLimit,
    truncated: totalOrders > rows.length,
  };
}

/** Render report rows as the Excel-friendly CSV document (BOM included). */
function reportRowsToCsv(rows) {
  return toCsv(CSV_HEADERS, rows.map((row) => [
    row.order_number,
    row.created_at,
    row.influencer_slug,
    row.payment_provider,
    row.fulfillment_center,
    row.customer_location,
    Number(row.total_amount).toFixed(2),
    row.status,
    row.payment_status,
  ]));
}

module.exports = {
  parseReportMonth,
  buildSummary,
  getInfluencerReportData,
  reportRowsToCsv,
  JSON_ROW_LIMIT,
  EXPORT_ROW_LIMIT,
};
