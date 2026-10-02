const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const redis = require('../config/redis');
const env = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendEmail, EMAIL } = require('../services/emailService');
const normalizeRoleSlug = require('../utils/normalizeRoleSlug');
const {
  SESSION_REVOKE_REASONS, createSession, touchSession, revokeSession, revokeAllSessions, sessionIdFromRefreshToken,
} = require('../services/sessionService');
const { countryForIp, manilaHour, evaluateLoginRisk } = require('../services/loginRisk');
const { recordLoginEvent, loadRiskHistory, notifySuperAdminsInApp } = require('../services/loginSecurityService');
const { createLoginChallenge, verifyLoginChallenge } = require('../services/loginChallengeService');

function isBcryptHash(value = '') {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

const LOGIN_USER_SELECT = `SELECT u.id, u.name, u.email, u.password, u.phone, u.partner_id, u.status,
            r.id AS role_id, r.name AS role_name, r.slug AS role_slug,
            p.stockist_level AS partner_level, p.business_name AS partner_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN partners p ON p.id = u.partner_id`;

/**
 * The account a login identifier names: its full email or its exact username. Both columns are
 * unique and a username cannot contain "@", so at most one account matches. (Matching the email's
 * local part, as before, picked an arbitrary account when two emails shared one.)
 * Until scripts/addUsername.js has run there is no username column; then only the email matches.
 */
async function findUserForLogin(identifierLower, db = pool) {
  try {
    const [rows] = await db.execute(
      `${LOGIN_USER_SELECT}
     WHERE (LOWER(u.email) = ? OR u.username = ?) AND u.is_deleted = 0
     LIMIT 1`,
      [identifierLower, identifierLower]
    );
    return rows[0] || null;
  } catch (err) {
    if (!err || err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [rows] = await db.execute(
      `${LOGIN_USER_SELECT}
     WHERE LOWER(u.email) = ? AND u.is_deleted = 0
     LIMIT 1`,
      [identifierLower]
    );
    return rows[0] || null;
  }
}

const REFRESH_COOKIE = 'refreshToken';
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/',
});

// Plaintext passwords are no longer accepted: the old migrate-on-login branch compared with === (not
// constant time) and no stored password should still be plaintext.
function verifyPassword(user, password) {
  if (!isBcryptHash(user.password)) return Promise.resolve(false);
  return bcrypt.compare(String(password ?? ''), user.password);
}

// The request facts every sign-in decision uses. req.ip is the client address (trust proxy is set).
function signInContext(req) {
  const ip = req.ip || null;
  return {
    ip,
    country: countryForIp(ip),
    hour: manilaHour(),
    userAgent: req.get('user-agent') || null,
  };
}

function accessTokenFor(user, sessionId) {
  return jwt.sign(
    {
      id: user.id,
      sid: sessionId,
      email: user.email,
      role: user.role_id,
      role_slug: normalizeRoleSlug(user.role_slug),
      partner_id: user.partner_id,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );
}

function userPayload(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role_name,
    role_slug: normalizeRoleSlug(user.role_slug),
    partner_id: user.partner_id,
    partner_level: user.partner_level || null,
    partner_name: user.partner_name || null,
  };
}

/** Starts a session (row + cookie) and sends the signed-in response shared by login and code verification. */
async function startSessionAndRespond(res, user, context) {
  const session = await createSession(pool, {
    userId: user.id, ip: context.ip, country: context.country, userAgent: context.userAgent,
  });
  await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
  res.cookie(REFRESH_COOKIE, session.refreshToken, { ...refreshCookieOptions(), maxAge: session.maxAgeMs });
  res.json({
    success: true,
    message: 'Login successful',
    data: { access_token: accessTokenFor(user, session.sessionId), user: userPayload(user) },
  });
  return session.sessionId;
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

// POST /api/v1/auth/login
// A correct password signs in directly, unless the sign-in looks unusual (services/loginRisk.js):
// then a 6-digit code is emailed to the account and the session starts only at /auth/login/verify.
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const identifierLower = String(email || '').trim().toLowerCase();

  const user = await findUserForLogin(identifierLower);
  if (!user) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (user.status !== 'active') {
    throw ApiError.unauthorized('Account is inactive or suspended');
  }

  const context = signInContext(req);
  if (!(await verifyPassword(user, password))) {
    await recordLoginEvent(pool, { userId: user.id, outcome: 'bad_password', ...context });
    throw ApiError.unauthorized('Invalid email or password');
  }

  const history = await loadRiskHistory(pool, user.id);
  const flags = evaluateLoginRisk({ ...history, country: context.country, hour: context.hour });

  if (flags.length === 0) {
    const sessionId = await startSessionAndRespond(res, user, context);
    await recordLoginEvent(pool, { userId: user.id, outcome: 'success', ...context, sessionId });
    return;
  }

  // Flagged: the event, the Super Admin in-app alerts and the code challenge commit together; the
  // alert email is delivered later from the same event row by the alert cron.
  const conn = await pool.getConnection();
  let challenge;
  let loginEventId;
  try {
    await conn.beginTransaction();
    loginEventId = await recordLoginEvent(conn, { userId: user.id, outcome: 'code_required', flags, ...context });
    await notifySuperAdminsInApp(conn, { loginEventId, userName: user.name, country: context.country, flags });
    challenge = await createLoginChallenge(conn, { userId: user.id, loginEventId });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  try {
    const template = EMAIL.loginCode(challenge.code, challenge.expiresInSeconds / 60);
    await sendEmail({ to: user.email, toName: user.name, ...template, throwOnFailure: true });
  } catch (err) {
    // Fail closed: without the code nobody can finish this sign-in, so say so instead of hanging.
    await pool.execute("UPDATE login_events SET outcome = 'code_unsent' WHERE id = ?", [loginEventId]);
    console.error('[Auth] Sign-in code email failed:', err.message);
    throw new ApiError(503, 'We could not send your sign-in code. Please try again in a few minutes.');
  }

  res.json({
    success: true,
    message: 'Enter the code we emailed you to finish signing in',
    data: {
      code_required: true,
      challenge_id: challenge.challengeId,
      email_hint: maskEmail(user.email),
      expires_in_seconds: challenge.expiresInSeconds,
    },
  });
});

