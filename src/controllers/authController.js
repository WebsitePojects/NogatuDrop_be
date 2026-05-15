const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const redis = require('../config/redis');
const env = require('../config/env');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { sendEmail, EMAIL } = require('../services/emailService');
const normalizeRoleSlug = require('../utils/normalizeRoleSlug');

function parseExpiry(str) {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) return 900;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
  return num * (multipliers[unit] || 60);
}

function isBcryptHash(value = '') {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}

// POST /api/v1/auth/login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const [users] = await pool.execute(
    `SELECT u.id, u.name, u.email, u.password, u.phone, u.partner_id, u.status,
            r.id AS role_id, r.name AS role_name, r.slug AS role_slug
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.email = ? AND u.is_deleted = 0
     LIMIT 1`,
    [email]
  );

  if (users.length === 0) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const user = users[0];
  const normalizedRoleSlug = normalizeRoleSlug(user.role_slug);

  if (user.status !== 'active') {
    throw ApiError.unauthorized('Account is inactive or suspended');
  }

  let isMatch = false;

  if (isBcryptHash(user.password)) {
    isMatch = await bcrypt.compare(password, user.password);
  } else {
    // Legacy plaintext password support: allow once, then migrate to bcrypt.
    isMatch = password === user.password;
    if (isMatch) {
      const migratedHash = await bcrypt.hash(password, 12);
      await pool.execute('UPDATE users SET password = ? WHERE id = ?', [migratedHash, user.id]);
    }
  }

  if (!isMatch) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  // Generate access token
  const accessPayload = {
    id: user.id,
    email: user.email,
    role: user.role_id,
    role_slug: normalizedRoleSlug,
    partner_id: user.partner_id,
  };
  const accessToken = jwt.sign(accessPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });

  // Generate refresh token
  const refreshPayload = { id: user.id, type: 'refresh' };
  const refreshToken = jwt.sign(refreshPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  });

  // Store refresh token hash in Redis
  const refreshHash = await bcrypt.hash(refreshToken, 12);
  const refreshTTL = parseExpiry(env.JWT_REFRESH_EXPIRES_IN);
  await redis.setex(`refresh:${user.id}`, refreshTTL, refreshHash);

  // Update last_login
  await pool.execute('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

  // Set httpOnly cookie with refresh token
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: refreshTTL * 1000,
    path: '/',
  });

  res.json({
    success: true,
    message: 'Login successful',
    data: {
      access_token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role_name,
        role_slug: normalizedRoleSlug,
        partner_id: user.partner_id,
      },
    },
  });
});

// POST /api/v1/auth/logout
const logout = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Clear refresh token from Redis
  await redis.del(`refresh:${userId}`);

  // Clear cookie
  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });

  res.json({ success: true, message: 'Logged out successfully' });
});

// POST /api/v1/auth/refresh
const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    throw ApiError.unauthorized('Refresh token is required');
  }

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  // Verify hash matches stored hash
  const storedHash = await redis.get(`refresh:${decoded.id}`);

  if (!storedHash) {
    throw ApiError.unauthorized('Refresh token has been revoked');
  }

  const isValidRefresh = await bcrypt.compare(refreshToken, storedHash);
  if (!isValidRefresh) {
    throw ApiError.unauthorized('Refresh token has been revoked');
  }

  // Get user info
  const [users] = await pool.execute(
        `SELECT u.id, u.name, u.email, u.phone, u.partner_id, u.status,
          r.id AS role_id, r.name AS role_name, r.slug AS role_slug
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.is_deleted = 0
     LIMIT 1`,
    [decoded.id]
  );

  if (users.length === 0 || users[0].status !== 'active') {
    throw ApiError.unauthorized('User not found or inactive');
  }

  const user = users[0];
  const normalizedRoleSlug = normalizeRoleSlug(user.role_slug);

  // Issue new access token
  const accessToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role_id,
      role_slug: normalizedRoleSlug,
      partner_id: user.partner_id,
    },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
  );

  res.json({
    success: true,
    message: 'Token refreshed',
    data: { access_token: accessToken },
  });
});

// GET /api/v1/auth/me
const me = asyncHandler(async (req, res) => {
  const [users] = await pool.execute(
    `SELECT u.id, u.name, u.email, u.phone, u.partner_id, u.level, u.location, u.status,
            u.last_login, u.created_at,
            r.name AS role_name, r.slug AS role_slug,
            p.business_name AS partner_name
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

  // Revoke all refresh tokens for this user
  await redis.del(`refresh:${userId}`);

  res.json({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
});

module.exports = { login, logout, refresh, me, forgotPassword, resetPassword };
