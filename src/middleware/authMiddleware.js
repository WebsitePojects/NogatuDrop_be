const jwt = require('jsonwebtoken');
const env = require('../config/env');
const pool = require('../config/db');
const ApiError = require('../utils/ApiError');
const normalizeRoleSlug = require('../utils/normalizeRoleSlug');
const { isSessionActive } = require('../services/sessionService');

// Every access token names its session (sid). Checking the session on each request makes sign-out,
// password reset, deactivation and "end session" from Sign-in Activity take effect immediately,
// instead of leaving the 15-minute access token usable. The check is one primary-key lookup.
function createAuthMiddleware({ sessionIsActive = (owner) => isSessionActive(pool, owner) } = {}) {
  return async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(ApiError.unauthorized('Access token is required'));
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(ApiError.unauthorized('Access token has expired'));
      }
      return next(ApiError.unauthorized('Invalid access token'));
    }

    if (!decoded.sid) {
      // Issued before sessions existed; the refresh call will fail too and send the user to sign in.
      return next(ApiError.unauthorized('Access token has expired'));
    }

    try {
      if (!(await sessionIsActive({ sessionId: decoded.sid, userId: decoded.id }))) {
        return next(ApiError.unauthorized('Your session has ended. Please sign in again.'));
      }
    } catch (err) {
      return next(err);
    }

    req.user = {
      id: decoded.id,
      sid: decoded.sid,
      role: decoded.role,
      role_slug: normalizeRoleSlug(decoded.role_slug),
      partner_id: decoded.partner_id,
      email: decoded.email,
    };
    return next();
  };
}

const authMiddleware = createAuthMiddleware();
authMiddleware.createAuthMiddleware = createAuthMiddleware; // tests inject the session check

module.exports = authMiddleware;
