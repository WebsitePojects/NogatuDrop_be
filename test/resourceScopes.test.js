const test = require('node:test');
const assert = require('node:assert/strict');

const { appendPartnerScope } = require('../src/rbac/resourceScopes');

test('resource scope leaves national super admin queries unchanged', () => {
  const params = [];
  const where = appendPartnerScope({
    where: 'WHERE w.is_deleted = 0',
    params,
    user: { role_slug: 'super_admin', partner_id: null },
    expression: 'w.partner_id',
  });

  assert.equal(where, 'WHERE w.is_deleted = 0');
  assert.deepEqual(params, []);
});

test('resource scope adds partner filter for stockist and staff users', () => {
  const params = [];
  const where = appendPartnerScope({
    where: 'WHERE i.is_active = 1',
    params,
    user: { role_slug: 'staff', partner_id: 42 },
    expression: 'COALESCE(i.partner_id, w.partner_id)',
  });

  assert.equal(where, 'WHERE i.is_active = 1 AND COALESCE(i.partner_id, w.partner_id) = ?');
  assert.deepEqual(params, [42]);
});

test('resource scope supports custom ownership conditions', () => {
  const params = [];
  const where = appendPartnerScope({
    where: 'WHERE w.is_deleted = 0',
    params,
    user: { role_slug: 'provincial_stockist', partner_id: 7 },
    condition: 'EXISTS (SELECT 1 FROM inventories i WHERE i.warehouse_id = w.id AND i.partner_id = ?)',
  });

  assert.equal(
    where,
    'WHERE w.is_deleted = 0 AND EXISTS (SELECT 1 FROM inventories i WHERE i.warehouse_id = w.id AND i.partner_id = ?)'
  );
  assert.deepEqual(params, [7]);
});

test('resource scope prevents scoped users without partner from seeing tenant data', () => {
  const params = [];
  const where = appendPartnerScope({
    where: 'WHERE w.is_deleted = 0',
    params,
    user: { role_slug: 'city_stockist', partner_id: null },
    expression: 'w.partner_id',
  });

  assert.equal(where, 'WHERE w.is_deleted = 0 AND 1 = 0');
  assert.deepEqual(params, []);
});
