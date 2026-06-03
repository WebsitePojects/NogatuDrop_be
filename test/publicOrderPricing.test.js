const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/controllers/orderController');

test('public order pricing uses retail price before partner price', () => {
  assert.equal(
    __testables.getPublicOrderUnitPrice({ retail_price: 70, partner_price: 45 }),
    70,
  );
});

test('public order pricing falls back to partner price only when retail price is unavailable', () => {
  assert.equal(
    __testables.getPublicOrderUnitPrice({ retail_price: null, partner_price: 45 }),
    45,
  );
});
