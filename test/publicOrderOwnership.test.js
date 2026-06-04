const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const source = readFileSync(join(__dirname, '../src/controllers/orderController.js'), 'utf8');

test('public order flow resolves an internal owner user for placed_by before insert', () => {
  assert.equal(source.includes('const publicPlacedByUserId = await getPublicOrderPlacedByUserId(conn);'), true);
  assert.equal(source.includes("No active super admin is available to own public orders"), true);
});

test('public order inserts now include placed_by alongside placed_by_type', () => {
  assert.match(source, /INSERT INTO orders \(order_number, partner_id, placed_by, placed_by_type,/);
});
