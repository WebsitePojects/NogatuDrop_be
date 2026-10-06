const normalizeRoleSlug = require('../utils/normalizeRoleSlug');

const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  PROVINCIAL_STOCKIST: 'provincial_stockist',
  CITY_STOCKIST: 'city_stockist',
  STAFF: 'staff',
  MOBILE_STOCKIST: 'mobile_stockist',
});

// partners.stockist_level values. A 'center' is a company-owned fulfillment center (Caloocan, Tycoon):
// it owns a warehouse and staff, but is NOT a Stockist — no discount, no parent, no MLM sync.
// Its staff approve and ship only the public store orders routed to it. Anything not listed here is unknown and must fail closed.
const PARTNER_LEVELS = Object.freeze({
  PROVINCIAL: 'provincial_stockist',
  CITY: 'city_stockist',
  CENTER: 'center',
});

const STOCKIST_LEVELS = Object.freeze([PARTNER_LEVELS.PROVINCIAL, PARTNER_LEVELS.CITY]);

function isStockistLevel(level) {
  return STOCKIST_LEVELS.includes(level);
}

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
  PARTNER_LEVELS,
  STOCKIST_LEVELS,
  isStockistLevel,
  ROLE_SCOPES,
  canonicalRole,
  getRoleScope,
};
