// Real-database, real-HTTP proof for the 2026-11-10 meeting changes (store checkout):
//  - the shipping fee is the server's own weight-and-zone quote, saved on the order with the delivery dates;
//  - at most 10 items per order;
//  - the same order sent twice (one after the other, and at the same time) creates one order;
//  - a buyer inside a Stockist's territory is served by that Stockist only ("hands off" for the centers) and
//    pays the Stockist's own account;
//  - Super Admin's shipping settings save: the same save twice (and at once) leaves one identical state.
// The app runs in this process on a random port. Every row the test adds is removed and stock restored.
// Run on a LOCAL copy only (scripts/addShippingRates.js --apply first):
//   NCDMS_DB_TESTS=1 node --env-file=<env of a local copy> --test --test-force-exit test/shippingCheckout.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs a local database copy)' };

let pool;
let server;
let baseUrl;
let adminToken;
const created = { orderIds: [], warehouseIds: [], inventoryIds: [], bankIds: [], territoryIds: [], partnerIds: [], userIds: [] };
let inventorySnapshot = [];

const ORDER_CHILD_TABLES = ['order_notification_outbox', 'order_items', 'public_order_idempotency', 'order_attribution',
  'order_payment_proofs', 'order_fee_adjustments', 'payments', 'delivery_tracking', 'delivery_tokens', 'settlements'];

