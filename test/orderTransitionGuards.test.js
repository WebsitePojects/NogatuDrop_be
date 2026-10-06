const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Approve and reject move an order out of 'pending' exactly once: a double click or two people acting
// together must not notify twice or release reserved stock twice.
test('approve and reject only change a pending order, and stop when another request got there first', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/orderController.js'), 'utf8');
  for (const [name, next] of [['const approveOrder', 'approved'], ['const rejectOrder', 'rejected']]) {
    const start = source.indexOf(name);
    const block = source.slice(start, source.indexOf('\n});\n', start));
    assert.match(block, new RegExp(`SET status = '${next}'[\\s\\S]*?WHERE id = \\? AND status = 'pending' AND is_deleted = 0`), `${name} UPDATE is conditional`);
    assert.match(block, /affectedRows !== 1\) \{\s*throw ApiError\.conflict/, `${name} answers 409 to the loser`);
  }
});

// The center rule reads placed_by_type; a query that forgets it silently locks center staff out.
test('every order lookup that checks approve, verify or delivery-link scope reads placed_by_type', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../src/controllers', file), 'utf8');
  const blocks = [
    ...['const approveOrder', 'const rejectOrder', 'const verifyPayment'].map((name) => [read('orderController.js'), name]),
    ...['const generateDeliveryLink', 'const getLatestDeliveryLinkForOrder'].map((name) => [read('deliveryTokenController.js'), name]),
  ];
  for (const [source, name] of blocks) {
    const start = source.indexOf(name);
    assert.ok(start >= 0, `${name} exists`);
    const block = source.slice(start, source.indexOf('\n});\n', start));
    assert.ok(block.includes('o.placed_by_type'), `${name} selects o.placed_by_type`);
  }
});
