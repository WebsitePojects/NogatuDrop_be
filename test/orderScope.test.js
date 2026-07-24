const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/controllers/orderController');

test('order scope allows super admin full access', () => {
  assert.deepEqual(
    __testables.buildOrderScope(
      { role_slug: 'super_admin', id: 1, partner_id: null },
      {
        affiliationContext: {
          role: 'super_admin',
          userId: 1,
          partnerId: null,
          partnerLevel: null,
          childCityPartnerIds: [],
        },
      }
    ),
    { clause: '', params: [] }
  );
});

test('order scope limits mobile stockist to their own orders', () => {
  assert.deepEqual(
    __testables.buildOrderScope(
      { role_slug: 'mobile_stockist', id: 44, partner_id: 9 },
      {
        affiliationContext: {
          role: 'mobile_stockist',
          userId: 44,
          partnerId: 9,
          partnerLevel: 'city_stockist',
          childCityPartnerIds: [],
        },
      }
    ),
    { clause: ' AND o.placed_by = ?', params: [44] }
  );
});

test('order scope limits city stockist to partner orders', () => {
  assert.deepEqual(
    __testables.buildOrderScope(
      { role_slug: 'city_stockist', id: 12, partner_id: 7 },
      {
        affiliationContext: {
          role: 'city_stockist',
          userId: 12,
          partnerId: 7,
          partnerLevel: 'city_stockist',
          childCityPartnerIds: [],
        },
      }
    ),
    { clause: ' AND o.partner_id = ?', params: [7] }
  );
});

test('order scope supports non-aliased direct orders queries', () => {
  assert.deepEqual(
    __testables.buildOrderScope(
      { role_slug: 'mobile_stockist', id: 44, partner_id: 9 },
      {
        orderAlias: '',
        affiliationContext: {
          role: 'mobile_stockist',
          userId: 44,
          partnerId: 9,
          partnerLevel: 'city_stockist',
          childCityPartnerIds: [],
        },
      }
    ),
    { clause: ' AND placed_by = ?', params: [44] }
  );
});

test('order scope lets provincial stockists see own orders plus direct city-child orders only', () => {
  const scope = __testables.buildOrderScope(
    { role_slug: 'provincial_stockist', id: 8, partner_id: 2 },
    {
      affiliationContext: {
        role: 'provincial_stockist',
        userId: 8,
        partnerId: 2,
        partnerLevel: 'provincial_stockist',
        childCityPartnerIds: [4, 6],
      },
    }
  );

  assert.equal(
    scope.clause.replace(/\s+/g, ' ').trim(),
    "AND ( o.partner_id = ? OR ( o.partner_id IN (?, ?) AND ( SELECT r.slug FROM users placed_by_user JOIN roles r ON r.id = placed_by_user.role_id WHERE placed_by_user.id = o.placed_by LIMIT 1 ) IN (?, ?) ) )"
  );
  assert.deepEqual(scope.params, [2, 4, 6, 'city_stockist', 'staff']);
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
