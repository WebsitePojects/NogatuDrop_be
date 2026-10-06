// Real-database double-fire proof for the three address-bearing create endpoints (warehouse, Stockist,
// Mobile Stockist): two identical submits, one after the other and at the same time, make exactly one
// record; the loser gets a clean 409, never a 500 and never a second record. Also proves the parts are
// stored and the old text column is rewritten from them.
// Run: NCDMS_DB_TESTS=1 node --env-file=.env.dev --test --test-force-exit test/addressRecords.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs the local database)' };

// Alicia, Quezon City, NCR (PSGC).
const BARANGAY = '137404001';
const ADDRESS = { address_line: 'QA 12 Rizal St.', barangay_code: BARANGAY, postal_code: '1100' };
const EXPECTED_TEXT = 'QA 12 Rizal St., Alicia, Quezon City, NCR, 1100';

let pool;
let controllers;
let superAdmin;
let parentPartnerId;
const stamp = Date.now().toString(36);
const created = { warehouses: [], partners: [], mobiles: [] };

/** Runs an asyncHandler-wrapped controller and returns { status, body } or { status, error }. */
function invoke(handler, body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ user: superAdmin, body, query: {}, params: {}, headers: {} }, res, (error) => {
      resolve({ status: error.statusCode || 500, error });
    });
  });
}

const statuses = (results) => results.map((r) => r.status).sort();

test.before(async () => {
  if (!enabled) return;
  process.env.REDIS_ENABLED = 'false';
  pool = require('../src/config/db');
  controllers = {
    warehouse: require('../src/controllers/warehouseController'),
    partner: require('../src/controllers/partnerController'),
    mobile: require('../src/controllers/mobileStockistController'),
  };
  const [[admin]] = await pool.execute(
    `SELECT u.id, r.slug AS role_slug, u.partner_id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active' LIMIT 1`
  );
  superAdmin = admin;
  const [[parent]] = await pool.execute(
    "SELECT id FROM partners WHERE stockist_level = 'provincial_stockist' AND is_deleted = 0 AND status = 'active' LIMIT 1"
  );
  parentPartnerId = parent.id;
});

test.after(async () => {
  if (!enabled) return;
  for (const id of created.warehouses) {
    await pool.execute('UPDATE warehouses SET is_deleted = 1, is_active = 0 WHERE id = ?', [id]);
  }
  for (const id of created.mobiles) {
    await pool.execute("UPDATE mobile_stockists SET is_deleted = 1, status = 'inactive' WHERE id = ?", [id]);
  }
  for (const id of created.partners) {
    await pool.execute("UPDATE partners SET is_deleted = 1, status = 'inactive' WHERE id = ?", [id]);
  }
  await pool.execute("UPDATE users SET is_deleted = 1, status = 'inactive' WHERE email LIKE ?", [`qa.addr.${stamp}.%`]);
  await pool.end();
});

test('warehouse create: two sequential identical submits make one warehouse', opts, async () => {
  const body = { name: `QA Addr WH seq ${stamp}`, manager_name: 'QA', ...ADDRESS, lat: 14.65, lng: 121.05 };
  const first = await invoke(controllers.warehouse.createWarehouse, body);
  const second = await invoke(controllers.warehouse.createWarehouse, body);
  created.warehouses.push(...[first.body?.data?.id].filter(Boolean));
  assert.deepEqual(statuses([first, second]), [201, 409]);
  const [rows] = await pool.execute('SELECT * FROM warehouses WHERE name = ? AND is_deleted = 0', [body.name]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].location, EXPECTED_TEXT);
  assert.equal(rows[0].barangay_code, BARANGAY);
  assert.equal(rows[0].address_line, ADDRESS.address_line);
  assert.equal(rows[0].postal_code, '1100');
});

