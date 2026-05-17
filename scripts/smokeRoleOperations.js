const pool = require('../src/config/db');

const baseURL = process.env.TEST_BASE_URL || 'http://localhost:5000/api/v1';

const accounts = [
  { role: 'super_admin', email: 'superadmin@nogatu.com', password: '1' },
  { role: 'provincial_stockist', email: 'provincial@nogatu.com', password: '1' },
  { role: 'city_stockist', email: 'city@nogatu.com', password: '1' },
  { role: 'staff', email: 'staff@nogatu.com', password: '1' },
  { role: 'mobile_stockist', email: 'mobile@nogatu.com', password: '1' },
];

const endpointChecks = [
  { key: 'me', path: '/auth/me' },
  { key: 'dashboard', path: '/dashboard/kpis' },
  { key: 'orders', path: '/orders?limit=5' },
  { key: 'inventory', path: '/inventory?limit=5' },
  { key: 'grn', path: '/grn?limit=5' },
  { key: 'stockTransfers', path: '/stock-transfers?limit=5' },
  { key: 'users', path: '/users?limit=5' },
  { key: 'mobileStockists', path: '/mobile-stockists?page=1&limit=5&search=' },
  { key: 'settlements', path: '/settlements?limit=5' },
  { key: 'cycleCounts', path: '/cycle-counts?limit=5' },
  { key: 'reportsRevenue', path: '/reports/revenue' },
  { key: 'stockAdjustments', path: '/stock-adjustments?limit=5' },
  { key: 'trackingActive', path: '/tracking/active' },
];

const expectedStatuses = {
  super_admin: {
    me: 200,
    dashboard: 200,
    orders: 200,
    inventory: 200,
    grn: 200,
    stockTransfers: 200,
    users: 200,
    mobileStockists: 200,
    settlements: 200,
    cycleCounts: 200,
    reportsRevenue: 200,
    stockAdjustments: 200,
    trackingActive: 200,
  },
  provincial_stockist: {
    me: 200,
    dashboard: 200,
    orders: 200,
    inventory: 200,
    grn: 200,
    stockTransfers: 200,
    users: 200,
    mobileStockists: 200,
    settlements: 200,
    cycleCounts: 200,
    reportsRevenue: 200,
    stockAdjustments: 200,
    trackingActive: 200,
  },
  city_stockist: {
    me: 200,
    dashboard: 200,
    orders: 200,
    inventory: 200,
    grn: 200,
    stockTransfers: 200,
    users: 200,
    mobileStockists: 200,
    settlements: 200,
    cycleCounts: 200,
    reportsRevenue: 200,
    stockAdjustments: 200,
    trackingActive: 200,
  },
  staff: {
    me: 200,
    dashboard: 200,
    orders: 200,
    inventory: 200,
    grn: 200,
    stockTransfers: 200,
    users: 403,
    mobileStockists: 403,
    settlements: 403,
    cycleCounts: 200,
    reportsRevenue: 200,
    stockAdjustments: 200,
    trackingActive: 200,
  },
  mobile_stockist: {
    me: 200,
    dashboard: 403,
    orders: 200,
    inventory: 403,
    grn: 403,
    stockTransfers: 403,
    users: 403,
    mobileStockists: 403,
    settlements: 403,
    cycleCounts: 403,
    reportsRevenue: 403,
    stockAdjustments: 403,
    trackingActive: 200,
  },
};

function summarizePayload(json) {
  if (!json || typeof json !== 'object') {
    return { items: null };
  }

  const list = json.data?.items || json.data;
  if (Array.isArray(list)) {
    return { items: list.length };
  }

  if (json.pagination?.total !== undefined) {
    return { items: Number(json.pagination.total || 0) };
  }

  if (typeof json.total === 'number') {
    return { items: json.total };
  }

  return { items: null };
}

async function fetchJson(path, token) {
  const response = await fetch(`${baseURL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  return {
    status: response.status,
    json,
    summary: summarizePayload(json),
  };
}

async function loginAccount(account) {
  const response = await fetch(`${baseURL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });

  const json = await response.json();
  if (!response.ok || !json?.data?.access_token) {
    throw new Error(`Login failed for ${account.email}: ${json?.message || response.status}`);
  }

  return {
    token: json.data.access_token,
    user: json.data.user,
  };
}

async function runDataAudit() {
  const [rolePartnerRows] = await pool.execute(
    `SELECT u.email, r.slug AS role_slug, u.partner_id, p.business_name, p.stockist_level
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN partners p ON p.id = u.partner_id
     WHERE u.is_deleted = 0
       AND (
         (r.slug = 'provincial_stockist' AND (p.id IS NULL OR p.stockist_level <> 'provincial_stockist'))
         OR (r.slug = 'city_stockist' AND (p.id IS NULL OR p.stockist_level <> 'city_stockist'))
         OR (r.slug IN ('staff', 'mobile_stockist') AND (p.id IS NULL OR p.stockist_level NOT IN ('provincial_stockist', 'city_stockist')))
       )
     ORDER BY u.id`
  );

  const [mobileLinks] = await pool.execute(
    `SELECT u.email, u.partner_id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN mobile_stockists ms
       ON ms.is_deleted = 0
      AND (ms.user_id = u.id OR (ms.user_id IS NULL AND ms.email = u.email))
      AND ms.partner_id = u.partner_id
     WHERE u.is_deleted = 0
       AND r.slug = 'mobile_stockist'
       AND ms.id IS NULL
     ORDER BY u.id`
  );

  const [warehouseOwnership] = await pool.execute(
    `SELECT id, name, type, partner_id
     FROM warehouses
     WHERE is_deleted = 0
       AND type = 'manufacturer'
       AND partner_id IS NOT NULL
     ORDER BY id`
  );

  const [crossPartnerOrders] = await pool.execute(
    `SELECT o.id, o.order_number, o.partner_id AS order_partner_id, u.email, u.partner_id AS placed_by_partner_id
     FROM orders o
     JOIN users u ON u.id = o.placed_by
     WHERE o.is_deleted = 0
       AND COALESCE(o.partner_id, -1) <> COALESCE(u.partner_id, -1)
     ORDER BY o.id`
  );

  return {
    rolePartnerRows,
    mobileLinks,
    warehouseOwnership,
    crossPartnerOrders,
  };
}

async function main() {
  const results = [];
  const failures = [];

  for (const account of accounts) {
    const login = await loginAccount(account);
    const row = {
      role: account.role,
      email: account.email,
      partner_id: login.user.partner_id || null,
      endpoints: {},
    };

    for (const check of endpointChecks) {
      const response = await fetchJson(check.path, login.token);
      row.endpoints[check.key] = {
        status: response.status,
        items: response.summary.items,
        message: response.json?.message || null,
      };

      const expectedStatus = expectedStatuses[account.role][check.key];
      if (response.status !== expectedStatus) {
        failures.push({
          type: 'endpoint_status',
          role: account.role,
          endpoint: check.key,
          expectedStatus,
          actualStatus: response.status,
          message: response.json?.message || null,
        });
      }
    }

    results.push(row);
  }

  const audit = await runDataAudit();
  for (const [key, rows] of Object.entries(audit)) {
    for (const row of rows) {
      failures.push({ type: key, ...row });
    }
  }

  console.log(JSON.stringify({
    baseURL,
    summary: {
      accounts: results.length,
      failures: failures.length,
    },
    results,
    audit,
    failures,
  }, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    process.exit(process.exitCode || 0);
  });
