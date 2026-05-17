const test = require('node:test');
const assert = require('node:assert/strict');

const ApiError = require('../src/utils/ApiError');
const { resolveUserAssignment } = require('../src/rbac/userAssignments');

const roles = {
  super_admin: { id: 1, slug: 'super_admin' },
  provincial_stockist: { id: 2, slug: 'provincial_stockist' },
  city_stockist: { id: 3, slug: 'city_stockist' },
  staff: { id: 4, slug: 'staff' },
  mobile_stockist: { id: 5, slug: 'mobile_stockist' },
};

const partners = {
  10: { id: 10, stockist_level: 'provincial_stockist', status: 'active', is_deleted: 0 },
  20: { id: 20, stockist_level: 'city_stockist', status: 'active', is_deleted: 0 },
  30: { id: 30, stockist_level: 'city_stockist', status: 'inactive', is_deleted: 0 },
};

async function getRoleBySlug(slug) {
  return roles[slug] || null;
}

async function getPartnerById(id) {
  return partners[id] || null;
}

test('stockist-created users are forced under the creator partner and limited to staff users', async () => {
  const assignment = await resolveUserAssignment({
    actor: { role_slug: 'city_stockist', partner_id: 88 },
    requested: { role_slug: 'staff', partner_id: 999 },
    getRoleBySlug,
    getPartnerById,
  });

  assert.equal(assignment.roleId, roles.staff.id);
  assert.equal(assignment.partnerId, 88);

  await assert.rejects(
    resolveUserAssignment({
      actor: { role_slug: 'city_stockist', partner_id: 88 },
      requested: { role_slug: 'super_admin', partner_id: 88 },
      getRoleBySlug,
      getPartnerById,
    }),
    (err) => err instanceof ApiError && err.statusCode === 403
  );

  await assert.rejects(
    resolveUserAssignment({
      actor: { role_slug: 'provincial_stockist', partner_id: 88 },
      requested: { role_slug: 'mobile_stockist', partner_id: 88 },
      getRoleBySlug,
      getPartnerById,
    }),
    (err) => err instanceof ApiError && err.statusCode === 403
  );
});

test('super admin cannot create stockist-scoped users without a partner', async () => {
  await assert.rejects(
    resolveUserAssignment({
      actor: { role_slug: 'super_admin', partner_id: null },
      requested: { role_slug: 'staff', partner_id: null },
      getRoleBySlug,
      getPartnerById,
    }),
    (err) => err instanceof ApiError && err.statusCode === 400
  );
});

test('new user assignment requires role slug instead of opaque role id', async () => {
  await assert.rejects(
    resolveUserAssignment({
      actor: { role_slug: 'super_admin', partner_id: null },
      requested: { role_id: 4, role_slug: null, partner_id: 20 },
      getRoleBySlug,
      getPartnerById,
    }),
    (err) => err instanceof ApiError && err.statusCode === 400
  );
});

test('legacy admin role is rejected for new user creation', async () => {
  await assert.rejects(
    resolveUserAssignment({
      actor: { role_slug: 'super_admin', partner_id: null },
      requested: { role_slug: 'admin', partner_id: 20 },
      getRoleBySlug,
      getPartnerById,
    }),
    (err) => err instanceof ApiError && err.statusCode === 400
  );
});

test('super admin assignments enforce role-to-partner level compatibility', async () => {
  await assert.rejects(
    resolveUserAssignment({
      actor: { role_slug: 'super_admin', partner_id: null },
      requested: { role_slug: 'city_stockist', partner_id: 10 },
      getRoleBySlug,
      getPartnerById,
    }),
    (err) => err instanceof ApiError && err.statusCode === 400
  );

  await assert.rejects(
    resolveUserAssignment({
      actor: { role_slug: 'super_admin', partner_id: null },
      requested: { role_slug: 'staff', partner_id: 30 },
      getRoleBySlug,
      getPartnerById,
    }),
    (err) => err instanceof ApiError && err.statusCode === 400
  );

  const cityAssignment = await resolveUserAssignment({
    actor: { role_slug: 'super_admin', partner_id: null },
    requested: { role_slug: 'city_stockist', partner_id: 20 },
    getRoleBySlug,
    getPartnerById,
  });

  assert.equal(cityAssignment.roleId, roles.city_stockist.id);
  assert.equal(cityAssignment.partnerId, 20);
});
