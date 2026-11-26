// Real-database, real-HTTP proof for Sir Dino's answers of 2026-11-26:
//  - checkout offers only the payment options of the Stockist that ships to the address (the Davao case: GCash
//    only, so the company BDO is neither offered nor accepted);
//  - "Remove member price" on a pending order: regular prices back, shipping unchanged, buyer emailed once;
//    pressed twice in a row or at once, it applies once;
//  - Delete Stockist / warehouse: refused while orders or stock remain; then everything goes at once, the area
//    is free again, and a double delete deletes once. Hubs cannot be deleted.
// Every row the test adds is removed. Run on a LOCAL copy only:
//   NCDMS_DB_TESTS=1 node --env-file=<env of a local copy> --test --test-force-exit test/stockistPayDeleteMember.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs a local database copy)' };
const PRODUCT_ID = 2; // Chocolate Drink Mix: member price eligible, has a weight

let pool;
let server;
let baseUrl;
let env;
let adminToken;
let fixture; // { partnerId, warehouseId, inventoryId, accountId, cityCode, barangayCode }
const orderNumbers = [];
let maxNotificationId = 0;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' && path === '/orders/public' ? { 'Idempotency-Key': crypto.randomUUID() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const buyer = (extra = {}) => ({
  customer_first_name: 'Sim', customer_last_name: 'Buyer', customer_address_line: '1 Test Street',
  customer_barangay_code: fixture.barangayCode, customer_phone: '09171234567', customer_email: 'sim.buyer@sim.invalid',
  payment_method: 'bank_transfer', items: [{ product_id: PRODUCT_ID, quantity: 2 }], ...extra,
});

async function placeOrder(extra) {
  const res = await api('POST', '/orders/public', { body: buyer(extra) });
  if (res.status === 201) orderNumbers.push(res.body.data.order_number);
  return res;
}
const orderRow = async (number) => (await pool.execute('SELECT * FROM orders WHERE order_number = ?', [number]))[0][0];

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

  const [[admin]] = await pool.execute(
    `SELECT u.id, u.partner_id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active' LIMIT 1`
  );
  adminToken = require('jsonwebtoken').sign({ id: admin.id, role_slug: 'super_admin', partner_id: admin.partner_id }, env.JWT_SECRET, { expiresIn: '10m' });

  // An NCR city nobody holds, and the company must have at least one non-GCash account for the test to mean anything.
  const [[area]] = await pool.execute(
    `SELECT c.code AS city, MIN(b.code) AS barangay FROM ph_cities_municipalities c
     JOIN ph_barangays b ON b.city_code = c.code
     WHERE c.region_code = '130000000'
       AND NOT EXISTS (SELECT 1 FROM stockist_territories t WHERE t.area_type = 'city' AND t.area_code = c.code)
     GROUP BY c.code ORDER BY c.code LIMIT 1`
  );
  assert.ok(area, 'needs a free NCR city');
  const [[company]] = await pool.execute(
    "SELECT COUNT(*) n FROM bank_accounts WHERE warehouse_id IS NULL AND is_active = 1 AND is_deleted = 0 AND bank_name NOT LIKE '%CASH%'"
  );
  assert.ok(Number(company.n) > 0, 'needs a company bank account (BDO/PSBank) to prove it is not offered');

  const tag = Date.now();
  const [p] = await pool.execute(
    `INSERT INTO partners (business_name, email, phone, address, stockist_level, discount_pct, status)
     VALUES (?, ?, '', 'Sim', 'provincial_stockist', 10, 'active')`, [`SIM PAY ${tag}`, `sim.pay.${tag}@sim.invalid`]
  );
  const [w] = await pool.execute(
    "INSERT INTO warehouses (name, partner_id, type, location, manager_name, is_active) VALUES (?, ?, 'region', 'Sim', 'Sim', 1)",
    [`SIM PAY WH ${tag}`, p.insertId]
  );
  const [i] = await pool.execute(
    `INSERT INTO inventories (product_id, warehouse_id, partner_id, current_stock, reserved_stock, batch_number, expiry_date)
     VALUES (?, ?, ?, 50, 0, ?, DATE_ADD(CURDATE(), INTERVAL 1 YEAR))`, [PRODUCT_ID, w.insertId, p.insertId, `SIM-${tag}`]
  );
  const [a] = await pool.execute(
    "INSERT INTO bank_accounts (warehouse_id, bank_name, account_name, account_number, is_default) VALUES (?, 'GCASH', 'SIM PAY', '09170000009', 1)",
    [w.insertId]
  );
  await pool.execute("INSERT INTO stockist_territories (partner_id, area_type, area_code) VALUES (?, 'city', ?)", [p.insertId, area.city]);
  fixture = { partnerId: p.insertId, warehouseId: w.insertId, inventoryId: i.insertId, accountId: a.insertId, cityCode: area.city, barangayCode: area.barangay };
});

