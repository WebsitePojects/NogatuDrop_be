const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isFutureIsoDate,
  isClientRefDuplicate,
  resolveReceivingWarehouse,
  receiveStockOnce,
} = require('../src/services/stockReceiving');

// ---------------------------------------------------------------------------
// resolveReceivingWarehouse — authorization matrix (pure)
// ---------------------------------------------------------------------------

const resolve = (overrides) => resolveReceivingWarehouse({
  roleSlug: 'staff',
  partnerId: 10,
  requestedWarehouseId: null,
  ownedWarehouseIds: [7],
  ...overrides,
});

test('super admin must name a warehouse and may pick any', () => {
  assert.equal(resolve({ roleSlug: 'super_admin', partnerId: null, requestedWarehouseId: 99, ownedWarehouseIds: [] }), 99);
  assert.throws(
    () => resolve({ roleSlug: 'super_admin', partnerId: null, requestedWarehouseId: null, ownedWarehouseIds: [] }),
    (err) => err.statusCode === 400
  );
});

for (const roleSlug of ['provincial_stockist', 'city_stockist', 'staff']) {
  test(`${roleSlug} is forced to a warehouse owned by their partner`, () => {
    assert.equal(resolve({ roleSlug, requestedWarehouseId: 7 }), 7);
    assert.equal(resolve({ roleSlug, requestedWarehouseId: '7' }), 7);
    assert.throws(() => resolve({ roleSlug, requestedWarehouseId: 8 }), (err) => err.statusCode === 403);
  });

  test(`${roleSlug} omitting warehouse_id: one owned warehouse is used, otherwise 400`, () => {
    assert.equal(resolve({ roleSlug, ownedWarehouseIds: [7] }), 7);
    assert.throws(() => resolve({ roleSlug, ownedWarehouseIds: [7, 8] }), (err) => err.statusCode === 400);
    assert.throws(() => resolve({ roleSlug, ownedWarehouseIds: [] }), (err) => err.statusCode === 400);
  });

  test(`${roleSlug} without a partner is rejected`, () => {
    assert.throws(() => resolve({ roleSlug, partnerId: null, requestedWarehouseId: 7 }), (err) => err.statusCode === 403);
  });
}

test('mobile stockists and unknown roles fail closed with 403', () => {
  for (const roleSlug of ['mobile_stockist', 'ambassador', '', undefined]) {
    assert.throws(() => resolve({ roleSlug, requestedWarehouseId: 7 }), (err) => err.statusCode === 403, String(roleSlug));
  }
});

// ---------------------------------------------------------------------------
// isFutureIsoDate / isClientRefDuplicate
// ---------------------------------------------------------------------------

test('expiry must be a real calendar date strictly after today in Manila time', () => {
  // 2026-10-01T17:00Z is already 2026-10-02 in Manila (UTC+8).
  const now = new Date('2026-10-01T17:00:00Z');
  assert.equal(isFutureIsoDate('2026-10-03', now), true);
  assert.equal(isFutureIsoDate('2026-10-02', now), false);
  assert.equal(isFutureIsoDate('2026-10-01', now), false);
  assert.equal(isFutureIsoDate('2026-02-30', now), false);
  assert.equal(isFutureIsoDate('2027-7-23', now), false);
  assert.equal(isFutureIsoDate('2027-07-23T00:00:00Z', now), false);
  assert.equal(isFutureIsoDate(20270723, now), false);
  assert.equal(isFutureIsoDate(undefined, now), false);
});

test('only the client_ref unique index counts as a replay, not other duplicate keys', () => {
  const dup = (message) => Object.assign(new Error(message), { code: 'ER_DUP_ENTRY', sqlMessage: message });
  assert.equal(isClientRefDuplicate(dup("Duplicate entry 'abc' for key 'uq_grn_client_ref'")), true);
  assert.equal(isClientRefDuplicate(dup("Duplicate entry 'abc' for key 'goods_receipts.uq_grn_client_ref'")), true);
  assert.equal(isClientRefDuplicate(dup("Duplicate entry 'GRN-1' for key 'uq_grn_number'")), false);
  assert.equal(isClientRefDuplicate(new Error('boom')), false);
  assert.equal(isClientRefDuplicate(null), false);
});

// ---------------------------------------------------------------------------
// receiveStockOnce — duplicate safety against an in-memory stand-in for the DB
// ---------------------------------------------------------------------------

