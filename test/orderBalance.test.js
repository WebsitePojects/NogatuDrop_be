const test = require('node:test');
const assert = require('node:assert/strict');
const { totalWithShippingFee, amountStillOwed, amountOverpaid } = require('../src/services/orderBalance');

// The example order from management's screenshot: 1 Berry NAD+ (₱7,998) + ₱159 delivery + 12% VAT on goods.
const order = { total_amount: '9116.76', shipping_fee: '159.00' };

test('changing the delivery fee moves the total by the difference only (VAT is on goods)', () => {
  assert.equal(totalWithShippingFee(order, 459), 9416.76);
  assert.equal(totalWithShippingFee(order, 0), 8957.76);
  assert.equal(totalWithShippingFee({ total_amount: '0.30', shipping_fee: '0.10' }, 0.2), 0.4, 'no floating-point drift');
});

test('money still owed and overpaid are measured against what the receipts covered', () => {
  assert.equal(amountStillOwed({ total_amount: '9416.76', payment_covered_total: '9116.76' }), 300);
  assert.equal(amountOverpaid({ total_amount: '9416.76', payment_covered_total: '9116.76' }), 0);
  assert.equal(amountOverpaid({ total_amount: '8957.76', payment_covered_total: '9116.76' }), 159);
  assert.equal(amountStillOwed({ total_amount: '8957.76', payment_covered_total: '9116.76' }), 0);
  assert.equal(amountStillOwed({ total_amount: '9116.76', payment_covered_total: null }), 0, 'no receipt yet is not a debt');
});
