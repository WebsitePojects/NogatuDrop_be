const test = require('node:test');
const assert = require('node:assert/strict');

const generateOrderNum = require('../src/utils/generateOrderNum');

test('generateOrderNum creates time-based identifiers with the requested prefix', async () => {
  const value = await generateOrderNum('ORD', 'orders', 'order_number');
  assert.match(value, /^ORD-\d{20}$/);
});

test('generateOrderNum avoids collisions across nearby calls', async () => {
  const values = await Promise.all(
    Array.from({ length: 20 }, () => generateOrderNum('PUB', 'orders', 'order_number'))
  );
  assert.equal(new Set(values).size, values.length);
});