// POST /api/v1/auth/login/verify
const verifyLogin = asyncHandler(async (req, res) => {
  const { challenge_id: challengeId, code } = req.body;
  const result = await verifyLoginChallenge(pool, { challengeId, code });
  if (result.status === 'invalid') {
    throw ApiError.unauthorized('That code is not correct. Check the email and try again.');
  }
  if (result.status !== 'ok') {
    throw ApiError.unauthorized('This code has expired or was used too many times. Please sign in again.');
  }

  const [users] = await pool.execute(
    `${LOGIN_USER_SELECT}
     WHERE u.id = ? AND u.is_deleted = 0
     LIMIT 1`,
    [result.userId]
  );
  const user = users[0];
  if (!user || user.status !== 'active') {
    throw ApiError.unauthorized('Account is inactive or suspended');
  }

  const sessionId = await startSessionAndRespond(res, user, signInContext(req));
  await pool.execute(
    "UPDATE login_events SET outcome = 'code_passed', session_id = ? WHERE id = ?",
    [sessionId, result.loginEventId]
  );
});

// POST /api/v1/auth/logout — ends only this device's session (identified by its refresh cookie).
const logout = asyncHandler(async (req, res) => {
  const owner = sessionIdFromRefreshToken(req.cookies[REFRESH_COOKIE]);
  if (owner) {
    await revokeSession(pool, { sessionId: owner.sessionId, userId: owner.userId, reason: SESSION_REVOKE_REASONS.LOGOUT });
  }
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
  res.json({ success: true, message: 'Logged out successfully' });
});

// POST /api/v1/auth/refresh
const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies[REFRESH_COOKIE];
  if (!refreshToken) {
    throw ApiError.unauthorized('Refresh token is required');
  }

  const session = await touchSession(pool, refreshToken);
  if (!session) {
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
    throw ApiError.unauthorized('Your session has ended. Please sign in again.');
  }

  const [users] = await pool.execute(
    `SELECT u.id, u.email, u.partner_id, u.status, r.id AS role_id, r.slug AS role_slug
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.is_deleted = 0
     LIMIT 1`,
    [session.userId]
  );
  if (users.length === 0 || users[0].status !== 'active') {
    await revokeSession(pool, { sessionId: session.sessionId, reason: SESSION_REVOKE_REASONS.ACCOUNT_DISABLED });
    throw ApiError.unauthorized('User not found or inactive');
  }

  res.json({
    success: true,
    message: 'Token refreshed',
    data: { access_token: accessTokenFor(users[0], session.sessionId) },
  });
});

// GET /api/v1/auth/me
const me = asyncHandler(async (req, res) => {
  const [users] = await pool.execute(
    `SELECT u.id, u.name, u.email, u.phone, u.partner_id, u.level, u.location, u.status,
            u.last_login, u.created_at,
            r.name AS role_name, r.slug AS role_slug,
            p.business_name AS partner_name, p.stockist_level AS partner_level
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN partners p ON p.id = u.partner_id
     WHERE u.id = ? AND u.is_deleted = 0
     LIMIT 1`,
    [req.user.id]
  );

  if (users.length === 0) {
    throw ApiError.notFound('User not found');
  }

  res.json({
    success: true,
    data: {
      ...users[0],
      role_slug: normalizeRoleSlug(users[0].role_slug),
    },
  });
});

// POST /api/v1/auth/forgot-password
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw ApiError.badRequest('Email is required');

  const [users] = await pool.execute(
    'SELECT id, name, email FROM users WHERE email = ? AND is_deleted = 0 AND status = \'active\' LIMIT 1',
    [email]
  );

  // Always return 200 to prevent user enumeration
  if (users.length === 0) {
    return res.json({ success: true, message: 'If that email exists, a reset code has been sent.' });
  }

  const user = users[0];
  const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit OTP
  const ttlSeconds = 15 * 60; // 15 minutes

  await redis.setex(`otp:reset:${user.id}`, ttlSeconds, otp);

  const tmpl = EMAIL.passwordReset(otp);
  await sendEmail({ to: user.email, toName: user.name, ...tmpl });

  res.json({ success: true, message: 'If that email exists, a reset code has been sent.' });
});

// POST /api/v1/auth/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, new_password } = req.body;
  if (!email || !otp || !new_password) throw ApiError.badRequest('email, otp, and new_password are required');
  if (new_password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');

  const [users] = await pool.execute(
    'SELECT id FROM users WHERE email = ? AND is_deleted = 0 AND status = \'active\' LIMIT 1',
    [email]
  );
  if (users.length === 0) throw ApiError.badRequest('Invalid reset request');

  const userId = users[0].id;
  const storedOtp = await redis.get(`otp:reset:${userId}`);

  if (!storedOtp || storedOtp !== otp) {
    throw ApiError.badRequest('Invalid or expired reset code');
  }

  const hashed = await bcrypt.hash(new_password, 12);
  await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, userId]);
  await redis.del(`otp:reset:${userId}`);

  // A password change ends every signed-in device.
  await revokeAllSessions(pool, userId, SESSION_REVOKE_REASONS.PASSWORD_RESET);

  res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
});

module.exports = { login, verifyLogin, logout, refresh, me, forgotPassword, resetPassword, findUserForLogin };
