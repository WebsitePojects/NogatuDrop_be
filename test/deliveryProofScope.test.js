const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/controllers/deliveryTokenController');

test('delivery proof access allows super admin', () => {
  assert.equal(
    __testables.canAccessDeliveryProof(
      { role: 'super_admin', partnerId: null, partnerLevel: null, childCityPartnerIds: [] },
      { partner_id: 9, placed_by: 11, placed_by_role_slug: 'city_stockist' }
    ),
    true
  );
});

test('delivery proof access allows direct provincial child-city delivery proof access', () => {
  assert.equal(
    __testables.canAccessDeliveryProof(
      {
        role: 'provincial_stockist',
        userId: 22,
        partnerId: 2,
        partnerLevel: 'provincial_stockist',
        childCityPartnerIds: [4],
      },
      { partner_id: 4, placed_by: 11, placed_by_role_slug: 'city_stockist' }
    ),
    true
  );
});

test('delivery proof access denies provincial visibility into mobile-child delivery proof', () => {
  assert.equal(
    __testables.canAccessDeliveryProof(
      {
        role: 'provincial_stockist',
        userId: 22,
        partnerId: 2,
        partnerLevel: 'provincial_stockist',
        childCityPartnerIds: [4],
      },
      { partner_id: 4, placed_by: 33, placed_by_role_slug: 'mobile_stockist' }
    ),
    false
  );
});

test('delivery proof access denies unrelated scoped partner', () => {
  assert.equal(
    __testables.canAccessDeliveryProof(
      { role: 'city_stockist', userId: 44, partnerId: 22, partnerLevel: 'city_stockist', childCityPartnerIds: [] },
      { partner_id: 9, placed_by: 11, placed_by_role_slug: 'city_stockist' }
    ),
    false
  );
});

test('delivery proof list scope mirrors city order visibility', () => {
  const scope = __testables.buildDeliveryProofScope(
    { role: 'staff', userId: 51, partnerId: 12, partnerLevel: 'city_stockist', childCityPartnerIds: [] },
    { orderAlias: 'o' }
  );

  assert.equal(scope.clause, ' AND o.partner_id = ?');
  assert.deepEqual(scope.params, [12]);
});