async function api(method, path, { body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const barangayIn = async (where, params = []) => (await pool.execute(
  `SELECT b.code FROM ph_barangays b JOIN ph_cities_municipalities c ON c.code = b.city_code
   LEFT JOIN ph_provinces p ON p.code = c.province_code WHERE ${where} ORDER BY b.code LIMIT 1`, params
))[0][0].code;

function buyer(barangayCode, items, extra = {}) {
  return {
    customer_first_name: 'Sim', customer_last_name: 'Buyer', customer_address_line: '1 Test Street',
    customer_barangay_code: barangayCode, customer_phone: '09171234567', customer_email: 'sim.buyer@sim.invalid',
    payment_method: 'bank_transfer', items, ...extra,
  };
}
const placeOrder = (body, key = crypto.randomUUID()) => api('POST', '/orders/public', { body, headers: { 'Idempotency-Key': key } });
const orderCount = async () => Number((await pool.execute('SELECT COUNT(*) n FROM orders'))[0][0].n);
const remember = (res) => { if (res.status === 201) created.orderIds.push(res.body.data.order_number); return res; };

test.before(async () => {
  if (!enabled) return;
  process.env.REDIS_ENABLED = 'false';
  process.env.RATE_LIMIT_ENABLED = 'false';
  pool = require('../src/config/db');
  const env = require('../src/config/env');
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const [[admin]] = await pool.execute(
    `SELECT u.id, u.email, u.partner_id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active' LIMIT 1`
  );
  adminToken = require('jsonwebtoken').sign(
    { id: admin.id, role_slug: 'super_admin', partner_id: admin.partner_id, email: admin.email }, env.JWT_SECRET, { expiresIn: '10m' }
  );
  [inventorySnapshot] = await pool.execute('SELECT id, current_stock, reserved_stock FROM inventories');
});

test.after(async () => {
  if (!enabled) return;
  if (created.orderIds.length) {
    const [rows] = await pool.query('SELECT id FROM orders WHERE order_number IN (?)', [created.orderIds]);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      for (const table of ORDER_CHILD_TABLES) await pool.query(`DELETE FROM ${table} WHERE order_id IN (?)`, [ids]);
      await pool.query("DELETE FROM stock_movements WHERE reference_type = 'order' AND reference_id IN (?)", [ids]);
      await pool.query('DELETE FROM orders WHERE id IN (?)', [ids]);
    }
  }
  for (const row of inventorySnapshot) {
    await pool.execute('UPDATE inventories SET reserved_stock = ?, current_stock = ? WHERE id = ?', [row.reserved_stock, row.current_stock, row.id]);
  }
  if (created.inventoryIds.length) await pool.query('DELETE FROM inventories WHERE id IN (?)', [created.inventoryIds]);
  if (created.userIds.length) {
    await pool.query('DELETE FROM notifications WHERE user_id IN (?)', [created.userIds]);
    await pool.query('DELETE FROM users WHERE id IN (?)', [created.userIds]);
  }
  if (created.bankIds.length) await pool.query('DELETE FROM bank_accounts WHERE id IN (?)', [created.bankIds]);
  if (created.warehouseIds.length) await pool.query('DELETE FROM warehouses WHERE id IN (?)', [created.warehouseIds]);
  if (created.territoryIds.length) await pool.query('DELETE FROM stockist_territories WHERE id IN (?)', [created.territoryIds]);
  if (created.partnerIds.length) {
    await pool.query('DELETE FROM stockist_territories WHERE partner_id IN (?)', [created.partnerIds]);
    await pool.query("UPDATE users SET is_deleted = 1, status = 'inactive' WHERE partner_id IN (?)", [created.partnerIds]);
    await pool.query("UPDATE partners SET is_deleted = 1, status = 'inactive' WHERE id IN (?)", [created.partnerIds]);
  }
  server?.close();
  await pool.end();
});

test('quote: the brief example (5 Berry NAD+, 2 Max Fuel, 3 Coffee Mix to Luzon) is 3.143 kg and PHP 335', opts, async () => {
  const batangas = await barangayIn("p.name = 'Batangas'");
  const res = await api('POST', '/shipping/quote', {
    body: { barangay_code: batangas, items: [{ product_id: 16, quantity: 5 }, { product_id: 6, quantity: 2 }, { product_id: 5, quantity: 3 }] },
  });
  assert.equal(res.status, 200, res.body.message);
  assert.equal(res.body.data.weight_grams, 3143);
  assert.equal(res.body.data.fee, 335);
  assert.equal(res.body.data.zone_code, 'LUZON');
});

test('order: the saved fee is the server quote (a client fee is ignored), with zone, weight and delivery dates', opts, async () => {
  const ncr = await barangayIn("c.region_code = '130000000'");
  const items = [{ product_id: 2, quantity: 2 }];
  const quote = (await api('POST', '/shipping/quote', { body: { barangay_code: ncr, items } })).body.data;
  const res = remember(await placeOrder(buyer(ncr, items, { shipping_fee: 1, total_amount: 1 })));
  assert.equal(res.status, 201, res.body.message);
  assert.deepEqual(res.body.data.delivery_estimate, {
    zone_name: quote.zone_name, area_name: quote.area_name, eta_from: quote.eta_from, eta_to: quote.eta_to, if_paid_today: true,
  });
  const [[row]] = await pool.execute(
    `SELECT shipping_fee, shipping_zone, shipping_weight_grams, delivery_eta_from, delivery_eta_to, total_amount, merchandise_subtotal
     FROM orders WHERE order_number = ?`, [res.body.data.order_number]
  );
  assert.equal(Number(row.shipping_fee), 185, 'the proposal NCR rate');
  assert.equal(row.shipping_zone, 'NCR');
  assert.equal(row.shipping_weight_grams, 954);
  assert.equal(row.delivery_eta_from, quote.eta_from);
  assert.equal(row.delivery_eta_to, quote.eta_to);
  assert.equal(Number(row.total_amount), Number(row.merchandise_subtotal) + 185);

  const tracking = await api('GET', `/tracking/public/${res.body.data.order_number}`);
  assert.deepEqual(tracking.body.data.delivery_estimate, { from: quote.eta_from, to: quote.eta_to, if_paid_today: true });
});

test('order: 11 items in total are refused and nothing is saved', opts, async () => {
  const ncr = await barangayIn("c.region_code = '130000000'");
  const before = await orderCount();
  const res = await placeOrder(buyer(ncr, [{ product_id: 2, quantity: 6 }, { product_id: 3, quantity: 5 }]));
  assert.equal(res.status, 400);
  assert.match(res.body.message, /at most 10 items in total \(this one has 11\)/);
  assert.equal(await orderCount(), before);
});

test('order: the same order sent twice in a row and twice at once makes one order each time', opts, async () => {
  const ncr = await barangayIn("c.region_code = '130000000'");
  const body = buyer(ncr, [{ product_id: 3, quantity: 1 }]);
  const before = await orderCount();

  const key = crypto.randomUUID();
  const first = remember(await placeOrder(body, key));
  const second = await placeOrder(body, key);
  assert.equal(first.status, 201, first.body.message);
  assert.equal(second.status, 201);
  assert.equal(second.body.data.order_number, first.body.data.order_number, 'the retry replays the first order');
  assert.equal(await orderCount(), before + 1);

  const concurrentKey = crypto.randomUUID();
  const both = await Promise.all([placeOrder(body, concurrentKey), placeOrder(body, concurrentKey)]);
  both.forEach(remember);
  const placed = both.filter((r) => r.status === 201).map((r) => r.body.data.order_number);
  assert.ok(placed.length >= 1, both.map((r) => r.body.message).join(' | '));
  assert.equal(new Set(placed).size, 1, 'both answers name the same order');
  assert.ok(both.every((r) => [201, 409].includes(r.status)), both.map((r) => r.status).join(','));
  assert.equal(await orderCount(), before + 2);
});

test('territory: centers stay out; a Stockist with no warehouse refuses, then with stock it ships and is paid itself', opts, async () => {
  const [[stockist]] = await pool.execute(
    `SELECT p.id, t.area_code FROM partners p JOIN stockist_territories t ON t.partner_id = p.id AND t.area_type = 'province'
     WHERE p.status = 'active' AND p.is_deleted = 0
       AND NOT EXISTS (SELECT 1 FROM warehouses w WHERE w.partner_id = p.id AND w.is_deleted = 0 AND w.is_active = 1)
     LIMIT 1`
  );
  assert.ok(stockist, 'the local copy needs a territory Stockist without a warehouse (PS-Davao Del Norte on the Nov 5 copy)');
  const barangay = await barangayIn('c.province_code = ?', [stockist.area_code]);
  const items = [{ product_id: 16, quantity: 1 }];
  const before = await orderCount();

  const refused = await placeOrder(buyer(barangay, items));
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /Stockist serving your area is not taking store orders yet/);
  assert.equal(await orderCount(), before, 'no center took it');

  const [wh] = await pool.execute(
    "INSERT INTO warehouses (name, partner_id, type, location, manager_name, is_active) VALUES ('SIM Stockist Warehouse', ?, 'region', 'Sim', 'Sim', 1)", [stockist.id]
  );
  created.warehouseIds.push(wh.insertId);
  const [inv] = await pool.execute(
    "INSERT INTO inventories (product_id, warehouse_id, partner_id, current_stock, reserved_stock, expiry_date) VALUES (16, ?, ?, 5, 0, '2027-12-31')",
    [wh.insertId, stockist.id]
  );
  created.inventoryIds.push(inv.insertId);
  const [bank] = await pool.execute(
    "INSERT INTO bank_accounts (warehouse_id, bank_name, account_name, account_number, is_active) VALUES (?, 'GCASH', 'SIM STOCKIST', '09990000000', 1)",
    [wh.insertId]
  );
  created.bankIds.push(bank.insertId);

  const shipped = remember(await placeOrder(buyer(barangay, items, { payment_provider: 'GCASH' })));
  assert.equal(shipped.status, 201, shipped.body.message);
  const [[row]] = await pool.execute(
    'SELECT partner_id, source_warehouse_id, payment_account_id FROM orders WHERE order_number = ?', [shipped.body.data.order_number]
  );
  assert.equal(Number(row.partner_id), Number(stockist.id));
  assert.equal(Number(row.source_warehouse_id), wh.insertId);
  assert.equal(Number(row.payment_account_id), bank.insertId, "the buyer pays the Stockist's own GCash");

  const short = await placeOrder(buyer(barangay, [{ product_id: 16, quantity: 5 }]));
  assert.equal(short.status, 409, 'only 4 left at the Stockist; a center does not step in');
  assert.match(short.body.message, /does not have enough Berry NAD\+/);
  const shortQuote = await api('POST', '/shipping/quote', { body: { barangay_code: barangay, items: [{ product_id: 16, quantity: 5 }] } });
  assert.equal(shortQuote.status, 409, 'checkout shows the shortage before the buyer fills the form');

  // Shipped from the Stockist's own province: its neighbour pays the local rate, not NCR -> Mindanao (265).
  const [[fee]] = await pool.execute('SELECT shipping_fee, shipping_zone FROM orders WHERE order_number = ?', [shipped.body.data.order_number]);
  assert.equal(fee.shipping_zone, 'NCR', 'local tier');
  assert.equal(Number(fee.shipping_fee), 185);
  const quote = await api('POST', '/shipping/quote', { body: { barangay_code: barangay, items } });
  assert.equal(quote.body.data.fee, 185, 'the checkout preview quotes the same as the order');
  const fromHubs = await api('POST', '/shipping/quote', { body: { barangay_code: barangay, items, centers_only: true } });
  assert.equal(fromHubs.body.data.fee, 265, 'the same parcel from Caloocan/Tycoon is the Mindanao rate');

  // The buyer paid the Stockist's GCash, so the Stockist verifies; a Nogatu-paid order is not its to confirm.
  const env = require('../src/config/env');
  const [stockistUser] = await pool.execute(
    `INSERT INTO users (name, email, password, role_id, partner_id, status)
     SELECT 'SIM Davao login', ?, 'x', id, ?, 'active' FROM roles WHERE slug = 'provincial_stockist'`,
    [`sim.davao.${Date.now()}@sim.invalid`, stockist.id]
  );
  created.userIds.push(stockistUser.insertId);
  const stockistToken = require('jsonwebtoken').sign(
    { id: stockistUser.insertId, role_slug: 'provincial_stockist', partner_id: stockist.id }, env.JWT_SECRET, { expiresIn: '10m' }
  );
  await pool.execute(
    `UPDATE orders SET status = 'approved', payment_proof_url = 'https://example.test/r.png', payment_proof_uploaded_at = NOW(),
            payment_covered_total = total_amount, delivery_eta_from = '2026-01-01', delivery_eta_to = '2026-01-02'
     WHERE order_number = ?`,
    [shipped.body.data.order_number]
  );
  const [[own]] = await pool.execute('SELECT id, delivery_eta_min_days, delivery_eta_max_days FROM orders WHERE order_number = ?', [shipped.body.data.order_number]);
  const detail = await api('GET', `/orders/${own.id}`, { headers: { Authorization: `Bearer ${stockistToken}` } });
  assert.equal(detail.body.data.can_verify_payment, true);
  assert.equal(detail.body.data.payment_received_by_stockist, true);
  const verifyOnce = () => api('PATCH', `/orders/${own.id}/verify-payment`, { headers: { Authorization: `Bearer ${stockistToken}` } });
  const [v1, v2] = await Promise.all([verifyOnce(), verifyOnce()]);
  assert.deepEqual([v1.status, v2.status], [200, 200], `${v1.body.message} | ${v2.body.message}`);
  assert.equal([v1, v2].filter((r) => r.body.data?.already_paid).length, 1, 'two presses, one verification');
  const [[paid]] = await pool.execute('SELECT payment_status, delivery_eta_from, delivery_eta_to FROM orders WHERE id = ?', [own.id]);
  const { deliveryWindow } = require('../src/services/shippingService');
  const expected = deliveryWindow(own.delivery_eta_min_days, own.delivery_eta_max_days);
  assert.equal(paid.payment_status, 'paid');
  assert.deepEqual([paid.delivery_eta_from, paid.delivery_eta_to], [expected.eta_from, expected.eta_to], 'dates counted again from payment');

  const [[nogatuPaid]] = await pool.query('SELECT id FROM orders WHERE order_number = ?', [created.orderIds[0]]);
  await pool.execute("UPDATE orders SET partner_id = ?, status = 'approved', payment_proof_url = 'https://example.test/n.png' WHERE id = ?", [stockist.id, nogatuPaid.id]);
  const refusedVerify = await api('PATCH', `/orders/${nogatuPaid.id}/verify-payment`, { headers: { Authorization: `Bearer ${stockistToken}` } });
  assert.equal(refusedVerify.status, 403, 'money paid to Nogatu is verified by Super Admin');
});

