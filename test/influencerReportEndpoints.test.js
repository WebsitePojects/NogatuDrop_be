const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/db');
const reportsRouter = require('../src/routes/reports');
const { PERMISSIONS, hasPermission } = require('../src/rbac/permissions');
const { getInfluencerReport, exportInfluencerReport } = require('../src/controllers/reportController');

function routeHandlers(path) {
  const layer = reportsRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
  assert.ok(layer, `GET ${path} is not routed`);
  return layer.route.stack.map((s) => s.handle);
}

// Runs the first handler on the route (the authorization guard) and reports what it did.
function runGuard(path, user) {
  const [guard] = routeHandlers(path);
  return new Promise((resolve) => guard({ user }, {}, (err) => resolve(err || null)));
}

const INFLUENCER_PATHS = ['/influencers', '/influencers/export'];

test('influencer report and export reject every non-super_admin role', async () => {
  for (const path of INFLUENCER_PATHS) {
    for (const role_slug of ['city_stockist', 'provincial_stockist', 'staff', 'mobile_stockist', 'admin', 'unknown_role', undefined]) {
      const err = await runGuard(path, { id: 1, role_slug, partner_id: 5 });
      assert.equal(err && err.statusCode, 403, `${path} must reject ${role_slug}`);
    }
  }
});

test('influencer report and export allow super_admin and reject anonymous callers', async () => {
  for (const path of INFLUENCER_PATHS) {
    assert.equal(await runGuard(path, { id: 1, role_slug: 'super_admin', partner_id: null }), null);
    const anonymous = await runGuard(path, undefined);
    assert.equal(anonymous && anonymous.statusCode, 401);
  }
});

test('the guard is not the REPORTS_VIEW permission that stockists hold', () => {
  // If this ever flips, the permission alone would be enough to leak company revenue.
  assert.equal(hasPermission('city_stockist', PERMISSIONS.REPORTS_VIEW), true);
  assert.equal(hasPermission('staff', PERMISSIONS.REPORTS_VIEW), true);
  assert.equal(routeHandlers('/influencers').length, 2);
  assert.equal(routeHandlers('/influencers/export').length, 2);
});

function mockRes() {
  return {
    headers: {}, body: undefined,
    set(arg) { Object.assign(this.headers, arg); return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
  };
}

async function callController(handler, query, execute) {
  const original = pool.execute;
  pool.execute = execute || (async () => { throw new Error('database must not be reached'); });
  try {
    const res = mockRes();
    const err = await new Promise((resolve) => {
      // asyncHandler calls next only on failure, so also settle once the handler has responded.
      const poll = setInterval(() => { if (res.body !== undefined) { clearInterval(poll); resolve(null); } }, 5);
      handler({ query, user: { role_slug: 'super_admin' } }, res, (failure) => { clearInterval(poll); resolve(failure); });
    });
    return { res, err };
  } finally {
    pool.execute = original;
  }
}

const dbWith = (groups, rows) => async (sql) => [/GROUP BY/.test(sql) ? groups : rows];

test('export fails closed on an unknown format before touching the database', async () => {
  for (const format of ['xlsx', 'json', '', ['csv', 'csv']]) {
    const { err } = await callController(exportInfluencerReport, { month: '2026-09', format });
    assert.equal(err && err.statusCode, 400, `format ${JSON.stringify(format)}`);
  }
});

test('report and export reject a bad month or slug at the boundary', async () => {
  for (const handler of [getInfluencerReport, exportInfluencerReport]) {
    assert.equal((await callController(handler, { month: '2026-13' })).err.statusCode, 400);
    assert.equal((await callController(handler, { month: '2026-09', slug: 'Bad Slug!' })).err.statusCode, 400);
    assert.equal((await callController(handler, { month: '2026-09', slug: ['a', 'b'] })).err.statusCode, 400);
  }
});

test('export sends BOM CSV with an attachment filename built from validated slug and month', async () => {
  const rows = [{
    order_number: 'PUB-1', created_at: '2026-09-02 10:00:00', influencer_slug: 'kawoodee', payment_provider: 'GCASH',
    fulfillment_center: 'CALOOCAN', customer_location: 'Blk 1, Lot 2', total_amount: '750.00',
    status: 'delivered', payment_status: 'paid',
  }];
  const groups = [{ provider_label: 'GCASH', center_label: 'CALOOCAN', counted_orders: '1', excluded_orders: '0', gross: '750.00' }];
  const { res, err } = await callController(exportInfluencerReport, { month: '2026-09', slug: 'KAWOODEE', format: 'CSV' }, dbWith(groups, rows));
  assert.equal(err, null);
  assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
  assert.equal(res.headers['Content-Disposition'], 'attachment; filename="influencer-kawoodee-2026-09.csv"');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.charCodeAt(0), 0xFEFF);
  assert.match(res.body, /PUB-1,2026-09-02 10:00:00,kawoodee,GCASH,CALOOCAN,"Blk 1, Lot 2",750\.00,delivered,paid\r\n$/);
});

test('export without a slug is named "all"; the JSON report returns the documented keys', async () => {
  const exported = await callController(exportInfluencerReport, { month: '2026-09' }, dbWith([], []));
  assert.equal(exported.res.headers['Content-Disposition'], 'attachment; filename="influencer-all-2026-09.csv"');

  const json = await callController(getInfluencerReport, { month: '2026-09' }, dbWith([], []));
  assert.equal(json.res.body.success, true);
  assert.deepEqual(Object.keys(json.res.body.data.summary).sort(), ['by_center', 'by_provider', 'excluded_order_count', 'gross_sales', 'order_count']);
  assert.deepEqual(json.res.body.data.rows, []);
});

test('export refuses a truncated dataset instead of silently dropping orders', async () => {
  // 20001 attributed orders reported by the grouped query, none returned as rows.
  const groups = [{ provider_label: 'GCASH', center_label: 'CALOOCAN', counted_orders: '20001', excluded_orders: '0', gross: '1.00' }];
  const { err } = await callController(exportInfluencerReport, { month: '2026-09' }, dbWith(groups, []));
  assert.equal(err && err.statusCode, 400);
});
