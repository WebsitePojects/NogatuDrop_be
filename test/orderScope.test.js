const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/controllers/orderController');

test('order scope allows super admin full access', () => {
  assert.deepEqual(
    __testables.buildOrderScope({ role_slug: 'super_admin', id: 1, partner_id: null }),
    { clause: '', params: [] }
  );
});

test('order scope limits mobile stockist to their own orders', () => {
  assert.deepEqual(
    __testables.buildOrderScope({ role_slug: 'mobile_stockist', id: 44, partner_id: 9 }),
    { clause: ' AND o.placed_by = ?', params: [44] }
  );
});

test('order scope limits city stockist to partner orders', () => {
  assert.deepEqual(
    __testables.buildOrderScope({ role_slug: 'city_stockist', id: 12, partner_id: 7 }),
    { clause: ' AND o.partner_id = ?', params: [7] }
  );
});

test('order scope supports non-aliased direct orders queries', () => {
  assert.deepEqual(
    __testables.buildOrderScope({ role_slug: 'mobile_stockist', id: 44, partner_id: 9 }, { orderAlias: '' }),
    { clause: ' AND placed_by = ?', params: [44] }
  );
});

test('order payment method defaults to bank transfer', () => {
  assert.equal(__testables.normalizeOrderPaymentMethod(), 'bank_transfer');
  assert.equal(__testables.normalizeOrderPaymentMethod('bank_transfer'), 'bank_transfer');
});

test('order payment method rejects cash on delivery', () => {
  assert.throws(
    () => __testables.normalizeOrderPaymentMethod('cod'),
    /Bank transfer is the only supported payment method/
  );
});
