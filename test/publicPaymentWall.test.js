const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const orderControllerSource = readFileSync(join(__dirname, '../src/controllers/orderController.js'), 'utf8');
const trackingControllerSource = readFileSync(join(__dirname, '../src/controllers/trackingController.js'), 'utf8');
const orderRoutesSource = readFileSync(join(__dirname, '../src/routes/orders.js'), 'utf8');
const { __testables } = require('../src/controllers/orderController');
const {
  getPublicOrderPricingTotals,
  reconcilePublicOrderPricing,
} = require('../src/services/publicCheckoutPricing');

test('public order creation responds with immediate payment instructions and proof-upload context', () => {
  assert.equal(orderControllerSource.includes('Complete your bank transfer and upload your payment proof.'), true);
  assert.equal(orderControllerSource.includes('order_number: orderNumber'), true);
  assert.equal(orderControllerSource.includes('total_amount: totalAmount'), true);
  assert.equal(orderControllerSource.includes('payment: buildPublicPaymentContext({'), true);
  assert.equal(orderControllerSource.includes('const pricingTotals = getPublicOrderPricingTotals(merchandiseSubtotal, { preDiscountSubtotal });'), true);
});

test('public orders pick a warehouse that can fulfill the requested items instead of the first stockist route', () => {
  assert.equal(orderControllerSource.includes('resolvePublicFulfillmentRoute(conn, resolvedItems, {'), true);
  assert.equal(orderControllerSource.includes('async function resolvePublicFulfillmentRoute(db, items, location'), true);
  assert.equal(orderControllerSource.includes('canWarehouseFulfillItems(db, candidate.warehouse_id, items)'), true);
});

test('public fulfillment ranks capable warehouses by distance from the customer', () => {
  const ranked = __testables.rankPublicFulfillmentCandidates([
    { warehouse_id: 10, partner_id: 1, lat: 14.5995, lng: 120.9842 },
    { warehouse_id: 20, partner_id: 2, lat: 14.676, lng: 121.0437 },
    { warehouse_id: 30, partner_id: 3, lat: null, lng: null },
  ], { customerLat: 14.657, customerLng: 121.029 });

  assert.deepEqual(ranked.map((candidate) => candidate.warehouse_id), [20, 10, 30]);
});

test('public pricing persists discount and fee components that reconcile to total', () => {
  const totals = getPublicOrderPricingTotals(700, { preDiscountSubtotal: 1000 });

  assert.deepEqual(totals, {
    merchandiseSubtotal: 700,
    memberDiscountAmount: 300,
    shippingFee: 159,
    systemFee: 84,
    totalDue: 943,
  });
});

test('historical public pricing exposes an explicit adjustment when components do not match stored total', () => {
  assert.deepEqual(reconcilePublicOrderPricing({
    merchandiseSubtotal: 500,
    shippingFee: 159,
    systemFee: 60,
    totalAmount: 725,
  }), {
    merchandiseSubtotal: 500,
    memberDiscountAmount: 0,
    shippingFee: 159,
    systemFee: 60,
    adjustmentAmount: 6,
    totalDue: 725,
  });
});

test('order detail pricing breakdown uses persisted public fee components', () => {
  assert.deepEqual(__testables.buildOrderPricingBreakdown({
    placed_by_type: 'public',
    total_amount: 943,
    merchandise_subtotal: 700,
    member_discount_amount: 300,
    shipping_fee: 159,
    system_fee: 84,
  }, [
    { quantity: 1, unit_price: 700 },
  ]), {
    merchandise_subtotal: 700,
    member_discount_amount: 300,
    shipping_fee: 159,
    system_fee: 84,
    adjustment_amount: 0,
    total_amount: 943,
  });
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
  assert.equal(trackingControllerSource.includes('pricing_breakdown: buildTrackingPricingBreakdown(row)'), true);
  assert.equal(trackingControllerSource.includes('bank_account: bankAccount ? {'), true);
});
