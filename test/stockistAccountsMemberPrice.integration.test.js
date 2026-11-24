// Real-database, real-HTTP proof for Sir Dino's answers of 2026-11-24:
//  - the member price skips products marked not eligible (packages), and never touches shipping;
//  - a Stockist manages only its own warehouses' payment accounts; Super Admin is told of each change;
//    the same account added twice (one after the other, and at once) is stored once.
// Every row the test adds is removed. Run on a LOCAL copy only:
//   NCDMS_DB_TESTS=1 node --env-file=<env of a local copy> --test --test-force-exit test/stockistAccountsMemberPrice.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs a local database copy)' };

let pool;
let server;
let baseUrl;
let env;
const created = { orderNumbers: [], partnerIds: [], warehouseIds: [], userIds: [], accountIds: [] };
let maxNotificationId = 0;
let inventorySnapshot = [];

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' && path === '/orders/public' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const tokenFor = (user) => require('jsonwebtoken').sign(user, env.JWT_SECRET, { expiresIn: '10m' });

async function makeStockist(tag) {
  const [p] = await pool.execute(
    `INSERT INTO partners (business_name, email, phone, address, stockist_level, discount_pct, status)
     VALUES (?, ?, '', 'Sim', 'provincial_stockist', 0, 'active')`,
    [`SIM ACC ${tag} ${Date.now()}`, `sim.acc.${tag}.${Date.now()}@sim.invalid`]
  );
  created.partnerIds.push(p.insertId);
  const [w] = await pool.execute(
    "INSERT INTO warehouses (name, partner_id, type, location, manager_name, is_active) VALUES (?, ?, 'region', 'Sim', 'Sim', 1)",
    [`SIM WH ${tag}`, p.insertId]
  );
  created.warehouseIds.push(w.insertId);
  const [u] = await pool.execute(
    `INSERT INTO users (name, email, password, role_id, partner_id, status)
     SELECT 'SIM owner', ?, 'x', id, ?, 'active' FROM roles WHERE slug = 'provincial_stockist'`,
    [`sim.owner.${tag}.${Date.now()}@sim.invalid`, p.insertId]
  );
  created.userIds.push(u.insertId);
  return { partnerId: p.insertId, warehouseId: w.insertId,
    token: tokenFor({ id: u.insertId, role_slug: 'provincial_stockist', partner_id: p.insertId }) };
}

test.before(async () => {
  if (!enabled) return;
  process.env.REDIS_ENABLED = 'false';
  process.env.RATE_LIMIT_ENABLED = 'false';
  pool = require('../src/config/db');
  env = require('../src/config/env');
  const app = require('../src/app');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  maxNotificationId = Number((await pool.execute('SELECT COALESCE(MAX(id),0) m FROM notifications'))[0][0].m);
  [inventorySnapshot] = await pool.execute('SELECT id, current_stock, reserved_stock FROM inventories');
});

test.after(async () => {
  if (!enabled) return;
  if (created.orderNumbers.length) {
    const [rows] = await pool.query('SELECT id FROM orders WHERE order_number IN (?)', [created.orderNumbers]);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      for (const t of ['order_notification_outbox', 'order_items', 'public_order_idempotency', 'order_payment_proofs', 'settlements']) {
        await pool.query(`DELETE FROM ${t} WHERE order_id IN (?)`, [ids]);
      }
      await pool.query("DELETE FROM stock_movements WHERE reference_type = 'order' AND reference_id IN (?)", [ids]);
      await pool.query('DELETE FROM orders WHERE id IN (?)', [ids]);
    }
  }
  for (const row of inventorySnapshot) {
    await pool.execute('UPDATE inventories SET reserved_stock = ?, current_stock = ? WHERE id = ?', [row.reserved_stock, row.current_stock, row.id]);
  }
  await pool.execute('UPDATE products SET member_price_eligible = 1 WHERE id = 6');
  await pool.execute('DELETE FROM notifications WHERE id > ?', [maxNotificationId]);
  if (created.warehouseIds.length) await pool.query('DELETE FROM bank_accounts WHERE warehouse_id IN (?)', [created.warehouseIds]);
  if (created.userIds.length) await pool.query('DELETE FROM users WHERE id IN (?)', [created.userIds]);
  if (created.warehouseIds.length) await pool.query('DELETE FROM warehouses WHERE id IN (?)', [created.warehouseIds]);
  if (created.partnerIds.length) {
    await pool.query('DELETE FROM stockist_territories WHERE partner_id IN (?)', [created.partnerIds]);
    await pool.query('DELETE FROM partners WHERE id IN (?)', [created.partnerIds]);
  }
  server?.close();
  await pool.end();
});

