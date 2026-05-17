const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/controllers/deliveryTokenController');

test('delivery proof access allows super admin', () => {
  assert.equal(
    __testables.canAccessDeliveryProof(
      { role_slug: 'super_admin', partner_id: null },
      { partner_id: 9, source_partner_id: 4 }
    ),
    true
  );
});

test('delivery proof access allows destination stockist partner', () => {
  assert.equal(
    __testables.canAccessDeliveryProof(
      { role_slug: 'provincial_stockist', partner_id: 9 },
      { partner_id: 9, source_partner_id: 4 }
    ),
    true
  );
});

test('delivery proof access allows source warehouse partner', () => {
  assert.equal(
    __testables.canAccessDeliveryProof(
      { role_slug: 'provincial_stockist', partner_id: 4 },
      { partner_id: 9, source_partner_id: 4 }
    ),
    true
  );
});

test('delivery proof access denies unrelated scoped partner', () => {
  assert.equal(
    __testables.canAccessDeliveryProof(
      { role_slug: 'city_stockist', partner_id: 22 },
      { partner_id: 9, source_partner_id: 4 }
    ),
    false
  );
});

test('delivery proof list scope includes destination and source partner ownership', () => {
  const scope = __testables.buildDeliveryProofScope(
    { role_slug: 'staff', partner_id: 12 },
    { orderAlias: 'o', sourcePartnerExpression: 'sw.partner_id' }
  );

  assert.equal(scope.clause, ' AND (o.partner_id = ? OR sw.partner_id = ?)');
  assert.deepEqual(scope.params, [12, 12]);
});
