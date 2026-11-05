const crypto = require('crypto');
const redis = require('../config/redis');
const { sendEmail, EMAIL } = require('./emailService');

// The one way a password reset starts, whether the user asked on the Forgot password page or a Super Admin
// pressed "Reset Password": a 6-digit code, emailed, valid 15 minutes. POST /auth/reset-password checks it and
// the user picks the new password. Nobody else ever sees or sets it.
const RESET_CODE_TTL_SECONDS = 15 * 60;

/**
 * Stores a fresh reset code for the user (replacing any earlier one) and emails it.
 * @param {{ id: number, name: string, email: string }} user
 * @returns {Promise<{ sent: boolean }>} the email result (sent:false when the email could not go out)
 */
async function sendPasswordResetCode(user) {
  const code = String(crypto.randomInt(100000, 1000000));
  await redis.setex(`otp:reset:${user.id}`, RESET_CODE_TTL_SECONDS, code);
  return sendEmail({ to: user.email, toName: user.name, ...EMAIL.passwordReset(code) });
}

module.exports = { sendPasswordResetCode, RESET_CODE_TTL_SECONDS };
