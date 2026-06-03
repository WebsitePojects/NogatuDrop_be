const test = require('node:test');
const assert = require('node:assert/strict');

const { __testables } = require('../src/controllers/productController');

test('availability scoping applies only to ordering stockist roles', () => {
  assert.equal(__testables.isAvailabilityScopedUser({ role_slug: 'provincial_stockist', partner_id: 2 }), true);
  assert.equal(__testables.isAvailabilityScopedUser({ role_slug: 'city_stockist', partner_id: 4 }), true);
  assert.equal(__testables.isAvailabilityScopedUser({ role_slug: 'mobile_stockist', partner_id: 4 }), true);
  assert.equal(__testables.isAvailabilityScopedUser({ role_slug: 'staff', partner_id: 2 }), false);
  assert.equal(__testables.isAvailabilityScopedUser({ role_slug: 'super_admin', partner_id: null }), false);
});

test('product availability annotation marks source warehouse stock correctly', () => {
  const annotated = __testables.annotateProductsWithAvailability(
    [
      { id: 5, name: 'Nogatu Coffee Mix' },
      { id: 2, name: 'Chocolate Drink Mix' },
    ],
    new Map([
      [5, 2000],
      [2, 0],
    ]),
    4
  );

  assert.deepEqual(
    annotated,
    [
      {
        id: 5,
        name: 'Nogatu Coffee Mix',
        source_warehouse_id: 4,
        available_qty: 2000,
        is_orderable: true,
      },
      {
        id: 2,
        name: 'Chocolate Drink Mix',
        source_warehouse_id: 4,
        available_qty: 0,
        is_orderable: false,
      },
    ]
  );
});
