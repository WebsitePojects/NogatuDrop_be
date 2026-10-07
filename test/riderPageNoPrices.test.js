const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The Rider Link page is public to whoever holds the link, and every order is paid before it ships,
// so the rider data must not carry prices or the order total (management decision, 2026-10-07).
test('the rider page data carries no prices or order total', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/deliveryTokenController.js'), 'utf8');
  const start = source.indexOf('const getDeliveryInfo');
  assert.ok(start >= 0, 'getDeliveryInfo exists');
  const block = source.slice(start, source.indexOf('\n});\n', start));
  for (const field of ['total_amount', 'unit_price', 'subtotal']) {
    assert.ok(!block.includes(field), `getDeliveryInfo does not read or return ${field}`);
  }
});
