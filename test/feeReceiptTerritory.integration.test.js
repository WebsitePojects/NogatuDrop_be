// Real-database proof for management round 4 (2026-10-08):
//  - changing a store order's delivery fee: two identical saves, one after the other and at the same time,
//    make exactly one change and one log row; the total moves by the fee difference only;
//  - after a fee increase the buyer can send ONE extra receipt (two at once: one accepted, one 409), and
//    payment cannot be verified while money is still owed;
//  - routing: a buyer inside a Stockist's territory goes to that Stockist, not when it lacks stock, and
//    never for an affiliate-link order.
// Every row the test touches is restored afterwards.
// Run: NCDMS_DB_TESTS=1 node --env-file=<env of a LOCAL copy> --test --test-force-exit test/feeReceiptTerritory.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs the local database)' };

let pool;
let orders;
let superAdmin;
let order;
const saved = {};
const territoryIds = [];

function invoke(handler, { body = {}, params = {}, file } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    handler({ user: superAdmin, body, params, query: {}, headers: {}, file, get: () => undefined }, res, (error) => {
      resolve({ status: error.statusCode || 500, error });
    });
  });
}
const changeFee = (fee) => invoke(orders.changeShippingFee, {
  params: { id: String(order.id) }, body: { shipping_fee: fee, reason: 'QA bulk order' },
});
const feeRows = async () => Number((await pool.execute('SELECT COUNT(*) n FROM order_fee_adjustments WHERE order_id = ?', [order.id]))[0][0].n);
const orderRow = async () => (await pool.execute(
  'SELECT shipping_fee, total_amount, payment_covered_total, payment_proof_url FROM orders WHERE id = ?', [order.id]))[0][0];

test.before(async () => {
  if (!enabled) return;
  process.env.REDIS_ENABLED = 'false';
  pool = require('../src/config/db');
  orders = require('../src/controllers/orderController');
  const [[admin]] = await pool.execute(
    `SELECT u.id, r.slug AS role_slug, u.partner_id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.is_deleted = 0 AND u.status = 'active' LIMIT 1`
  );
  superAdmin = admin;
  const [[row]] = await pool.execute(
    `SELECT id, order_number, customer_phone, shipping_fee, total_amount, payment_covered_total, payment_proof_url,
            payment_proof_uploaded_at, status
     FROM orders WHERE placed_by_type = 'public' AND payment_status = 'unpaid' AND status = 'pending'
       AND is_deleted = 0 AND customer_phone IS NOT NULL ORDER BY id DESC LIMIT 1`
  );
  assert.ok(row, 'the local copy needs one pending unpaid store order');
  order = row;
  Object.assign(saved, row);
  saved.maxFeeId = Number((await pool.execute('SELECT COALESCE(MAX(id),0) m FROM order_fee_adjustments'))[0][0].m);
  saved.maxProofId = Number((await pool.execute('SELECT COALESCE(MAX(id),0) m FROM order_payment_proofs'))[0][0].m);
});

test.after(async () => {
  if (!enabled) return;
  await pool.execute('DELETE FROM order_fee_adjustments WHERE id > ? AND order_id = ?', [saved.maxFeeId, order.id]);
  await pool.execute('DELETE FROM order_payment_proofs WHERE id > ? AND order_id = ?', [saved.maxProofId, order.id]);
  await pool.execute(
    `UPDATE orders SET shipping_fee = ?, total_amount = ?, payment_covered_total = ?, payment_proof_url = ?,
            payment_proof_uploaded_at = ?, status = ? WHERE id = ?`,
    [saved.shipping_fee, saved.total_amount, saved.payment_covered_total, saved.payment_proof_url,
      saved.payment_proof_uploaded_at, saved.status, order.id]
  );
  for (const id of territoryIds) await pool.execute('DELETE FROM stockist_territories WHERE id = ?', [id]);
  await pool.end();
});

test('delivery fee: the same change saved twice in a row is applied once', opts, async () => {
  const before = await feeRows();
  const newFee = Number(saved.shipping_fee) + 100;
  const first = await changeFee(newFee);
  const second = await changeFee(newFee);
  assert.equal(first.status, 200, first.error?.message);
  assert.equal(second.status, 200, 'saving the fee the order already has is a harmless no-op');
  assert.equal(await feeRows(), before + 1, 'one log row');
  const row = await orderRow();
  assert.equal(Number(row.shipping_fee), newFee);
  assert.equal(Math.round(Number(row.total_amount) * 100), Math.round((Number(saved.total_amount) + 100) * 100), 'total moves by the fee difference only');
});

test('delivery fee: the same change sent twice at once is applied once', opts, async () => {
  const before = await feeRows();
  const newFee = Number(saved.shipping_fee) + 250;
  const results = await Promise.all([changeFee(newFee), changeFee(newFee)]);
  assert.ok(results.every((r) => [200, 409].includes(r.status)), results.map((r) => r.status).join(','));
  assert.equal(await feeRows(), before + 1, 'one log row');
  assert.equal(Number((await orderRow()).shipping_fee), newFee);
});