test.after(async () => {
  if (!enabled) return;
  if (orderNumbers.length) {
    const [rows] = await pool.query('SELECT id FROM orders WHERE order_number IN (?)', [orderNumbers]);
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      for (const t of ['order_notification_outbox', 'order_items', 'public_order_idempotency', 'order_payment_proofs', 'settlements']) {
        await pool.query(`DELETE FROM ${t} WHERE order_id IN (?)`, [ids]);
      }
      await pool.query("DELETE FROM stock_movements WHERE reference_type = 'order' AND reference_id IN (?)", [ids]);
      await pool.query('DELETE FROM orders WHERE id IN (?)', [ids]);
    }
  }
  if (fixture) {
    await pool.execute('DELETE FROM stock_movements WHERE warehouse_id = ?', [fixture.warehouseId]);
    await pool.execute('DELETE FROM inventories WHERE id = ?', [fixture.inventoryId]);
    await pool.execute('DELETE FROM bank_accounts WHERE warehouse_id = ?', [fixture.warehouseId]);
    await pool.execute('DELETE FROM stockist_territories WHERE partner_id = ?', [fixture.partnerId]);
    await pool.execute('DELETE FROM warehouses WHERE id = ?', [fixture.warehouseId]);
    await pool.execute('DELETE FROM partners WHERE id = ?', [fixture.partnerId]);
  }
  await pool.execute('DELETE FROM notifications WHERE id > ?', [maxNotificationId]);
  server?.close();
  await pool.end();
});

test('checkout offers only the shipping Stockist\'s payment options; any other is refused', opts, async () => {
  const quote = await api('POST', '/shipping/quote', {
    body: { barangay_code: fixture.barangayCode, items: [{ product_id: PRODUCT_ID, quantity: 2 }] },
  });
  assert.equal(quote.status, 200, quote.body.message);
  assert.deepEqual(quote.body.data.payment_providers, ['GCASH'], 'only the Stockist\'s GCash, not the company BDO/PSBank');

  const bdo = await placeOrder({ payment_provider: 'BDO' });
  assert.equal(bdo.status, 400);
  assert.match(bdo.body.message, /BDO is not available for this delivery address/);

  const gcash = await placeOrder({ payment_provider: 'GCASH' });
  assert.equal(gcash.status, 201, gcash.body.message);
  const order = await orderRow(gcash.body.data.order_number);
  assert.equal(Number(order.partner_id), fixture.partnerId, 'routed to the Stockist holding the area');
  assert.equal(Number(order.payment_account_id), fixture.accountId, 'pays the Stockist\'s own GCash');
});