test('settings: the same save twice in a row and twice at once leaves one identical state', opts, async () => {
  const auth = { Authorization: `Bearer ${adminToken}` };
  const current = (await api('GET', '/shipping/settings', { headers: auth })).body.data;
  const ncr = current.zones.find((z) => z.code === 'NCR');
  const romblon = current.provinces.find((p) => p.name === 'Romblon');
  const glow = current.products.find((p) => p.sku === 'NOG-110');
  const save = (fee) => api('PUT', '/shipping/settings', {
    headers: auth,
    body: {
      zones: [{ code: 'NCR', eta_min_days: ncr.eta_min_days, eta_max_days: ncr.eta_max_days,
        rates: ncr.rates.map((r, i) => ({ ...r, fee: i === 0 ? fee : r.fee })) }],
      provinces: [{ code: romblon.code, zone_code: romblon.zone_code }],
      products: [{ id: glow.id, weight_grams: glow.weight_grams }],
    },
  });
  const rateRows = async () => (await pool.execute("SELECT max_weight_grams, fee FROM shipping_rates WHERE zone_code = 'NCR' ORDER BY max_weight_grams"))[0];

  try {
    assert.equal((await save(199)).status, 200);
    const once = await rateRows();
    assert.equal((await save(199)).status, 200);
    assert.deepEqual(await rateRows(), once);
    const both = await Promise.all([save(205), save(205)]);
    assert.deepEqual(both.map((r) => r.status), [200, 200]);
    const after = await rateRows();
    assert.equal(after.length, ncr.rates.length, 'no duplicated bracket');
    assert.equal(Number(after[0].fee), 205);

    const bad = await api('PUT', '/shipping/settings', { headers: auth, body: { provinces: [{ code: romblon.code, zone_code: 'MARS' }] } });
    assert.equal(bad.status, 400, 'an unknown zone is refused');
    const noAuth = await api('PUT', '/shipping/settings', { body: {} });
    assert.equal(noAuth.status, 401);
  } finally {
    await save(ncr.rates[0].fee);
  }
});

