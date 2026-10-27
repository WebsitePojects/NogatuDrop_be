// Real-database proof that "Mark delivered (courier)" closes an order exactly once: sequential and concurrent
// presses take the stock out once, close the Rider Link, and the rider's link cannot confirm it again.
// Run: NCDMS_DB_TESTS=1 node --env-file=<env> --test --test-force-exit test/courierDelivery.integration.test.js
// Needs a local database with at least one store order, the J&T courier and a product in stock.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs the local database)' };

let pool;
let controller;
let batchStock;
let base; // { partnerId, otherPartnerId, adminId, courierId, productId, warehouseId }
let inventorySnapshot = [];
const createdOrderIds = [];

/** Runs an asyncHandler-wrapped controller and returns { status, body }. */
function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handler(req, res, (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } }));
  });
}

const adminReq = (orderId) => ({ params: { orderId }, user: { id: base.adminId, role_slug: 'super_admin', partner_id: null } });

async function makeCourierOrder({ status = 'delivering', waybill = 'JT0000000001' } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const orderNumber = `TEST-COURIER-${Date.now()}-${crypto.randomInt(1000)}`;
    const [order] = await conn.execute(
      `INSERT INTO orders (order_number, partner_id, placed_by, placed_by_type, status, payment_status, total_amount, source_warehouse_id, customer_name)
       VALUES (?, ?, ?, 'public', ?, 'paid', 100, ?, 'Courier Test')`,
      [orderNumber, base.partnerId, base.adminId, status, base.warehouseId]
    );
    const orderId = order.insertId;
    await conn.execute(
      'INSERT INTO order_items (order_id, product_id, quantity, unit_price, source_warehouse_id) VALUES (?, ?, 1, 100, ?)',
      [orderId, base.productId, base.warehouseId]
    );
    // 1 box for this order plus 2 held by other orders, as in a real warehouse: a second delivery of this
    // order must be stopped by the order guard, not by the reservation happening to run out.
    assert.ok(await batchStock.reserveStock(conn, { productId: base.productId, warehouseId: base.warehouseId, quantity: 3 }), 'reserve 3 boxes');
    await conn.execute(
      `INSERT INTO delivery_tracking (order_id, status, courier_id, courier_tracking_number) VALUES (?, 'out_for_delivery', ?, ?)`,
      [orderId, waybill ? base.courierId : null, waybill]
    );
    await conn.execute(
      'INSERT INTO delivery_tokens (order_id, token, expires_at, is_used, created_by) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY), 0, ?)',
      [orderId, crypto.randomUUID(), base.adminId]
    );
    await conn.commit();
    createdOrderIds.push(orderId);
    return orderId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function stockOutCount(orderId) {
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS n FROM stock_movements WHERE reference_type = 'order' AND reference_id = ? AND movement_type = 'out'`,
    [orderId]
  );
  return Number(row.n);
}

test.before(async () => {
  if (!enabled) return;
  pool = require('../src/config/db');
  controller = require('../src/controllers/deliveryTokenController');
  batchStock = require('../src/services/batchStock');
  const [[store]] = await pool.execute("SELECT partner_id FROM orders WHERE placed_by_type = 'public' ORDER BY id DESC LIMIT 1");
  const [[other]] = await pool.execute('SELECT id FROM partners WHERE id <> ? AND is_deleted = 0 LIMIT 1', [store.partner_id]);
  const [[admin]] = await pool.execute(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.slug = 'super_admin' AND u.is_deleted = 0 LIMIT 1`
  );
  const [[courier]] = await pool.execute("SELECT id FROM couriers WHERE name LIKE 'J&T%' LIMIT 1");
  const [[stock]] = await pool.execute(
    'SELECT product_id, warehouse_id FROM inventories WHERE current_stock - reserved_stock >= 10 ORDER BY id LIMIT 1'
  );
  assert.ok(store && other && admin && courier && stock, 'local database needs a store order, two partners, an admin, J&T and stock');
  base = {
    partnerId: store.partner_id, otherPartnerId: other.id, adminId: admin.id,
    courierId: courier.id, productId: stock.product_id, warehouseId: stock.warehouse_id,
  };
  [inventorySnapshot] = await pool.execute(
    'SELECT id, current_stock, reserved_stock FROM inventories WHERE product_id = ? AND warehouse_id = ?',
    [base.productId, base.warehouseId]
  );
});

