const normalizeRoleSlug = require('../utils/normalizeRoleSlug');

const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  PROVINCIAL_STOCKIST: 'provincial_stockist',
  CITY_STOCKIST: 'city_stockist',
  STAFF: 'staff',
  MOBILE_STOCKIST: 'mobile_stockist',
});

const ROLE_SCOPES = Object.freeze({
  [ROLES.SUPER_ADMIN]: 'national',
  [ROLES.PROVINCIAL_STOCKIST]: 'partner',
  [ROLES.CITY_STOCKIST]: 'partner',
  [ROLES.STAFF]: 'partner',
  [ROLES.MOBILE_STOCKIST]: 'mobile',
});

function canonicalRole(roleSlug) {
  return normalizeRoleSlug(roleSlug);
}

function getRoleScope(roleSlug) {
  return ROLE_SCOPES[canonicalRole(roleSlug)] || 'none';
}

module.exports = {
  ROLES,
  ROLE_SCOPES,
  canonicalRole,
  getRoleScope,
};