test('Stockist create: password required and checked, never echoed, works at login; home province assigned; a deleted holder releases it, a live one keeps it', opts, async () => {
  const auth = { Authorization: `Bearer ${adminToken}` };
  const stamp = Date.now();
  const [[province]] = await pool.execute(
    `SELECT pr.code, pr.name, MIN(b.code) AS barangay FROM ph_provinces pr
     JOIN ph_cities_municipalities c ON c.province_code = pr.code JOIN ph_barangays b ON b.city_code = c.code
     WHERE NOT EXISTS (SELECT 1 FROM stockist_territories t WHERE t.area_type = 'province' AND t.area_code = pr.code)
     GROUP BY pr.code, pr.name ORDER BY pr.name LIMIT 1`
  );
  const create = (tag, password) => api('POST', '/partners', {
    headers: auth,
    body: { business_name: `SIM PS ${tag} ${stamp}`, email: `sim.ps.${tag}.${stamp}@sim.invalid`, stockist_level: 'provincial_stockist',
      admin_password: password, address_line: '1 Sim Street', barangay_code: province.barangay },
  });

  const weak = await create('weak', 'abcd1234');
  assert.equal(weak.status, 400);
  assert.match(JSON.stringify(weak.body), /symbol/);
  const none = await create('none', undefined);
  assert.equal(none.status, 400, 'a Stockist login needs a password typed by Super Admin');

  const first = await create('a', 'Strong#Pass1');
  assert.equal(first.status, 201, first.body.message);
  created.partnerIds.push(first.body.data.partner_id);
  assert.deepEqual(first.body.data.territory, { assigned: true, area_name: province.name, held_by: null });
  assert.match(first.body.message, new RegExp(`Store orders from ${province.name} now go to this Stockist`));
  assert.equal(JSON.stringify(first.body).includes('Strong#Pass1'), false, 'the password never comes back');
  const login = await api('POST', '/auth/login', { body: { email: `sim.ps.a.${stamp}@sim.invalid`, password: 'Strong#Pass1' } });
  assert.equal(login.status, 200, 'the new Stockist signs in with the password Super Admin typed');

  const second = await create('b', 'Strong#Pass2');
  created.partnerIds.push(second.body.data.partner_id);
  assert.equal(second.body.data.territory.assigned, false, 'a live holder keeps its province');
  assert.match(second.body.data.territory.held_by, /SIM PS a/);

  await pool.execute('UPDATE partners SET is_deleted = 1 WHERE id = ?', [first.body.data.partner_id]);
  const third = await create('c', 'Strong#Pass3');
  created.partnerIds.push(third.body.data.partner_id);
  assert.equal(third.body.data.territory.assigned, true, 'a deleted holder no longer locks the province');
  const [rows] = await pool.execute("SELECT partner_id FROM stockist_territories WHERE area_type = 'province' AND area_code = ?", [province.code]);
  assert.deepEqual(rows.map((r) => Number(r.partner_id)), [third.body.data.partner_id]);
});

