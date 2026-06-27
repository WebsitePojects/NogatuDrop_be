const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  getPaymentVerificationDecision,
} = require('../src/services/paymentVerification');

const source = readFileSync(join(__dirname, '../src/controllers/orderController.js'), 'utf8');
const settlementSource = readFileSync(join(__dirname, '../src/controllers/settlementController.js'), 'utf8');
const settlementMigrationSource = readFileSync(join(__dirname, '../scripts/makeSettlementPartnerNullable.js'), 'utf8');

test('paid payment verification replays are successful no-ops', () => {
  assert.deepEqual(getPaymentVerificationDecision({
    status: 'approved',
    payment_status: 'paid',
    payment_proof_url: 'https://example.test/proof.png',
  }), { alreadyPaid: true });
});

test('unpaid approved order with proof may be verified', () => {
  assert.deepEqual(getPaymentVerificationDecision({
    status: 'approved',
    payment_status: 'unpaid',
    payment_proof_url: 'https://example.test/proof.png',
  }), { alreadyPaid: false });
});

test('verification rejects missing proof and invalid status', () => {
  assert.throws(() => getPaymentVerificationDecision({
    status: 'pending',
    payment_status: 'unpaid',
    payment_proof_url: null,
  }), /approved status/);

  assert.throws(() => getPaymentVerificationDecision({
    status: 'approved',
    payment_status: 'unpaid',
    payment_proof_url: null,
  }), /No payment proof/);
});

test('verification locks the order before changing payment and settlement state', () => {
  assert.match(source, /SELECT[\s\S]+FROM orders o[\s\S]+FOR UPDATE/);
  assert.match(source, /getPaymentVerificationDecision\(orders\[0\]\)/);
});

test('legacy direct public settlements support a null Stockist without disappearing from national review', () => {
  assert.match(settlementMigrationSource, /MODIFY COLUMN partner_id BIGINT UNSIGNED NULL/);
  assert.match(settlementSource, /LEFT JOIN partners p ON p\.id = s\.partner_id/);
});
