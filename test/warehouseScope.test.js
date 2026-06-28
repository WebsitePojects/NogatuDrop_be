const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWarehouseListScope,
  canManageWarehouse,
} = require('../src/rbac/warehouseScopes');

test('super admin owned scope contains only main manufacturer warehouses', () => {
  assert.deepEqual(buildWarehouseListScope({ role: 'super_admin' }, { view: 'owned' }), {
    kind: 'warehouses',
    clause: " AND w.partner_id IS NULL AND w.type = 'manufacturer'",
    params: [],
  });
});

test('super admin network scope contains provincial Stockist warehouses', () => {
  const scope = buildWarehouseListScope({ role: 'super_admin' }, { view: 'network' });
  assert.equal(scope.kind, 'warehouses');
  assert.match(scope.clause, /stockist_level = 'provincial_stockist'/);
  assert.deepEqual(scope.params, []);
});

test('provincial owned and network scopes stay on self and direct City children', () => {
  const context = {
    role: 'provincial_stockist',
    partnerId: 2,
    partnerLevel: 'provincial_stockist',
    childCityPartnerIds: [4, 6],
  };
  assert.deepEqual(buildWarehouseListScope(context, { view: 'owned' }), {
    kind: 'warehouses', clause: ' AND w.partner_id = ?', params: [2],
  });
  assert.deepEqual(buildWarehouseListScope(context, { view: 'network' }), {
    kind: 'warehouses', clause: ' AND w.partner_id IN (?, ?)', params: [4, 6],
  });
});

test('city network scope resolves affiliated Mobile Stockist locations', () => {
  assert.deepEqual(buildWarehouseListScope({
    role: 'city_stockist', partnerId: 4, partnerLevel: 'city_stockist',
  }, { view: 'network' }), {
    kind: 'mobile_stockists', clause: ' AND ms.partner_id = ?', params: [4],
  });
});

test('staff may manage only the employer warehouse and never an affiliated warehouse', () => {
  const context = { role: 'staff', partnerId: 4, partnerLevel: 'city_stockist' };
  assert.equal(canManageWarehouse(context, { partner_id: 4 }), true);
  assert.equal(canManageWarehouse(context, { partner_id: 2 }), false);
});

test('missing partner context fails closed', () => {
  assert.deepEqual(buildWarehouseListScope({ role: 'staff' }, { view: 'owned' }), {
    kind: 'warehouses', clause: ' AND 1 = 0', params: [],
  });
});
