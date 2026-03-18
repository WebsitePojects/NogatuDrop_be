const ApiError = require('../utils/ApiError');

/**
 * Role guard middleware factory
 * @param  {...string} allowedSlugs - role slugs that are allowed access
 */
const roleGuard = (...allowedSlugs) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication required'));
    }

    if (!allowedSlugs.includes(req.user.role_slug)) {
      return next(ApiError.forbidden('You do not have permission to access this resource'));
    }

    next();
  };
};

module.exports = roleGuard;
