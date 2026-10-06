const test = require('node:test');
const assert = require('node:assert/strict');

const pool = require('../src/config/db');
const cache = require('../src/services/cacheService');

// The KPI view counts every active partner, fulfillment centers included; the Super Admin card
// must count Stockists only.
test('Super Admin "Active Stockists" counts provincial and city Stockists, never centers', async (t) => {
  const calls = [];
  t.mock.method(cache, 'getOrSet', async (_key, _ttl, load) => load());
  t.mock.method(pool, 'execute', async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('vw_dashboard_kpis')) return [[{ total_revenue: '0', inventory_value: '0', pending_orders: 0, active_stockists: 5 }]];
    return [[{ active_stockists: 3 }]];
  });
  const { getKPIs } = require('../src/controllers/dashboardController');
  const body = await new Promise((resolve, reject) => {
    getKPIs({ user: { role_slug: 'super_admin', partner_id: null } }, { json: resolve }, reject);
  });
  assert.equal(body.data.active_stockists, 3);
  const stockistQuery = calls.find((c) => c.sql.includes('FROM partners'));
  assert.deepEqual(stockistQuery.params, ['provincial_stockist', 'city_stockist']);
});
