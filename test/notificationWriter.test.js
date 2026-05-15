const test = require('node:test');
const assert = require('node:assert/strict');

const {
  insertNotification,
  normalizeNotificationTypeForLegacySchema,
} = require('../src/utils/notificationWriter');

test('notification writer keeps the requested type when schema supports it', async () => {
  const calls = [];
  const db = {
    async execute(sql, params) {
      calls.push({ sql, params });
      return [{ insertId: 101 }];
    },
  };

  const result = await insertNotification(db, {
    userId: 7,
    type: 'payment_proof_uploaded',
    title: 'Payment proof uploaded',
    message: 'Order ORD-001 has a new payment proof.',
    entityType: 'order',
    entityId: 1,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[1], 'payment_proof_uploaded');
  assert.equal(result.storedType, 'payment_proof_uploaded');
  assert.equal(result.fallbackApplied, false);
});

test('notification writer falls back to a legacy-safe type when enum is outdated', async () => {
  const calls = [];
  let attempt = 0;
  const db = {
    async execute(sql, params) {
      calls.push({ sql, params });
      attempt += 1;
      if (attempt === 1) {
        const err = new Error("Data truncated for column 'type' at row 1");
        err.code = 'WARN_DATA_TRUNCATED';
        throw err;
      }
      return [{ insertId: 102 }];
    },
  };

  const result = await insertNotification(db, {
    userId: 8,
    type: 'payment_proof_uploaded',
    title: 'Payment proof uploaded',
    message: 'Order ORD-002 has a new payment proof.',
    entityType: 'order',
    entityId: 2,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].params[1], 'payment_proof_uploaded');
  assert.equal(calls[1].params[1], 'order_paid');
  assert.equal(result.storedType, 'order_paid');
  assert.equal(result.fallbackApplied, true);
});

test('unknown modern notification types fall back to system for legacy schemas', () => {
  assert.equal(normalizeNotificationTypeForLegacySchema('some_future_type'), 'system');
});
