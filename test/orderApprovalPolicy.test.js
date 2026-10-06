const test = require('node:test');
const assert = require('node:assert/strict');

const { canApproveOrderFromContext } = require('../src/rbac/affiliationScopes');

test('provincial stockist can approve direct child city orders', () => {
  assert.equal(
    canApproveOrderFromContext(
      {
        role: 'provincial_stockist',
        partnerId: 2,
        partnerLevel: 'provincial_stockist',
        childCityPartnerIds: [4, 6],
      },
      {
        partner_id: 4,
        placed_by_role_slug: 'city_stockist',
      }
    ),
    true
  );
});

test('provincial stockist cannot approve mobile orders under a child city', () => {
  assert.equal(
    canApproveOrderFromContext(
      {
        role: 'provincial_stockist',
        partnerId: 2,
        partnerLevel: 'provincial_stockist',
        childCityPartnerIds: [4, 6],
      },
      {
        partner_id: 4,
        placed_by_role_slug: 'mobile_stockist',
      }
    ),
    false
  );
});

test('city stockist can approve mobile orders in their own city scope', () => {
  assert.equal(
    canApproveOrderFromContext(
      {
        role: 'city_stockist',
        partnerId: 4,
        partnerLevel: 'city_stockist',
        childCityPartnerIds: [],
      },
      {
        partner_id: 4,
        placed_by_role_slug: 'mobile_stockist',
      }
    ),
    true
  );
});

test('city stockist cannot approve their own city-stockist order', () => {
  assert.equal(
    canApproveOrderFromContext(
      {
        role: 'city_stockist',
        partnerId: 4,
        partnerLevel: 'city_stockist',
        childCityPartnerIds: [],
      },
      {
        partner_id: 4,
        placed_by_role_slug: 'city_stockist',
      }
    ),
    false
  );
});

test('center staff approve and ship the public orders routed to their own center only', () => {
  const { canVerifyPaymentFromContext, canManageDeliveryLinkFromContext } = require('../src/rbac/affiliationScopes');
  const tycoonStaff = { role: 'staff', partnerId: 16, partnerLevel: 'center', childCityPartnerIds: [] };
  const ownPublic = { partner_id: 16, placed_by_type: 'public', placed_by_role_slug: null };
  assert.equal(canApproveOrderFromContext(tycoonStaff, ownPublic), true);
  assert.equal(canManageDeliveryLinkFromContext(tycoonStaff, ownPublic), true);
  assert.equal(canApproveOrderFromContext(tycoonStaff, { ...ownPublic, partner_id: 19 }), false, 'another center');
  assert.equal(canApproveOrderFromContext(tycoonStaff, { partner_id: 16, placed_by_type: 'user', placed_by_role_slug: 'staff' }), false, 'not a store order');
  assert.equal(canApproveOrderFromContext(tycoonStaff, { partner_id: 16, placed_by_role_slug: null }), false, 'unknown origin fails closed');
  assert.equal(canVerifyPaymentFromContext(tycoonStaff, ownPublic), false, 'payment checks stay with Super Admin');
});
