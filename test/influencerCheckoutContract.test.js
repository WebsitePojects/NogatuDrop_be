const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { selectPublicPaymentAccount } = require('../src/services/bankAccountResolver');

const ordersSource = fs.readFileSync(path.join(__dirname, '../src/routes/orders.js'), 'utf8');
const influencerSource = fs.readFileSync(path.join(__dirname, '../src/controllers/influencerController.js'), 'utf8');
const reportSource = fs.readFileSync(path.join(__dirname, '../src/controllers/reportController.js'), 'utf8');
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

test('influencer migration uses the storefront Berry NAD SKU', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../sql/influencer_checkout_2026_09_10.sql'), 'utf8');
  assert.match(migration, /VALUES \('kawoodee', 1, 'NKT-BND-001'\)/);
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

test('influencer report is explicitly super-admin-only and aggregate-only', () => {
  assert.match(reportSource, /Only super admins can view influencer reports/);
  assert.match(reportSource, /delivered_revenue/);
  assert.doesNotMatch(reportSource, /customer_phone|customer_email|customer_address/);
});
