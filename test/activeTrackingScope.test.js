const test = require('node:test');
const assert = require('node:assert/strict');

const { buildActiveTrackingScope } = require('../src/rbac/trackingScopes');

test('active tracking scope leaves super admin queries unrestricted', () => {
  const scope = buildActiveTrackingScope({
    user: { role_slug: 'super_admin', partner_id: null },
    orderAlias: 'o',
  });

  assert.equal(scope.clause, '');
  assert.deepEqual(scope.params, []);
});

test('active tracking scope filters stockist roles to their partner orders', () => {
  const scope = buildActiveTrackingScope({
    user: { role_slug: 'provincial_stockist', partner_id: 42 },
    orderAlias: 'ord',
  });

  assert.equal(scope.clause, ' AND ord.partner_id = ?');
  assert.deepEqual(scope.params, [42]);
});

test('active tracking scope also restricts mobile stockists to their own partner orders', () => {
  const scope = buildActiveTrackingScope({
    user: { role_slug: 'mobile_stockist', partner_id: 77 },
    orderAlias: 'o',
  });

  assert.equal(scope.clause, ' AND o.partner_id = ?');
  assert.deepEqual(scope.params, [77]);
});

test('active tracking scope blocks scoped roles that have no partner context', () => {
  const scope = buildActiveTrackingScope({
    user: { role_slug: 'staff', partner_id: null },
    orderAlias: 'o',
  });

  assert.equal(scope.clause, ' AND 1 = 0');
  assert.deepEqual(scope.params, []);
});
