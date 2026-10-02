const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

// One row in user_sessions per signed-in device. The refresh token (httpOnly cookie) names its
// session; access tokens carry the same session id so authMiddleware can reject a revoked session
// immediately instead of waiting for the 15-minute access token to expire.
//
// The refresh token is NOT rotated on use: several tabs refresh concurrently, and rotation would
// make the slower tab present an already-replaced token and sign the user out. The hard limits come
// from the session row instead: expires_at (sign-in + SESSION_MAX_AGE_HOURS) and idle_expires_at
// (pushed forward on every refresh, never past expires_at).

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const SESSION_REVOKE_REASONS = Object.freeze({
  LOGOUT: 'logout',
  PASSWORD_RESET: 'password_reset',
  ACCOUNT_DISABLED: 'account_disabled',
  ADMIN: 'revoked_by_admin',
});

function sessionMaxAgeMs() {
  return env.SESSION_MAX_AGE_HOURS * 60 * 60 * 1000;
}

/** Starts a session and returns the refresh token for the cookie. Pass a transaction connection to keep it atomic. */
async function createSession(db, { userId, ip = null, country = null, userAgent = null }) {
  const sessionId = crypto.randomUUID();
  const refreshToken = jwt.sign(
    { id: userId, sid: sessionId, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: `${env.SESSION_MAX_AGE_HOURS}h` }
  );
  await db.execute(
    `INSERT INTO user_sessions (id, user_id, refresh_hash, ip, country, user_agent, idle_expires_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW() + INTERVAL ? HOUR, NOW() + INTERVAL ? HOUR)`,
    [sessionId, userId, sha256(refreshToken), ip, country, truncate(userAgent, 255),
      Math.min(env.SESSION_IDLE_HOURS, env.SESSION_MAX_AGE_HOURS), env.SESSION_MAX_AGE_HOURS]
  );
  return { sessionId, refreshToken, maxAgeMs: sessionMaxAgeMs() };
}

/**
 * Validates a refresh token against its live session and pushes the idle deadline forward, in one
 * conditional UPDATE (no read-then-write window). Returns { userId, sessionId } or null when the
 * token is malformed, revoked, past 7 days, idle past 1 day, or not the token this session issued.
 */
async function touchSession(db, refreshToken) {
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
  } catch {
    return null;
  }
  if (!decoded || decoded.type !== 'refresh' || !decoded.sid) return null; // pre-session tokens: sign in again

  const [result] = await db.execute(
    `UPDATE user_sessions
     SET last_seen_at = NOW(), idle_expires_at = LEAST(expires_at, NOW() + INTERVAL ? HOUR)
     WHERE id = ? AND user_id = ? AND refresh_hash = ?
       AND revoked_at IS NULL AND expires_at > NOW() AND idle_expires_at > NOW()`,
    [env.SESSION_IDLE_HOURS, decoded.sid, decoded.id, sha256(refreshToken)]
  );
  return result.affectedRows === 1 ? { userId: decoded.id, sessionId: decoded.sid } : null;
}

/** True while the session may be used: not revoked and inside both time limits. */
async function isSessionActive(db, { sessionId, userId }) {
  const [rows] = await db.execute(
    `SELECT 1 FROM user_sessions
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > NOW() AND idle_expires_at > NOW()
     LIMIT 1`,
    [sessionId, userId]
  );
  return rows.length === 1;
}

/** Ends one session. Returns true only for the call that actually ended it. */
async function revokeSession(db, { sessionId, userId = null, reason }) {
  const [result] = await db.execute(
    `UPDATE user_sessions SET revoked_at = NOW(), revoke_reason = ?
     WHERE id = ? AND revoked_at IS NULL ${userId ? 'AND user_id = ?' : ''}`,
    userId ? [reason, sessionId, userId] : [reason, sessionId]
  );
  return result.affectedRows === 1;
}

/** Ends every live session of a user (password change, deactivation). Returns how many ended. */
async function revokeAllSessions(db, userId, reason) {
  const [result] = await db.execute(
    'UPDATE user_sessions SET revoked_at = NOW(), revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
    [reason, userId]
  );
  return result.affectedRows;
}

/** Session id carried by a refresh token, verified but without touching the database. */
function sessionIdFromRefreshToken(refreshToken) {
  try {
    const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
    return decoded && decoded.type === 'refresh' && decoded.sid ? { sessionId: decoded.sid, userId: decoded.id } : null;
  } catch {
    return null;
  }
}

function truncate(value, max) {
  if (value == null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
}

module.exports = {
  SESSION_REVOKE_REASONS,
  sessionMaxAgeMs,
  createSession,
  touchSession,
  isSessionActive,
  revokeSession,
  revokeAllSessions,
  sessionIdFromRefreshToken,
};
