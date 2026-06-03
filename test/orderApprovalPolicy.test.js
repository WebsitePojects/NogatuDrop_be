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
