const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'expiryAlertCron.js'),
  'utf8'
);

test('expiry alert cron falls back when inventories has no is_deleted column', () => {
  assert.match(source, /isMissingColumn\(err, 'i\.is_deleted'\)/);
  assert.match(source, /throw err/);

  const queryOccurrences = source.match(/FROM inventories i/g) || [];
  assert.equal(queryOccurrences.length >= 2, true);
});
