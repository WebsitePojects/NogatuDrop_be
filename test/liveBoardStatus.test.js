const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The live board lists riders on the road. A tracking row can still say "out_for_delivery" after its
// order ended (delivered, cancelled, rejected); the order status must win, or a finished order keeps
// showing a rider on the map.
test('the live delivery board leaves out orders that are delivered, cancelled or rejected', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/trackingController.js'), 'utf8');
  const start = source.indexOf('const getActive');
  assert.ok(start >= 0, 'the live board handler exists');
  const block = source.slice(start, source.indexOf('\n});\n', start));
  assert.match(block, /AND o\.status NOT IN \('delivered', 'cancelled', 'rejected'\)/);
});
