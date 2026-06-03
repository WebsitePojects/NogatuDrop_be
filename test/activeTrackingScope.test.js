const test = require('node:test');
const assert = require('node:assert/strict');

const { buildActiveTrackingScope } = require('../src/rbac/trackingScopes');

test('active tracking scope leaves super admin queries unrestricted', () => {
  const scope = buildActiveTrackingScope({
    affiliationContext: {
      role: 'super_admin',
      userId: 1,
      partnerId: null,
      partnerLevel: null,
      childCityPartnerIds: [],
    },
    orderAlias: 'o',
  });

  assert.equal(scope.clause, '');
  assert.deepEqual(scope.params, []);
});

test('active tracking scope lets provincial stockists see own plus direct city-child orders', () => {
  const scope = buildActiveTrackingScope({
    affiliationContext: {
      role: 'provincial_stockist',
      userId: 7,
      partnerId: 42,
      partnerLevel: 'provincial_stockist',
      childCityPartnerIds: [77],
    },
    orderAlias: 'ord',
  });

  assert.equal(
    scope.clause.replace(/\s+/g, ' ').trim(),
    "AND ( ord.partner_id = ? OR ( ord.partner_id IN (?) AND ( SELECT r.slug FROM users placed_by_user JOIN roles r ON r.id = placed_by_user.role_id WHERE placed_by_user.id = ord.placed_by LIMIT 1 ) = ? ) )"
  );
  assert.deepEqual(scope.params, [42, 77, 'city_stockist']);
});

test('active tracking scope restricts mobile stockists to their own orders', () => {
  const scope = buildActiveTrackingScope({
    affiliationContext: {
      role: 'mobile_stockist',
      userId: 88,
      partnerId: 77,
      partnerLevel: 'city_stockist',
      childCityPartnerIds: [],
    },
    orderAlias: 'o',
  });

  assert.equal(scope.clause, ' AND o.placed_by = ?');
  assert.deepEqual(scope.params, [88]);
});

test('active tracking scope blocks scoped roles that have no partner context', () => {
  const scope = buildActiveTrackingScope({
    affiliationContext: {
      role: 'staff',
      userId: 18,
      partnerId: null,
      partnerLevel: null,
      childCityPartnerIds: [],
    },
    orderAlias: 'o',
  });

  assert.equal(scope.clause, ' AND 1 = 0');
  assert.deepEqual(scope.params, []);
});
