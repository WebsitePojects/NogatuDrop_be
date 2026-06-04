const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canApproveOrderFromContext,
  canVerifyPaymentFromContext,
  canManageDeliveryLinkFromContext,
} = require('../src/rbac/affiliationScopes');

test('city stockist can verify and dispatch mobile child orders only', () => {
  const cityContext = {
    role: 'city_stockist',
    userId: 12,
    partnerId: 4,
    partnerLevel: 'city_stockist',
    childCityPartnerIds: [],
  };
  const mobileChildOrder = {
    partner_id: 4,
    placed_by_role_slug: 'mobile_stockist',
  };
  const cityOwnedOrder = {
    partner_id: 4,
    placed_by_role_slug: 'city_stockist',
  };

  assert.equal(canApproveOrderFromContext(cityContext, mobileChildOrder), true);
  assert.equal(canVerifyPaymentFromContext(cityContext, mobileChildOrder), true);
  assert.equal(canManageDeliveryLinkFromContext(cityContext, mobileChildOrder), true);

  assert.equal(canApproveOrderFromContext(cityContext, cityOwnedOrder), false);
  assert.equal(canVerifyPaymentFromContext(cityContext, cityOwnedOrder), false);
  assert.equal(canManageDeliveryLinkFromContext(cityContext, cityOwnedOrder), false);
});

test('provincial stockist can verify and dispatch direct city child orders only', () => {
  const provincialContext = {
    role: 'provincial_stockist',
    userId: 8,
    partnerId: 2,
    partnerLevel: 'provincial_stockist',
    childCityPartnerIds: [4, 6],
  };
  const cityChildOrder = {
    partner_id: 4,
    placed_by_role_slug: 'city_stockist',
  };
  const mobileGrandchildOrder = {
    partner_id: 4,
    placed_by_role_slug: 'mobile_stockist',
  };

  assert.equal(canApproveOrderFromContext(provincialContext, cityChildOrder), true);
  assert.equal(canVerifyPaymentFromContext(provincialContext, cityChildOrder), true);
  assert.equal(canManageDeliveryLinkFromContext(provincialContext, cityChildOrder), true);

  assert.equal(canApproveOrderFromContext(provincialContext, mobileGrandchildOrder), false);
  assert.equal(canVerifyPaymentFromContext(provincialContext, mobileGrandchildOrder), false);
  assert.equal(canManageDeliveryLinkFromContext(provincialContext, mobileGrandchildOrder), false);
});
