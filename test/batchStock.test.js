const test = require('node:test');
const assert = require('node:assert/strict');

const { availableOf, planReserve, planConsume, planRelease } = require('../src/services/batchStock');

// Tycoon's real Mangosteen Coffee Mix rows (warehouse #16, counted 2026-07-10), earliest expiry first.
const mangosteen = () => [
  { id: 56, current_stock: 50, reserved_stock: 0 }, // B05, 2027-07-07
  { id: 53, current_stock: 162, reserved_stock: 0 }, // B04, 2027-07-08
  { id: 55, current_stock: 54, reserved_stock: 0 }, // B06, 2027-07-10
  { id: 54, current_stock: 270, reserved_stock: 0 }, // B07, 2027-07-10
];

test('availability is the free stock of every batch row together', () => {
  assert.equal(availableOf(mangosteen()), 536);
  assert.equal(availableOf([{ current_stock: 10, reserved_stock: 4 }, { current_stock: 5, reserved_stock: 5 }]), 6);
});

test('an order reserves earliest-expiry batches first and reserves the quantity exactly once', () => {
  assert.deepEqual(planReserve(mangosteen(), 40), [{ id: 56, quantity: 40 }]);
  const plan = planReserve(mangosteen(), 300);
  assert.deepEqual(plan, [{ id: 56, quantity: 50 }, { id: 53, quantity: 162 }, { id: 55, quantity: 54 }, { id: 54, quantity: 34 }]);
  assert.equal(plan.reduce((sum, step) => sum + step.quantity, 0), 300);
});

test('an order larger than any single batch is accepted when the batches together cover it', () => {
  assert.notEqual(planReserve(mangosteen(), 536), null);
});

test('an order larger than the free stock is refused (no partial reservation)', () => {
  assert.equal(planReserve(mangosteen(), 537), null);
  const partlyReserved = mangosteen().map((row) => ({ ...row, reserved_stock: Math.min(row.current_stock, 40) }));
  assert.equal(availableOf(partlyReserved), 536 - 160);
  assert.equal(planReserve(partlyReserved, 377), null);
  assert.notEqual(planReserve(partlyReserved, 376), null);
});

test('delivery draws only on reserved stock, earliest expiry first', () => {
  const rows = [
    { id: 1, current_stock: 50, reserved_stock: 50 },
    { id: 2, current_stock: 162, reserved_stock: 10 },
    { id: 3, current_stock: 270, reserved_stock: 0 },
  ];
  assert.deepEqual(planConsume(rows, 55), [{ id: 1, quantity: 50 }, { id: 2, quantity: 5 }]);
  assert.equal(planConsume(rows, 61), null, 'cannot deliver more than is reserved');
});

test('release frees reservations and never fails, even if less is reserved than asked (older data)', () => {
  const rows = [{ id: 1, current_stock: 50, reserved_stock: 30 }, { id: 2, current_stock: 20, reserved_stock: 5 }];
  assert.deepEqual(planRelease(rows, 32), [{ id: 1, quantity: 30 }, { id: 2, quantity: 2 }]);
  assert.deepEqual(planRelease(rows, 100), [{ id: 1, quantity: 30 }, { id: 2, quantity: 5 }]);
  assert.deepEqual(planRelease([{ id: 1, current_stock: 9, reserved_stock: 0 }], 4), []);
});

test('a single-row product (like Berry NAD+ for /kawoodee) behaves as before', () => {
  const berry = [{ id: 52, current_stock: 10000, reserved_stock: 3 }];
  assert.deepEqual(planReserve(berry, 2), [{ id: 52, quantity: 2 }]);
  assert.equal(planReserve(berry, 9998), null);
});