test('member price: only a nogatualliance.com sign-in gives the discount; a typed username gets nothing', opts, async () => {
  const http = require('node:http');
  const env = require('../src/config/env');
  const MEMBERS = { juan01: { password: 'Right#Pass1', uid: '777', status: 'active' }, gone02: { password: 'Gone#Pass1', uid: '778', status: 'suspended' } };
  const seenKeys = [];
  const mlm = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seenKeys.push(req.headers['x-api-key']);
      const { username, password } = JSON.parse(raw || '{}');
      const member = MEMBERS[username];
      res.setHeader('Content-Type', 'application/json');
      if (req.url !== '/api/external/member/verify' || req.headers['x-api-key'] !== 'sim-bridge-key') { res.statusCode = 403; res.end('{}'); return; }
      if (!member || member.password !== password) { res.statusCode = 401; res.end('{"error":"invalid"}'); return; }
      res.end(JSON.stringify({ data: { verified: true, uid: member.uid, username, account_status: member.status } }));
    });
  });
  await new Promise((resolve) => mlm.listen(0, '127.0.0.1', resolve));
  const saved = { url: env.MLM_API_URL, key: env.MLM_API_KEY };
  try {
    assert.equal((await api('GET', '/members/discount')).body.data.enabled, Boolean(saved.url && saved.key));
    env.MLM_API_URL = `http://127.0.0.1:${mlm.address().port}`;
    env.MLM_API_KEY = 'sim-bridge-key';
    assert.equal((await api('GET', '/members/discount')).body.data.enabled, true);

    const wrong = await api('POST', '/members/verify', { body: { username: 'juan01', password: 'nope' } });
    assert.equal(wrong.status, 401);
    const suspended = await api('POST', '/members/verify', { body: { username: 'gone02', password: 'Gone#Pass1' } });
    assert.equal(suspended.status, 401, 'an inactive member gets the same answer as a wrong password');
    assert.equal(suspended.body.message, wrong.body.message);
    const ok = await api('POST', '/members/verify', { body: { username: 'juan01', password: 'Right#Pass1' } });
    assert.equal(ok.status, 200, ok.body.message);
    assert.equal(JSON.stringify(ok.body).includes('Right#Pass1'), false, 'the password never comes back');
    assert.ok(seenKeys.every((k) => k === 'sim-bridge-key'));

    const ncr = await barangayIn("c.region_code = '130000000'");
    const items = [{ product_id: 3, quantity: 2 }];
    const typedUsername = await placeOrder(buyer(ncr, items, { member_username: 'juan01' }));
    assert.equal(typedUsername.status, 400, 'a bare username is refused, not priced');
    const forged = await placeOrder(buyer(ncr, items, { member_pass: `${ok.body.data.member_pass}x` }));
    assert.equal(forged.status, 400);
    assert.match(forged.body.message, /member sign-in has expired/);

    const member = remember(await placeOrder(buyer(ncr, items, { member_pass: ok.body.data.member_pass })));
    assert.equal(member.status, 201, member.body.message);
    const [[row]] = await pool.execute(
      'SELECT member_username, member_discount_pct, merchandise_subtotal, member_discount_amount FROM orders WHERE order_number = ?',
      [member.body.data.order_number]
    );
    assert.equal(row.member_username, 'juan01', 'the username comes from the signed pass');
    assert.equal(Number(row.member_discount_pct), 30);
    assert.ok(Number(row.member_discount_amount) > 0);

    mlm.close();
    const down = await api('POST', '/members/verify', { body: { username: 'juan01', password: 'Right#Pass1' } });
    assert.equal(down.status, 503, 'MLM unreachable is never treated as a pass');
  } finally {
    env.MLM_API_URL = saved.url;
    env.MLM_API_KEY = saved.key;
    mlm.close();
  }
});