test.after(async () => {
  if (!enabled) return;
  // Test fixtures only: remove what this file created and put the stock rows back as they were.
  for (const orderId of createdOrderIds) {
    await pool.execute("DELETE FROM stock_movements WHERE reference_type = 'order' AND reference_id = ?", [orderId]);
    await pool.execute("DELETE FROM notifications WHERE entity_type = 'order' AND entity_id = ?", [orderId]);
    await pool.execute('DELETE FROM order_notification_outbox WHERE order_id = ?', [orderId]);
    await pool.execute('DELETE FROM delivery_tokens WHERE order_id = ?', [orderId]);
    await pool.execute('DELETE FROM delivery_tracking WHERE order_id = ?', [orderId]);
    await pool.execute('DELETE FROM order_items WHERE order_id = ?', [orderId]);
    await pool.execute('DELETE FROM orders WHERE id = ?', [orderId]);
  }
  for (const row of inventorySnapshot) {
    await pool.execute('UPDATE inventories SET current_stock = ?, reserved_stock = ? WHERE id = ?', [row.current_stock, row.reserved_stock, row.id]);
  }
  await pool.end();
});

test('pressed twice in a row: delivered once, stock out once, Rider Link closed', opts, async () => {
  const orderId = await makeCourierOrder();
  const first = await call(controller.confirmCourierDelivery, adminReq(orderId));
  const second = await call(controller.confirmCourierDelivery, adminReq(orderId));
  assert.equal(first.status, 200, first.body.message);
  assert.equal(second.status, 409);
  assert.equal(await stockOutCount(orderId), 1);
  const [[order]] = await pool.execute('SELECT status, delivered_at FROM orders WHERE id = ?', [orderId]);
  assert.equal(order.status, 'delivered');
  assert.ok(order.delivered_at);
  const [[token]] = await pool.execute('SELECT is_used FROM delivery_tokens WHERE order_id = ?', [orderId]);
  assert.equal(Number(token.is_used), 1, 'the unused Rider Link is closed');
  const [[movement]] = await pool.execute(
    "SELECT created_by, notes FROM stock_movements WHERE reference_type = 'order' AND reference_id = ?", [orderId]
  );
  assert.equal(Number(movement.created_by), Number(base.adminId), 'who confirmed it is recorded');
  assert.match(movement.notes, /J&T.*JT0000000001/);
});

test('pressed three times at once: exactly one succeeds, stock out once', opts, async () => {
  const orderId = await makeCourierOrder();
  const results = await Promise.all([1, 2, 3].map(() => call(controller.confirmCourierDelivery, adminReq(orderId))));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await stockOutCount(orderId), 1);
});

test('the rider link cannot confirm an order the courier already delivered', opts, async () => {
  const orderId = await makeCourierOrder();
  const [[{ token }]] = await pool.execute('SELECT token FROM delivery_tokens WHERE order_id = ?', [orderId]);
  assert.equal((await call(controller.confirmCourierDelivery, adminReq(orderId))).status, 200);
  const rider = await call(controller.completeDelivery, { params: { token }, body: {}, file: { path: 'https://example.com/pod.jpg' } });
  assert.equal(rider.status, 404);
  assert.equal(await stockOutCount(orderId), 1);
});

test('refused: no waybill saved (400), not on the way yet (409), another partner\'s staff (403)', opts, async () => {
  const noWaybill = await makeCourierOrder({ waybill: null });
  assert.equal((await call(controller.confirmCourierDelivery, adminReq(noWaybill))).status, 400);
  const notShipped = await makeCourierOrder({ status: 'approved' });
  assert.equal((await call(controller.confirmCourierDelivery, adminReq(notShipped))).status, 409);
  const ok = await makeCourierOrder();
  const outsider = await call(controller.confirmCourierDelivery, {
    params: { orderId: ok }, user: { id: base.adminId, role_slug: 'staff', partner_id: base.otherPartnerId },
  });
  assert.equal(outsider.status, 403);
  for (const orderId of [noWaybill, notShipped, ok]) assert.equal(await stockOutCount(orderId), 0);
});
