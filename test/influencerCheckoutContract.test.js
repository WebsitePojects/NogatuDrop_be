const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { selectPublicPaymentAccount } = require('../src/services/bankAccountResolver');

const ordersSource = fs.readFileSync(path.join(__dirname, '../src/routes/orders.js'), 'utf8');
const influencerSource = fs.readFileSync(path.join(__dirname, '../src/controllers/influencerController.js'), 'utf8');
const orderSource = fs.readFileSync(path.join(__dirname, '../src/controllers/orderController.js'), 'utf8');

test('public and influencer routes require idempotency and enforce boundary fields', () => {
  assert.match(ordersSource, /router\.post\('\/public', publicOrderValidation, createPublicOrder\)/);
  assert.match(ordersSource, /router\.post\('\/public\/influencer\/:slug', publicOrderValidation, prepareInfluencerOrder, createPublicOrder\)/);
  assert.match(ordersSource, /bodyValidator\('items'\)\.isArray/);
  assert.match(orderSource, /getIdempotencyKey\(req\)/);
  assert.match(influencerSource, /member_username[\s\S]*not supported/);
  assert.match(influencerSource, /quantity: 1/);
});

test('influencer identity is configured by canonical SKU and fails closed when unresolved', () => {
  assert.match(influencerSource, /canonical_product_sku/);
  assert.match(influencerSource, /products\.length !== 1/);
  assert.match(influencerSource, /Influencer product configuration is unavailable/);
});

test('influencer checkout permits an omitted member username and rejects a supplied one', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/influencerController.js'), 'utf8');
  assert.match(source, /req\.body\.member_username != null/);
  assert.match(source, /Influencer checkout requires exactly one item/);
});

// Regression: the migration used to INSERT ... ON DUPLICATE KEY UPDATE the kawoodee link with the
// MLM SKU 'NKT-BND-001', which does not exist in NCDMS (Berry NAD+ is NOG-109), so re-running it
// after the seed re-broke checkout. Link data belongs to the seed, which resolves the real SKU.
test('influencer migration is schema-only and never seeds a hard-coded SKU', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../sql/influencer_checkout_2026_09_10.sql'), 'utf8');
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+influencer_links/i);
  assert.doesNotMatch(migration, /NKT-BND-001/);
});

test('payment provider selection cannot cross warehouse scope', () => {
  const accounts = [
    { id: 1, provider: 'BDO', warehouse_id: 10, account_name: 'A', account_number: '1' },
    { id: 2, provider: 'BDO', warehouse_id: null, account_name: 'Default', account_number: '2' },
  ];
  assert.equal(selectPublicPaymentAccount(accounts, 'BDO', 10).id, 1);
  assert.equal(selectPublicPaymentAccount(accounts, 'BDO', 11).id, 2);
  assert.throws(() => selectPublicPaymentAccount([], 'BDO', 10), /No active payment account/);
  assert.throws(() => selectPublicPaymentAccount(accounts, 'MAYA', 10), /Unsupported/);
});