test('remove member price: regular prices back, shipping kept, buyer emailed once; twice in a row or at once applies once', opts, async () => {
  const { signMemberPass } = require('../src/services/memberDiscount');
  const placed = await placeOrder({ payment_provider: 'GCASH', member_pass: signMemberPass({ uid: '777', username: 'juan01' }) });
  assert.equal(placed.status, 201, placed.body.message);
  const before = await orderRow(placed.body.data.order_number);
  assert.ok(Number(before.member_discount_amount) > 0, 'the order got the member price');
  const [[product]] = await pool.execute('SELECT retail_price FROM products WHERE id = ?', [PRODUCT_ID]);

  const path = `/orders/${before.id}/remove-member-price`;
  const both = await Promise.all([api('PATCH', path, { token: adminToken }), api('PATCH', path, { token: adminToken })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], both.map((r) => r.body.message).join(' | '));
  assert.equal((await api('PATCH', path, { token: adminToken })).status, 409, 'a third press changes nothing');

  const after = await orderRow(placed.body.data.order_number);
  const regular = 2 * Number(product.retail_price);
  assert.equal(Number(after.merchandise_subtotal), regular);
  assert.equal(Number(after.member_discount_amount), 0);
  assert.equal(Number(after.member_discount_pct), 0);
  assert.equal(Number(after.shipping_fee), Number(before.shipping_fee), 'shipping unchanged');
  assert.equal(Number(after.total_amount), regular + Number(before.shipping_fee) + Number(before.system_fee || 0));
  assert.equal(after.member_username, 'juan01', 'who signed in stays on record');
  const [items] = await pool.execute('SELECT unit_price FROM order_items WHERE order_id = ?', [before.id]);
  assert.ok(items.every((item) => Number(item.unit_price) === Number(product.retail_price)));
  const [[mail]] = await pool.execute(
    "SELECT COUNT(*) n FROM order_notification_outbox WHERE order_id = ? AND event_type = 'buyer_member_price_removed'", [before.id]
  );
  assert.equal(Number(mail.n), 1, 'one email to the buyer');

  // After the buyer has paid at the member price, it is no longer allowed.
  const paid = await placeOrder({ payment_provider: 'GCASH', member_pass: signMemberPass({ uid: '777', username: 'juan01' }) });
  const paidRow = await orderRow(paid.body.data.order_number);
  await pool.execute("UPDATE orders SET payment_proof_url = 'https://example.test/r.png' WHERE id = ?", [paidRow.id]);
  const refused = await api('PATCH', `/orders/${paidRow.id}/remove-member-price`, { token: adminToken });
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /already sent a payment/);
});

test('delete: refused while orders or stock remain; then the Stockist goes at once, its area is free; double delete deletes once', opts, async () => {
  const blocked = await api('DELETE', `/partners/${fixture.partnerId}`, { token: adminToken });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.message, /open order/);
  assert.match(blocked.body.message, /units in stock/);
  const whBlocked = await api('DELETE', `/warehouses/${fixture.warehouseId}`, { token: adminToken });
  assert.equal(whBlocked.status, 409, 'a warehouse with stock and orders is not deleted either');

  // Settle the test orders and empty the shelf, as staff would before closing a Stockist.
  await pool.query("UPDATE orders SET status = 'cancelled' WHERE order_number IN (?)", [orderNumbers]);
  await pool.execute('UPDATE inventories SET reserved_stock = 0, current_stock = 0 WHERE id = ?', [fixture.inventoryId]);

  const both = await Promise.all([
    api('DELETE', `/partners/${fixture.partnerId}`, { token: adminToken }),
    api('DELETE', `/partners/${fixture.partnerId}`, { token: adminToken }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], both.map((r) => r.body.message).join(' | '));
  assert.equal((await api('DELETE', `/partners/${fixture.partnerId}`, { token: adminToken })).status, 409);

  const [[partner]] = await pool.execute('SELECT is_deleted FROM partners WHERE id = ?', [fixture.partnerId]);
  const [[warehouse]] = await pool.execute('SELECT is_deleted FROM warehouses WHERE id = ?', [fixture.warehouseId]);
  const [[account]] = await pool.execute('SELECT is_deleted FROM bank_accounts WHERE id = ?', [fixture.accountId]);
  const [[territory]] = await pool.execute('SELECT COUNT(*) n FROM stockist_territories WHERE partner_id = ?', [fixture.partnerId]);
  assert.deepEqual([partner.is_deleted, warehouse.is_deleted, account.is_deleted, Number(territory.n)].map(Number), [1, 1, 1, 0]);

  const [[hub]] = await pool.execute("SELECT id FROM partners WHERE stockist_level = 'center' AND is_deleted = 0 LIMIT 1");
  if (hub) assert.equal((await api('DELETE', `/partners/${hub.id}`, { token: adminToken })).status, 400, 'hubs are never deleted');
});
