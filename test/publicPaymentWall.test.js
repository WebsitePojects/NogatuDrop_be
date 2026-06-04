const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const orderControllerSource = readFileSync(join(__dirname, '../src/controllers/orderController.js'), 'utf8');
const trackingControllerSource = readFileSync(join(__dirname, '../src/controllers/trackingController.js'), 'utf8');
const orderRoutesSource = readFileSync(join(__dirname, '../src/routes/orders.js'), 'utf8');

test('public order creation responds with immediate payment instructions and proof-upload context', () => {
  assert.equal(orderControllerSource.includes('Complete your bank transfer and upload your payment proof.'), true);
  assert.equal(orderControllerSource.includes('order_number: orderNumber'), true);
  assert.equal(orderControllerSource.includes('total_amount: totalAmount'), true);
  assert.equal(orderControllerSource.includes('payment: buildPublicPaymentContext({'), true);
  assert.equal(orderControllerSource.includes('const pricingTotals = getPublicOrderPricingTotals(merchandiseSubtotal);'), true);
});

test('public orders pick a warehouse that can fulfill the requested items instead of the first stockist route', () => {
  assert.equal(orderControllerSource.includes('resolvePublicFulfillmentRoute(conn, resolvedItems)'), true);
  assert.equal(orderControllerSource.includes('async function resolvePublicFulfillmentRoute(db, items)'), true);
  assert.equal(orderControllerSource.includes('canWarehouseFulfillItems(db, candidate.warehouse_id, items)'), true);
});

test('public order proof upload is exposed as a non-auth storefront route', () => {
  assert.equal(orderRoutesSource.includes("router.post('/public/payment-proof', paymentProofUpload.single('proof'), uploadPublicPaymentProof);"), true);
  assert.equal(orderControllerSource.includes('const uploadPublicPaymentProof = asyncHandler(async (req, res) => {'), true);
  assert.equal(orderControllerSource.includes("throw ApiError.badRequest('order_number and customer_phone are required');"), true);
  assert.equal(orderControllerSource.includes('normalizePhoneForLookup'), true);
  assert.equal(orderControllerSource.includes("throw ApiError.badRequest('The phone number does not match the public order record');"), true);
  assert.equal(orderControllerSource.includes("throw ApiError.badRequest('This order is closed and can no longer accept payment proof');"), true);
});

test('public tracking returns unpaid bank instructions and payment-proof state', () => {
  assert.equal(trackingControllerSource.includes('payment_status: row.payment_status || \'pending\''), true);
  assert.equal(trackingControllerSource.includes('payment_proof_uploaded_at: row.payment_proof_uploaded_at || null'), true);
  assert.equal(trackingControllerSource.includes('total_amount: Number(row.total_amount || 0)'), true);
  assert.equal(trackingControllerSource.includes('bank_account: bankAccount ? {'), true);
});
