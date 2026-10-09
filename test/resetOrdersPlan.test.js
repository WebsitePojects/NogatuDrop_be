const test = require('node:test');
const assert = require('node:assert/strict');
const { planShippedStockReturn, planReservationRelease } = require('../scripts/resetOrders');

test('shipped stock returns per inventory row, summing several deliveries', () => {
  const plan = planShippedStockReturn([
    { id: 1, inventory_id: 52, product_id: 16, warehouse_id: 16, quantity: 1, reference_id: 86 },
    { id: 2, inventory_id: 52, product_id: 16, warehouse_id: 16, quantity: '3', reference_id: 90 },
    { id: 3, inventory_id: 61, product_id: 17, warehouse_id: 16, quantity: 2, reference_id: 90 },
  ]);
  assert.deepEqual(plan, [
    { inventory_id: 52, product_id: 16, warehouse_id: 16, quantity: 4 },
    { inventory_id: 61, product_id: 17, warehouse_id: 16, quantity: 2 },
  ]);
});

test('a stock-out with no inventory row stops the reset instead of losing units', () => {
  assert.throws(
    () => planShippedStockReturn([{ id: 9, inventory_id: null, product_id: 16, warehouse_id: 16, quantity: 1, reference_id: 86 }]),
    /movement #9 \(order #86\) has no inventory row/
  );
});

test('nothing delivered means nothing to return', () => {
  assert.deepEqual(planShippedStockReturn([]), []);
});

test('only open orders release reservations; delivered and cancelled ones do not', () => {
  const orders = [
    { id: 1, status: 'pending', source_warehouse_id: 16 },
    { id: 2, status: 'delivered', source_warehouse_id: 16 },
    { id: 3, status: 'cancelled', source_warehouse_id: 16 },
    { id: 4, status: 'delivering', source_warehouse_id: 16 },
  ];
  const items = [1, 2, 3, 4].map((orderId) => ({ order_id: orderId, product_id: 16, quantity: 2, source_warehouse_id: null }));
  const [release] = planReservationRelease(orders, items);
  assert.equal(release.quantity, 4);
  assert.deepEqual([...release.orderIds], [1, 4]);
});
