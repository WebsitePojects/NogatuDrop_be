const ApiError = require('../utils/ApiError');
const { ROLES, canonicalRole } = require('./roles');

const STOCKIST_SCOPED_ROLES = new Set([
  ROLES.PROVINCIAL_STOCKIST,
  ROLES.CITY_STOCKIST,
  ROLES.STAFF,
  ROLES.MOBILE_STOCKIST,
]);

async function resolveRoleId(roleSlug, getRoleBySlug) {
  const role = await getRoleBySlug(roleSlug);
  if (!role) {
    throw ApiError.badRequest('Invalid role');
  }
  return role.id;
}

async function getPartnerByIdOrThrow(partnerId, getPartnerById) {
  if (!partnerId) {
    throw ApiError.badRequest('Stockist-scoped users require a partner');
  }

  if (typeof getPartnerById !== 'function') {
    throw ApiError.badRequest('Partner validation is not configured');
  }

  const partner = await getPartnerById(partnerId);
  if (!partner || partner.is_deleted) {
    throw ApiError.badRequest('Partner not found');
  }

  if (partner.status && partner.status !== 'active') {
    throw ApiError.badRequest('Partner must be active');
  }

  return partner;
}

function assertPartnerSupportsRole(roleSlug, partner) {
  if (!partner) {
    return;
  }

  if (roleSlug === ROLES.PROVINCIAL_STOCKIST && partner.stockist_level !== ROLES.PROVINCIAL_STOCKIST) {
    throw ApiError.badRequest('Provincial Stockist users must belong to a provincial Stockist partner');
  }

  if (roleSlug === ROLES.CITY_STOCKIST && partner.stockist_level !== ROLES.CITY_STOCKIST) {
    throw ApiError.badRequest('City Stockist users must belong to a city Stockist partner');
  }

  if (
    [ROLES.STAFF, ROLES.MOBILE_STOCKIST].includes(roleSlug) &&
    ![ROLES.PROVINCIAL_STOCKIST, ROLES.CITY_STOCKIST].includes(partner.stockist_level)
  ) {
    throw ApiError.badRequest('Operational users must belong to an active provincial or city Stockist partner');
  }
}

async function resolveUserAssignment({ actor, requested, getRoleBySlug, getPartnerById }) {
  const actorRole = canonicalRole(actor.role_slug);
  const requestedRoleSlug = requested.role_slug ? canonicalRole(requested.role_slug) : null;

  if (requested.role_slug === 'admin') {
    throw ApiError.badRequest('Legacy admin role cannot be assigned to new users');
  }

  if (actorRole === ROLES.SUPER_ADMIN) {
    const roleSlug = requestedRoleSlug;

    if (!roleSlug) {
      throw ApiError.badRequest('Role slug is required');
    }

    if (roleSlug === ROLES.SUPER_ADMIN) {
      return {
        roleId: await resolveRoleId(roleSlug, getRoleBySlug),
        partnerId: null,
      };
    }

    if (STOCKIST_SCOPED_ROLES.has(roleSlug)) {
      const partner = await getPartnerByIdOrThrow(requested.partner_id, getPartnerById);
      assertPartnerSupportsRole(roleSlug, partner);
    }

    return {
      roleId: await resolveRoleId(roleSlug, getRoleBySlug),
      partnerId: requested.partner_id || null,
    };
  }

  if ([ROLES.PROVINCIAL_STOCKIST, ROLES.CITY_STOCKIST].includes(actorRole)) {
    if (!actor.partner_id) {
      throw ApiError.forbidden('Stockist user is missing partner scope');
    }

    const roleSlug = requestedRoleSlug || ROLES.STAFF;

    if (roleSlug !== ROLES.STAFF) {
      throw ApiError.forbidden('Stockists can only create staff users from the Users module');
    }

    return {
      roleId: await resolveRoleId(roleSlug, getRoleBySlug),
      partnerId: actor.partner_id,
    };
  }

  throw ApiError.forbidden('You do not have permission to manage users');
}

module.exports = {
  STOCKIST_SCOPED_ROLES,
  resolveUserAssignment,
};
