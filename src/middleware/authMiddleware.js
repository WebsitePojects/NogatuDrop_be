const jwt = require('jsonwebtoken');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const normalizeRoleSlug = require('../utils/normalizeRoleSlug');

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(ApiError.unauthorized('Access token is required'));
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    const normalizedRoleSlug = normalizeRoleSlug(decoded.role_slug);
    req.user = {
      id: decoded.id,
      role: decoded.role,
      role_slug: normalizedRoleSlug,
      partner_id: decoded.partner_id,
      email: decoded.email,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(ApiError.unauthorized('Access token has expired'));
    }
    return next(ApiError.unauthorized('Invalid access token'));
  }
};

module.exports = authMiddleware;
