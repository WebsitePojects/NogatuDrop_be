// Real-database proof that order stock operations work on a warehouse that keeps one inventories row
// per batch (like Tycoon, warehouse #16 in production), including concurrent orders.
// Run: NCDMS_DB_TESTS=1 node --env-file=.env.dev --test --test-force-exit test/batchStock.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs the local database)' };

let pool;
let batch;
let warehouseId;
let productId;

// Tycoon's real Mangosteen Coffee Mix batches (counted 2026-07-10).
const TYCOON_MANGOSTEEN = [
  { qty: 50, batch: 'B05', expiry: '2027-07-07' },
  { qty: 162, batch: 'B04', expiry: '2027-07-08' },
  { qty: 54, batch: 'B06', expiry: '2027-07-10' },
  { qty: 270, batch: 'B07', expiry: '2027-07-10' },
];

async function inTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function totals() {
  const [[row]] = await pool.execute(
    'SELECT SUM(current_stock) AS onHand, SUM(reserved_stock) AS reserved, SUM(reserved_stock > current_stock) AS broken FROM inventories WHERE warehouse_id = ? AND product_id = ?',
    [warehouseId, productId]
  );
  return { onHand: Number(row.onHand), reserved: Number(row.reserved), broken: Number(row.broken) };
}

test.before(async () => {
  if (!enabled) return;
  pool = require('../src/config/db');
  batch = require('../src/services/batchStock');
  const [[product]] = await pool.execute("SELECT id FROM products WHERE sku = 'NOG-105' LIMIT 1");
  productId = product.id;
  const [wh] = await pool.execute(
    "INSERT INTO warehouses (name, type, location, is_active) VALUES (?, 'city', 'Batch stock test', 1)",
    [`QA batch stock ${Date.now().toString(36)}`]
  );
  warehouseId = wh.insertId;
  for (const b of TYCOON_MANGOSTEEN) {
    await pool.execute(
      'INSERT INTO inventories (product_id, warehouse_id, current_stock, batch_number, expiry_date) VALUES (?, ?, ?, ?, ?)',
      [productId, warehouseId, b.qty, b.batch, b.expiry]
    );
  }
});

test.after(async () => {
  if (!enabled) return;
  await pool.execute('UPDATE inventories SET is_active = 0 WHERE warehouse_id = ?', [warehouseId]);
  await pool.execute('UPDATE warehouses SET is_active = 0, is_deleted = 1 WHERE id = ?', [warehouseId]);
  await pool.end();
});

test('an order larger than any one batch reserves exactly its quantity, earliest expiry first', opts, async () => {
  const result = await inTransaction((conn) => batch.reserveStock(conn, { productId, warehouseId, quantity: 300 }));
  assert.equal(result.reserved, true);
  assert.deepEqual(await totals(), { onHand: 536, reserved: 300, broken: 0 });
  const [rows] = await pool.execute('SELECT batch_number, reserved_stock FROM inventories WHERE warehouse_id = ? ORDER BY expiry_date, id', [warehouseId]);
  assert.deepEqual(rows.map((r) => [r.batch_number, Number(r.reserved_stock)]), [['B05', 50], ['B04', 162], ['B06', 54], ['B07', 34]]);
});

test('six concurrent orders of 40 against 236 free: five succeed, one is refused, nothing over-reserved', opts, async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => (
    inTransaction((conn) => batch.reserveStock(conn, { productId, warehouseId, quantity: 40 }))
  )));
  assert.equal(results.filter((r) => r.reserved).length, 5);
  assert.equal(results.filter((r) => !r.reserved).length, 1);
  assert.deepEqual(await totals(), { onHand: 536, reserved: 500, broken: 0 });
});

test('a refused order writes nothing', opts, async () => {
  const result = await inTransaction((conn) => batch.reserveStock(conn, { productId, warehouseId, quantity: 37 }));
  assert.deepEqual(result, { reserved: false, available: 36 });
  assert.deepEqual(await totals(), { onHand: 536, reserved: 500, broken: 0 });
});

test('cancelling releases exactly the order quantity across batches', opts, async () => {
  const released = await inTransaction((conn) => batch.releaseStock(conn, { productId, warehouseId, quantity: 120 }));
  assert.equal(released, 120);
  assert.deepEqual(await totals(), { onHand: 536, reserved: 380, broken: 0 });
});

test('delivery deducts on-hand and reserved once, never more than reserved', opts, async () => {
  assert.equal(await inTransaction((conn) => batch.consumeReservedStock(conn, { productId, warehouseId, quantity: 200 })), true);
  assert.deepEqual(await totals(), { onHand: 336, reserved: 180, broken: 0 });
  assert.equal(await inTransaction((conn) => batch.consumeReservedStock(conn, { productId, warehouseId, quantity: 181 })), false);
  assert.deepEqual(await totals(), { onHand: 336, reserved: 180, broken: 0 });
});

test('concurrent deliveries and cancellations keep stock consistent', opts, async () => {
  await Promise.all([
    inTransaction((conn) => batch.consumeReservedStock(conn, { productId, warehouseId, quantity: 60 })),
    inTransaction((conn) => batch.consumeReservedStock(conn, { productId, warehouseId, quantity: 60 })),
    inTransaction((conn) => batch.releaseStock(conn, { productId, warehouseId, quantity: 60 })),
  ]);
  assert.deepEqual(await totals(), { onHand: 216, reserved: 0, broken: 0 });
});
