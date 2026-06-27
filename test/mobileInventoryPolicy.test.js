const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  resolveMobileInventoryScope,
  calculateMobileInventoryAdjustment,
} = require('../src/rbac/mobileInventoryScopes');
const controllerSource = readFileSync(join(__dirname, '../src/controllers/mobileInventoryController.js'), 'utf8');

test('Mobile Stockist reads and adjusts only the profile linked to its JWT user', () => {
  assert.deepEqual(resolveMobileInventoryScope({
    role: 'mobile_stockist', userId: 44, partnerId: 4,
  }), {
    clause: ' AND ms.user_id = ?', params: [44], canAdjust: true,
  });
});

test('City Stockist and its staff can read affiliated Mobile inventory without adjustment authority', () => {
  for (const role of ['city_stockist', 'staff']) {
    assert.deepEqual(resolveMobileInventoryScope({
      role, userId: 10, partnerId: 4, partnerLevel: 'city_stockist',
    }), {
      clause: ' AND ms.partner_id = ?', params: [4], canAdjust: false,
    });
  }
});

test('Provincial scope cannot reach Mobile grandchildren', () => {
  assert.deepEqual(resolveMobileInventoryScope({
    role: 'provincial_stockist', partnerId: 2, partnerLevel: 'provincial_stockist',
  }), { clause: ' AND 1 = 0', params: [], canAdjust: false });
});

test('manual increase and decrease return audited before and after values', () => {
  assert.deepEqual(calculateMobileInventoryAdjustment(10, 'increase', 3), {
    beforeStock: 10, afterStock: 13, movementType: 'manual_increase', quantity: 3,
  });
  assert.deepEqual(calculateMobileInventoryAdjustment(10, 'decrease', 3), {
    beforeStock: 10, afterStock: 7, movementType: 'manual_decrease', quantity: 3,
  });
});

test('manual inventory rejects zero, fractional, and negative-result changes', () => {
  assert.throws(() => calculateMobileInventoryAdjustment(2, 'decrease', 3), /cannot go below zero/i);
  assert.throws(() => calculateMobileInventoryAdjustment(2, 'increase', 0), /positive integer/i);
  assert.throws(() => calculateMobileInventoryAdjustment(2, 'increase', 1.5), /positive integer/i);
});

test('manual adjustment locks its personal row and writes an immutable movement in one transaction', () => {
  assert.match(controllerSource, /beginTransaction\(\)/);
  assert.match(controllerSource, /FROM mobile_inventories[\s\S]+FOR UPDATE/);
  assert.match(controllerSource, /INSERT INTO mobile_inventory_movements/);
  assert.match(controllerSource, /commit\(\)/);
});