test('member price: a product marked "not eligible" (a package) keeps its full price; shipping is untouched', opts, async () => {
  const { signMemberPass } = require('../src/services/memberDiscount');
  await pool.execute('UPDATE products SET member_price_eligible = 0 WHERE id = 6');
  const [[ncr]] = await pool.execute(
    "SELECT b.code FROM ph_barangays b JOIN ph_cities_municipalities c ON c.code = b.city_code WHERE c.region_code = '130000000' ORDER BY b.code LIMIT 1"
  );
  const res = await api('POST', '/orders/public', {
    body: {
      customer_first_name: 'Sim', customer_last_name: 'Member', customer_address_line: '1 Test Street',
      customer_barangay_code: ncr.code, customer_phone: '09171234567', customer_email: 'sim.member@sim.invalid',
      payment_method: 'bank_transfer', items: [{ product_id: 2, quantity: 1 }, { product_id: 6, quantity: 1 }],
      member_pass: signMemberPass({ uid: '777', username: 'juan01' }),
    },
  });
  assert.equal(res.status, 201, res.body.message);
  created.orderNumbers.push(res.body.data.order_number);
  const [[order]] = await pool.execute(
    'SELECT id, merchandise_subtotal, member_discount_amount, shipping_fee FROM orders WHERE order_number = ?', [res.body.data.order_number]
  );
  const [items] = await pool.execute('SELECT product_id, unit_price FROM order_items WHERE order_id = ? ORDER BY product_id', [order.id]);
  const [[choc], [fuel]] = await Promise.all([
    pool.execute('SELECT retail_price FROM products WHERE id = 2').then(([r]) => r),
    pool.execute('SELECT retail_price FROM products WHERE id = 6').then(([r]) => r),
  ]);
  assert.equal(Number(items[0].unit_price), Math.round(Number(choc.retail_price) * 0.7 * 100) / 100, 'eligible product at member price');
  assert.equal(Number(items[1].unit_price), Number(fuel.retail_price), 'package keeps its full price');
  assert.equal(Number(order.member_discount_amount), Math.round(Number(choc.retail_price) * 0.3 * 100) / 100);
  assert.equal(Number(order.shipping_fee), 185, 'shipping is not discounted');
});

test('payment accounts: a Stockist sees and changes only its own; Super Admin is notified; double add stores one', opts, async () => {
  const a = await makeStockist('a');
  const b = await makeStockist('b');
  const account = { warehouse_id: a.warehouseId, bank_name: 'GCASH', account_name: 'SIM A', account_number: '09170000001' };

  assert.equal((await api('POST', '/bank-accounts', { token: a.token, body: { ...account, warehouse_id: null } })).status, 403,
    'only Super Admin sets the company default');
  assert.equal((await api('POST', '/bank-accounts', { token: a.token, body: { ...account, warehouse_id: b.warehouseId } })).status, 400,
    "another Stockist's warehouse looks missing");

  const first = await api('POST', '/bank-accounts', { token: a.token, body: account });
  assert.equal(first.status, 201, first.body.message);
  const again = await api('POST', '/bank-accounts', { token: a.token, body: account });
  assert.equal(again.status, 409, 'the same account twice in a row is stored once');
  const both = await Promise.all([
    api('POST', '/bank-accounts', { token: a.token, body: { ...account, account_number: '09170000002' } }),
    api('POST', '/bank-accounts', { token: a.token, body: { ...account, account_number: '09170000002' } }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409], both.map((r) => r.body.message).join(' | '));
  const [[{ n }]] = await pool.execute('SELECT COUNT(*) n FROM bank_accounts WHERE warehouse_id = ? AND is_deleted = 0', [a.warehouseId]);
  assert.equal(Number(n), 2);

  const listA = await api('GET', '/bank-accounts', { token: a.token });
  assert.ok(listA.body.data.length === 2 && listA.body.data.every((x) => Number(x.warehouse_id) === a.warehouseId));
  const listB = await api('GET', '/bank-accounts', { token: b.token });
  assert.equal(listB.body.data.length, 0, "B never sees A's accounts");
  assert.equal((await api('PUT', `/bank-accounts/${first.body.data.id}`, { token: b.token, body: { account_name: 'stolen' } })).status, 404);
  assert.equal((await api('DELETE', `/bank-accounts/${first.body.data.id}`, { token: b.token })).status, 404);

  assert.equal((await api('PUT', `/bank-accounts/${first.body.data.id}`, { token: a.token, body: { account_number: '09179999999' } })).status, 200);
  assert.equal((await api('DELETE', `/bank-accounts/${first.body.data.id}`, { token: a.token })).status, 200);

  const [notes] = await pool.execute(
    "SELECT title, message FROM notifications WHERE id > ? AND entity_type = 'bank_account' ORDER BY id", [maxNotificationId]
  );
  const titles = [...new Set(notes.map((x) => x.title))];
  assert.deepEqual(titles.sort(), ['Stockist payment account added', 'Stockist payment account changed', 'Stockist payment account removed']);
  assert.ok(notes.every((x) => !x.message.includes('09179999999') && !x.message.includes('09170000001')), 'full account numbers are never in notices');

  const staff = tokenFor({ id: created.userIds[0], role_slug: 'staff', partner_id: a.partnerId });
  assert.equal((await api('GET', '/bank-accounts', { token: staff })).status, 403, 'staff do not manage money details');
});
