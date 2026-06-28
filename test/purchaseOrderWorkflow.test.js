const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPurchaseOrderCreationState,
  getPurchaseOrderSupplier,
  canSubmitPurchaseOrder,
  canAcceptPurchaseOrder,
  buildPurchaseOrderScope,
} = require('../src/rbac/purchaseOrderScopes');

test('City staff prepares a PO to the direct Provincial parent for owner approval', () => {
  const context = {
    role: 'staff', partnerId: 4, partnerLevel: 'city_stockist', parentPartnerId: 2,
  };
  assert.equal(getPurchaseOrderCreationState(context), 'awaiting_owner_approval');
  assert.deepEqual(getPurchaseOrderSupplier(context), { kind: 'partner', partnerId: 2 });
});

test('City Stockist submits directly only to its configured Provincial parent', () => {
  const context = {
    role: 'city_stockist', partnerId: 4, partnerLevel: 'city_stockist', parentPartnerId: 2,
  };
  assert.equal(getPurchaseOrderCreationState(context), 'submitted');
  assert.deepEqual(getPurchaseOrderSupplier(context), { kind: 'partner', partnerId: 2 });
});

test('Provincial staff prepares for main and Provincial account submits to main', () => {
  const staff = { role: 'staff', partnerId: 2, partnerLevel: 'provincial_stockist' };
  const owner = { role: 'provincial_stockist', partnerId: 2, partnerLevel: 'provincial_stockist' };
  assert.deepEqual(getPurchaseOrderSupplier(staff), { kind: 'manufacturer', partnerId: null });
  assert.equal(getPurchaseOrderCreationState(staff), 'awaiting_owner_approval');
  assert.equal(getPurchaseOrderCreationState(owner), 'submitted');
});

test('only the employer Stockist account can submit a staff-prepared PO', () => {
  const po = { requester_partner_id: 4, status: 'awaiting_owner_approval' };
  assert.equal(canSubmitPurchaseOrder({ role: 'city_stockist', partnerId: 4 }, po), true);
  assert.equal(canSubmitPurchaseOrder({ role: 'staff', partnerId: 4 }, po), false);
  assert.equal(canSubmitPurchaseOrder({ role: 'city_stockist', partnerId: 9 }, po), false);
});

test('direct parent accepts submitted PO and unrelated Stockist is denied', () => {
  const cityPo = { supplier_partner_id: 2, status: 'submitted' };
  const provincialPo = { supplier_partner_id: null, status: 'submitted' };
  assert.equal(canAcceptPurchaseOrder({ role: 'provincial_stockist', partnerId: 2 }, cityPo), true);
  assert.equal(canAcceptPurchaseOrder({ role: 'provincial_stockist', partnerId: 8 }, cityPo), false);
  assert.equal(canAcceptPurchaseOrder({ role: 'super_admin', partnerId: null }, provincialPo), true);
  assert.equal(canAcceptPurchaseOrder({ role: 'city_stockist', partnerId: 4 }, provincialPo), false);
});

test('PO list scope contains only requester or supplier relationship', () => {
  assert.deepEqual(buildPurchaseOrderScope({ role: 'staff', partnerId: 4 }, 'po'), {
    clause: ' AND (po.requester_partner_id = ? OR po.supplier_partner_id = ?)',
    params: [4, 4],
  });
  assert.deepEqual(buildPurchaseOrderScope({ role: 'super_admin' }, 'po'), { clause: '', params: [] });
});
