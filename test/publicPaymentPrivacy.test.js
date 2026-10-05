const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { maskPersonName, toBuyerFacingAccount, resolveOrderPaymentAccount } = require('../src/services/bankAccountResolver');
const { phoneKey, phonesMatch } = require('../src/utils/phoneMatch');
const { publicPaymentDeadline, PUBLIC_ORDER_PAYMENT_WINDOW_HOURS } = require('../src/services/publicOrderPayment');
const { planReservationRelease, reservedDeltas } = require('../scripts/resetOrders');

test('e-wallet holder names are masked the way management asked ("HA***D T.")', () => {
  assert.equal(maskPersonName('HAROLD TUGANO'), 'HA***D T.');
  assert.equal(maskPersonName('  maria  clara  santos '), 'ma***a s.');
  assert.equal(maskPersonName('ANA'), 'A***');
  assert.equal(maskPersonName('HAROLD'), 'HA***D');
  assert.equal(maskPersonName(''), '');
});

test('buyers see GCash names masked, company bank account names in full, numbers always in full', () => {
  assert.deepEqual(toBuyerFacingAccount({ id: 1, bank_name: 'GCASH', account_name: 'HAROLD TUGANO', account_number: '09276121426' }),
    { bank_name: 'GCASH', account_name: 'HA***D T.', account_number: '09276121426' });
  assert.deepEqual(toBuyerFacingAccount({ bank_name: 'BDO', account_name: 'NOGATU ALLIANCE CO. OPC', account_number: '006548023110' }),
    { bank_name: 'BDO', account_name: 'NOGATU ALLIANCE CO. OPC', account_number: '006548023110' });
  assert.equal(toBuyerFacingAccount(null), null);
});

test('staff see the account the buyer chose, not the center default (BDO order showed GCASH)', async () => {
  const calls = [];
  const db = {
    async execute(sql, params) {
      calls.push(params);
      if (sql.includes('WHERE id = ?')) return [[{ id: 7, warehouse_id: 19, bank_name: 'BDO', account_name: 'NOGATU', account_number: '123' }]];
      return [[{ id: 3, warehouse_id: 19, bank_name: 'GCASH', account_name: 'X', account_number: '0917' }]];
    },
  };
  const chosen = await resolveOrderPaymentAccount(db, { paymentAccountId: 7, sourceWarehouseId: 19 });
  assert.equal(chosen.bank_name, 'BDO');
  assert.deepEqual(calls[0], [7]);
  const fallback = await resolveOrderPaymentAccount(db, { paymentAccountId: null, sourceWarehouseId: 19 });
  assert.equal(fallback.bank_name, 'GCASH', 'orders without a chosen account fall back to the warehouse account');
});

test('a phone matches in any common Philippine format, and only the same number matches', () => {
  assert.equal(phoneKey('0917 123 4567'), '9171234567');
  assert.equal(phoneKey('+63 917-123-4567'), '9171234567');
  assert.ok(phonesMatch('09171234567', '+639171234567'));
  assert.ok(!phonesMatch('09171234568', '09171234567'));
  assert.ok(!phonesMatch('', '09171234567'), 'blank never matches');
  assert.ok(!phonesMatch('12345', '12345'), 'too short to be a mobile number never matches');
});

test('public buyers get 3 days to pay', () => {
  assert.equal(PUBLIC_ORDER_PAYMENT_WINDOW_HOURS, 72);
  const now = new Date('2026-10-05T10:00:00Z');
  assert.equal(publicPaymentDeadline(now).toISOString(), '2026-10-08T10:00:00.000Z');
});

test('the deadline cron never cancels an order whose receipt was uploaded, and re-checks before cancelling', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/paymentDeadlineCron.js'), 'utf8');
  assert.match(source, /o\.payment_proof_url IS NULL/);
  assert.match(source, /o\.status IN \('pending', 'approved'\)/, 'unpaid public orders are cancelled even before approval');
  assert.match(source, /WHERE o\.id = \? AND \$\{UNPAID_PAST_DEADLINE_SQL\}/, 'the UPDATE repeats the conditions');
  assert.match(source, /affectedRows !== 1/);
});

test('the public tracking page carries no money; payment details need the phone', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/trackingController.js'), 'utf8');
  const publicBlock = source.slice(source.indexOf('const getPublicTracking'), source.indexOf('function isPaymentDue'));
  assert.doesNotMatch(publicBlock, /total_amount|pricing_breakdown|bank_account|account_number/);
  const detailsBlock = source.slice(source.indexOf('const getPublicPaymentDetails'));
  assert.match(detailsBlock, /phonesMatch\(req\.body\.customer_phone, row\.customer_phone\)/);
  assert.match(detailsBlock, /toBuyerFacingAccount\(bankAccount\)/);
});

test('the orders reset releases reservations only for orders that still hold them', () => {
  const orders = [
    { id: 1, status: 'pending', source_warehouse_id: 19 },
    { id: 2, status: 'approved', source_warehouse_id: 16 },
    { id: 3, status: 'delivering', source_warehouse_id: 16 },
    { id: 4, status: 'delivered', source_warehouse_id: 16 },
    { id: 5, status: 'cancelled', source_warehouse_id: 16 },
    { id: 6, status: 'rejected', source_warehouse_id: 16 },
  ];
  const items = orders.map((o) => ({ order_id: o.id, product_id: 16, quantity: 2, source_warehouse_id: null }));
  const plan = planReservationRelease(orders, items).map(({ warehouseId, productId, quantity }) => ({ warehouseId, productId, quantity }));
  assert.deepEqual(plan, [
    { warehouseId: 19, productId: 16, quantity: 2 },
    { warehouseId: 16, productId: 16, quantity: 4 },
  ]);
});

test('the reset journal records exactly how much each inventory row released, so rollback can put it back', () => {
  assert.deepEqual(reservedDeltas({ 10: 5, 11: 3, 12: 0 }, { 10: 1, 11: 3, 12: 0 }), [{ inventory_id: 10, released: 4 }]);
  assert.deepEqual(reservedDeltas({}, {}), []);
});