test('delivery fee: bad requests are refused and change nothing', opts, async () => {
  const before = await orderRow();
  const outsider = { ...superAdmin, role_slug: 'staff', partner_id: 999999 };
  const asOutsider = await new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); } };
    orders.changeShippingFee({ user: outsider, params: { id: String(order.id) }, body: { shipping_fee: 1, reason: 'QA' } }, res, (e) => resolve({ status: e.statusCode || 500 }));
  });
  assert.ok([403, 404].includes(asOutsider.status), `outsider got ${asOutsider.status}`);
  assert.deepEqual(await orderRow(), before);
});

test('extra receipt: after a fee increase the buyer sends one extra receipt; two at once record one', opts, async () => {
  // The buyer already paid the earlier total.
  await pool.execute(
    "UPDATE orders SET payment_proof_url = 'https://example.test/first.png', payment_proof_uploaded_at = NOW(), payment_covered_total = total_amount WHERE id = ?",
    [order.id]
  );
  const raised = await changeFee(Number((await orderRow()).shipping_fee) + 300);
  assert.equal(raised.status, 200);
  assert.equal(raised.body.data.amount_still_owed, 300);

  // Payment cannot be verified while the 300 is outstanding.
  await pool.execute("UPDATE orders SET status = 'approved' WHERE id = ?", [order.id]);
  const verify = await invoke(orders.verifyPayment, { params: { id: String(order.id) } });
  assert.equal(verify.status, 409, verify.error?.message);
  assert.match(verify.error.message, /still owes ₱300\.00/);

  const upload = () => invoke(orders.uploadPublicPaymentProof, {
    body: { order_number: order.order_number, customer_phone: order.customer_phone },
    file: { path: `https://example.test/extra-${Date.now()}-${Math.random()}.png` },
  });
  const results = await Promise.all([upload(), upload()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409], results.map((r) => r.error?.message).join(' | '));
  const [extra] = await pool.execute("SELECT kind, covers_total FROM order_payment_proofs WHERE order_id = ? AND id > ?", [order.id, saved.maxProofId]);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].kind, 'additional');
  const row = await orderRow();
  assert.equal(Number(row.payment_covered_total), Number(row.total_amount), 'receipts now cover the new total');

  const again = await upload();
  assert.equal(again.status, 409, 'nothing owed, so no third receipt');
});

test('routing: a buyer in a Stockist territory goes to that Stockist; no stock or an affiliate order goes to a center', opts, async () => {
  const { resolvePublicFulfillmentRoute } = orders.__testables;
  const [[stockist]] = await pool.execute(
    `SELECT p.id AS partner_id, w.id AS warehouse_id, i.product_id,
            SUM(i.current_stock - i.reserved_stock) AS available, b.code AS barangay, c.code AS city
     FROM partners p
     JOIN warehouses w ON w.partner_id = p.id AND w.is_deleted = 0 AND w.is_active = 1
     JOIN inventories i ON i.warehouse_id = w.id
     JOIN ph_cities_municipalities c ON c.name LIKE 'Quezon City%'
     JOIN ph_barangays b ON b.city_code = c.code
     WHERE p.stockist_level = 'city_stockist' AND p.status = 'active' AND p.is_deleted = 0
       AND NOT EXISTS (SELECT 1 FROM stockist_territories t WHERE t.area_type = 'city' AND t.area_code = c.code)
     GROUP BY p.id, w.id, i.product_id, b.code, c.code
     HAVING available >= 1 LIMIT 1`
  );
  assert.ok(stockist, 'the local copy needs a City Stockist with stock and a free Quezon City territory');
  const [inserted] = await pool.execute(
    "INSERT INTO stockist_territories (partner_id, area_type, area_code) VALUES (?, 'city', ?)", [stockist.partner_id, stockist.city]
  );
  territoryIds.push(inserted.insertId);

  const one = [{ product_id: stockist.product_id, quantity: 1, name: 'QA' }];
  const routed = await resolvePublicFulfillmentRoute(pool, one, { barangayCode: stockist.barangay });
  assert.equal(routed.routed_by, 'territory');
  assert.equal(Number(routed.partner_id), Number(stockist.partner_id));
  assert.notEqual(Number(routed.payment_warehouse_id), Number(stockist.warehouse_id), 'the buyer pays a Nogatu center account');

  const affiliate = await resolvePublicFulfillmentRoute(pool, one, { barangayCode: stockist.barangay, centersOnly: true });
  assert.equal(affiliate.routed_by, 'center');

  const tooMany = [{ product_id: stockist.product_id, quantity: Number(stockist.available) + 1, name: 'QA' }];
  const fallback = await resolvePublicFulfillmentRoute(pool, tooMany, { barangayCode: stockist.barangay }).catch((e) => e);
  assert.ok(fallback.routed_by === 'center' || fallback.statusCode === 409, 'short on stock: a center takes it (or nobody has enough)');
});
