const test = require('node:test');
const assert = require('node:assert/strict');

const ApiError = require('../src/utils/ApiError');
const { PERMISSIONS, hasPermission } = require('../src/rbac/permissions');
const { requirePermission } = require('../src/middleware/roleGuard');

function runMiddleware(middleware, req = {}) {
  return new Promise((resolve) => {
    middleware(req, {}, (err) => resolve(err || null));
  });
}

test('rbac policy grants operational staff only documented operational capabilities', () => {
  assert.equal(hasPermission('staff', PERMISSIONS.ORDERS_VIEW), true);
  assert.equal(hasPermission('staff', PERMISSIONS.GRN_CREATE), true);
  assert.equal(hasPermission('staff', PERMISSIONS.DELIVERY_TOKENS_CREATE), true);
  assert.equal(hasPermission('staff', PERMISSIONS.CART_USE), false);
  assert.equal(hasPermission('staff', PERMISSIONS.USERS_MANAGE), false);
  // Management decision (2026-07): staff can now place orders on their employer's behalf.
  assert.equal(hasPermission('staff', PERMISSIONS.ORDERS_CREATE), true);
  assert.equal(hasPermission('staff', PERMISSIONS.PARTNERS_MANAGE), false);
  assert.equal(hasPermission('staff', PERMISSIONS.WAREHOUSES_MANAGE), true);
  assert.equal(hasPermission('staff', PERMISSIONS.PURCHASE_ORDERS_CREATE), true);
});

test('rbac policy keeps mobile stockists out of management and back-office capabilities', () => {
  assert.equal(hasPermission('mobile_stockist', PERMISSIONS.CART_USE), false);
  assert.equal(hasPermission('mobile_stockist', PERMISSIONS.ORDERS_CREATE), false);
  assert.equal(hasPermission('mobile_stockist', PERMISSIONS.MOBILE_INVENTORY_VIEW), true);
  assert.equal(hasPermission('mobile_stockist', PERMISSIONS.MOBILE_INVENTORY_ADJUST), true);
  assert.equal(hasPermission('mobile_stockist', PERMISSIONS.DASHBOARD_VIEW), false);
  assert.equal(hasPermission('mobile_stockist', PERMISSIONS.USERS_MANAGE), false);
  assert.equal(hasPermission('mobile_stockist', PERMISSIONS.REPORTS_VIEW), false);
  assert.equal(hasPermission('mobile_stockist', PERMISSIONS.STOCK_ADJUSTMENTS_CREATE), false);
});

test('rbac policy assigns daily operation capabilities by normal production role', () => {
  assert.equal(hasPermission('super_admin', PERMISSIONS.ORDERS_APPROVE), true);
  assert.equal(hasPermission('super_admin', PERMISSIONS.BANK_ACCOUNTS_MANAGE), true);

  assert.equal(hasPermission('provincial_stockist', PERMISSIONS.USERS_MANAGE), true);
  assert.equal(hasPermission('provincial_stockist', PERMISSIONS.CART_USE), true);
  assert.equal(hasPermission('provincial_stockist', PERMISSIONS.ORDERS_APPROVE), true);
  assert.equal(hasPermission('provincial_stockist', PERMISSIONS.WAREHOUSES_MANAGE), true);
  assert.equal(hasPermission('provincial_stockist', PERMISSIONS.PURCHASE_ORDERS_APPROVE), true);

  assert.equal(hasPermission('city_stockist', PERMISSIONS.MOBILE_STOCKISTS_MANAGE), true);
  assert.equal(hasPermission('city_stockist', PERMISSIONS.ORDERS_APPROVE), true);
  assert.equal(hasPermission('city_stockist', PERMISSIONS.ORDERS_VERIFY_PAYMENT), true);
  assert.equal(hasPermission('city_stockist', PERMISSIONS.WAREHOUSES_MANAGE), true);
  assert.equal(hasPermission('provincial_stockist', PERMISSIONS.ORDERS_VERIFY_PAYMENT), true);

  assert.equal(hasPermission('staff', PERMISSIONS.ORDERS_UPLOAD_PAYMENT_PROOF), true);
  // Management decision (2026-07): staff can approve orders from affiliated lower-tier
  // stockists (e.g. city staff approving mobile-stockist orders); see affiliationScopes.js
  // canApproveOrderFromContext for the scoping that still blocks self-partner approval.
  assert.equal(hasPermission('staff', PERMISSIONS.ORDERS_APPROVE), true);
});

test('requirePermission denies users without the requested capability', async () => {
  const err = await runMiddleware(
    requirePermission(PERMISSIONS.USERS_MANAGE),
    { user: { id: 7, role_slug: 'staff', partner_id: 10 } }
  );

  assert.ok(err instanceof ApiError);
  assert.equal(err.statusCode, 403);
});

test('requirePermission allows users with the requested capability and exposes authz metadata', async () => {
  const req = { user: { id: 1, role_slug: 'super_admin', partner_id: null } };

  const err = await runMiddleware(requirePermission(PERMISSIONS.USERS_MANAGE), req);

  assert.equal(err, null);
  assert.equal(req.authz.role, 'super_admin');
  assert.equal(req.authz.scope, 'national');
});