// Models the three behaviours the guarantee depends on: a UNIQUE client_ref, writes visible only
// after commit, and the warehouse FOR UPDATE lock that serializes concurrent receipts.
function createFakeDb({ failOn } = {}) {
  const committed = { receipts: [], stock: 100 };
  let lockTail = Promise.resolve();
  const calls = { rollbacks: 0, commits: 0 };

  const dupError = (index) => Object.assign(new Error(`Duplicate entry for key '${index}'`), {
    code: 'ER_DUP_ENTRY',
    sqlMessage: `Duplicate entry 'x' for key '${index}'`,
  });

  async function getConnection() {
    let releaseLock = null;
    let staged = { receipt: null, delta: 0 };
    const finish = () => { if (releaseLock) releaseLock(); releaseLock = null; };

    return {
      async beginTransaction() { staged = { receipt: null, delta: 0 }; },
      async commit() {
        calls.commits += 1;
        if (staged.receipt) committed.receipts.push(staged.receipt);
        committed.stock += staged.delta;
        finish();
      },
      async rollback() { calls.rollbacks += 1; staged = { receipt: null, delta: 0 }; finish(); },
      release() {},
      async execute(sql, params) {
        if (failOn && sql.includes(failOn.sql)) throw failOn.error;
        if (sql.includes('FROM warehouses')) {
          const previous = lockTail;
          lockTail = new Promise((resolve) => { releaseLock = resolve; });
          await previous;
          return [[{ id: 7, partner_id: 3 }]];
        }
        if (sql.includes('FROM products')) return [[{ id: 13 }]];
        if (sql.startsWith('INSERT INTO goods_receipts')) {
          const clientRef = params[5];
          if (committed.receipts.some((r) => r.clientRef === clientRef)) throw dupError('uq_grn_client_ref');
          staged.receipt = { grnId: committed.receipts.length + 1, clientRef, warehouseId: params[1] };
          return [{ insertId: staged.receipt.grnId }];
        }
        if (sql.startsWith('INSERT INTO grn_items')) {
          Object.assign(staged.receipt, { productId: params[1], quantity: params[3], batchNumber: params[4], expiryDate: params[5] });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes('FROM inventories')) return [[{ id: 5, current_stock: committed.stock }]];
        if (sql.startsWith('UPDATE inventories')) { staged.delta += params[0]; return [{ affectedRows: 1 }]; }
        if (sql.startsWith('INSERT INTO stock_movements')) {
          Object.assign(staged.receipt, { inventoryId: params[0], newStock: params[6] });
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
  }

  // The replay lookup runs through the pool-like object itself, outside any transaction.
  async function execute(sql, params) {
    assert.match(sql, /WHERE g\.client_ref = \?/);
    return [committed.receipts.filter((r) => r.clientRef === params[0])];
  }

  return { getConnection, execute, committed, calls };
}

const receipt = (overrides = {}) => ({
  productId: 13,
  warehouseId: 7,
  quantity: 25,
  batchNumber: 'B02',
  expiryDate: '2027-12-31',
  createdBy: 1,
  clientRef: 'ref-1',
  ...overrides,
});

test('a single receipt is created once and reports the new stock', async () => {
  const db = createFakeDb();
  const outcome = await receiveStockOnce(db, receipt());
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.result.newStock, 125);
  assert.equal(db.committed.stock, 125);
  assert.equal(db.committed.receipts.length, 1);
});

test('sequential double-fire: second request replays the original result, one effect', async () => {
  const db = createFakeDb();
  const first = await receiveStockOnce(db, receipt());
  const second = await receiveStockOnce(db, receipt());

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.result, first.result);
  assert.equal(db.committed.receipts.length, 1);
  assert.equal(db.committed.stock, 125);
  assert.equal(db.calls.rollbacks, 1, 'the loser rolls back before the replay re-query');
});

test('concurrent double-fire (Promise.all): exactly one effect, every caller gets the same result', async () => {
  const db = createFakeDb();
  const outcomes = await Promise.all([
    receiveStockOnce(db, receipt()),
    receiveStockOnce(db, receipt()),
    receiveStockOnce(db, receipt()),
  ]);

  assert.equal(outcomes.filter((o) => !o.replayed).length, 1);
  assert.equal(outcomes.filter((o) => o.replayed).length, 2);
  for (const outcome of outcomes) assert.deepEqual(outcome.result, outcomes[0].result);
  assert.equal(db.committed.receipts.length, 1);
  assert.equal(db.committed.stock, 125);
});

test('different keys are independent receipts', async () => {
  const db = createFakeDb();
  await Promise.all([receiveStockOnce(db, receipt({ clientRef: 'a' })), receiveStockOnce(db, receipt({ clientRef: 'b' }))]);
  assert.equal(db.committed.receipts.length, 2);
  assert.equal(db.committed.stock, 150);
});

test('reusing a key with a different payload is a 409, never a silent replay', async () => {
  const db = createFakeDb();
  await receiveStockOnce(db, receipt());
  for (const changed of [{ quantity: 26 }, { batchNumber: 'B03' }, { expiryDate: '2028-01-01' }, { warehouseId: 8 }, { productId: 14 }]) {
    await assert.rejects(
      () => receiveStockOnce(db, receipt(changed)),
      (err) => err.statusCode === 409,
      JSON.stringify(changed)
    );
  }
  assert.equal(db.committed.stock, 125);
});

test('a duplicate on another unique index (grn_number) is NOT mistaken for a replay', async () => {
  const error = Object.assign(new Error("Duplicate entry 'GRN-1' for key 'uq_grn_number'"), {
    code: 'ER_DUP_ENTRY',
    sqlMessage: "Duplicate entry 'GRN-1' for key 'uq_grn_number'",
  });
  const db = createFakeDb({ failOn: { sql: 'INSERT INTO goods_receipts', error } });
  await assert.rejects(() => receiveStockOnce(db, receipt()), (err) => err === error);
  assert.equal(db.committed.receipts.length, 0);
  assert.equal(db.calls.rollbacks, 1);
});

test('an unexpected error rolls back and leaves no stock change', async () => {
  const error = new Error('connection lost');
  const db = createFakeDb({ failOn: { sql: 'UPDATE inventories', error } });
  await assert.rejects(() => receiveStockOnce(db, receipt()), (err) => err === error);
  assert.equal(db.committed.stock, 100);
  assert.equal(db.committed.receipts.length, 0);
});

test('invalid quantities are rejected before touching the database', async () => {
  const db = createFakeDb();
  for (const quantity of [0, -5, 1.5, 1000001, '10']) {
    await assert.rejects(() => receiveStockOnce(db, receipt({ quantity })), (err) => err.statusCode === 400, String(quantity));
  }
  assert.equal(db.committed.receipts.length, 0);
});