test('warehouse create: two concurrent identical submits make one warehouse', opts, async () => {
  const body = { name: `QA Addr WH par ${stamp}`, manager_name: 'QA', ...ADDRESS };
  const results = await Promise.all([
    invoke(controllers.warehouse.createWarehouse, body),
    invoke(controllers.warehouse.createWarehouse, body),
  ]);
  created.warehouses.push(...results.map((r) => r.body?.data?.id).filter(Boolean));
  assert.deepEqual(statuses(results), [201, 409]);
  const [[{ total }]] = await pool.execute('SELECT COUNT(*) AS total FROM warehouses WHERE name = ? AND is_deleted = 0', [body.name]);
  assert.equal(Number(total), 1);
});

test('warehouse create refuses an unknown barangay and writes nothing', opts, async () => {
  const body = { name: `QA Addr WH bad ${stamp}`, manager_name: 'QA', ...ADDRESS, barangay_code: '999999999' };
  const result = await invoke(controllers.warehouse.createWarehouse, body);
  assert.equal(result.status, 400);
  const [[{ total }]] = await pool.execute('SELECT COUNT(*) AS total FROM warehouses WHERE name = ?', [body.name]);
  assert.equal(Number(total), 0);
});

test('Stockist create: sequential and concurrent identical submits make one Stockist', opts, async () => {
  const make = (label) => ({
    business_name: `QA Addr Stockist ${label} ${stamp}`,
    email: `qa.addr.${stamp}.${label}@example.test`,
    phone: '09170000000',
    stockist_level: 'city_stockist',
    parent_partner_id: parentPartnerId,
    admin_password: 'QAlocal2026!',
    ...ADDRESS,
  });
  const record = (results) => created.partners.push(...results.map((r) => r.body?.data?.partner_id).filter(Boolean));

  const seq = make('seq');
  const sequential = [await invoke(controllers.partner.createPartner, seq), await invoke(controllers.partner.createPartner, seq)];
  record(sequential);
  assert.deepEqual(statuses(sequential), [201, 409]);

  const par = make('par');
  const concurrent = await Promise.all([
    invoke(controllers.partner.createPartner, par),
    invoke(controllers.partner.createPartner, par),
  ]);
  record(concurrent);
  assert.deepEqual(statuses(concurrent), [201, 409]);

  const [rows] = await pool.execute('SELECT * FROM partners WHERE email IN (?, ?)', [seq.email, par.email]);
  assert.equal(rows.length, 2, 'one Stockist per email');
  for (const row of rows) {
    assert.equal(row.address, EXPECTED_TEXT);
    assert.equal(row.region, 'NCR');
    assert.equal(row.barangay_code, BARANGAY);
  }
});

test('Mobile Stockist create: sequential and concurrent identical submits make one account', opts, async () => {
  const make = (label) => ({
    name: `QA Addr Mobile ${label} ${stamp}`,
    email: `qa.addr.${stamp}.m${label}@example.test`,
    password: 'QAlocal2026!',
    parent_partner_id: parentPartnerId,
    lat: 14.66,
    lng: 121.05,
    ...ADDRESS,
  });
  const record = (results) => created.mobiles.push(...results.map((r) => r.body?.data?.id).filter(Boolean));

  const seq = make('seq');
  const sequential = [await invoke(controllers.mobile.createMobileStockist, seq), await invoke(controllers.mobile.createMobileStockist, seq)];
  record(sequential);
  assert.deepEqual(statuses(sequential), [201, 409]);

  const par = make('par');
  const concurrent = await Promise.all([
    invoke(controllers.mobile.createMobileStockist, par),
    invoke(controllers.mobile.createMobileStockist, par),
  ]);
  record(concurrent);
  assert.equal(concurrent.filter((r) => r.status === 500).length, 0, 'the loser must be a 409, not a 500');
  assert.deepEqual(statuses(concurrent), [201, 409]);

  const [rows] = await pool.execute('SELECT * FROM mobile_stockists WHERE email IN (?, ?)', [seq.email, par.email]);
  assert.equal(rows.length, 2, 'one account per email');
  for (const row of rows) {
    assert.equal(row.address, EXPECTED_TEXT);
    assert.equal(row.region, 'NCR');
    assert.equal(row.barangay_code, BARANGAY);
    assert.equal(Number(row.lat), 14.66);
  }
});
