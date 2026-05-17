const ApiError = require('../utils/ApiError');
const { hasPermission } = require('../rbac/permissions');
const { canonicalRole, getRoleScope } = require('../rbac/roles');

/**
 * Role guard middleware factory
 * @param  {...string} allowedSlugs - role slugs that are allowed access
 */
const roleGuard = (...allowedSlugs) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication required'));
    }

    const userRole = canonicalRole(req.user.role_slug);
    const allowedRoles = allowedSlugs.map(canonicalRole);

    if (!allowedRoles.includes(userRole)) {
      return next(ApiError.forbidden('You do not have permission to access this resource'));
    }

    next();
  };
};

const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication required'));
    }

    const role = canonicalRole(req.user.role_slug);

    if (!hasPermission(role, permission)) {
      return next(ApiError.forbidden('You do not have permission to access this resource'));
    }

    req.authz = {
      role,
      scope: getRoleScope(role),
      partnerId: req.user.partner_id || null,
      userId: req.user.id,
    };

    next();
  };
};

roleGuard.requirePermission = requirePermission;

module.exports = roleGuard;
