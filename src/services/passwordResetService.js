const crypto = require('crypto');
const { CODE_TABLES, hashCode, generateCode, spendAttemptAndVerify } = require('../utils/oneTimeCode');

// Password reset codes (audit AUD-08): the old code lived in Redis (in process memory on prod, where
// Redis is off), came from Math.random, was compared with !== and allowed unlimited guesses on an
// endpoint without a rate limit, so all one million codes could be tried. Now: stored hashed in
// password_reset_codes, 5 guesses, 15 minutes, single use (rules: utils/oneTimeCode.js). Asking for a
// new code retires the previous one, so only the newest email works.
const RESET_CODE_TTL_MINUTES = 15;
const RESET_CODE_MAX_ATTEMPTS = 5;
// Each new code brings 5 fresh guesses, so codes per account are capped too: at most 25 guesses an hour.
const RESET_CODES_PER_HOUR = 5;

/**
 * Retires any open code for the user and creates a new one. Returns the plaintext code once, for the
 * email, or null when the hourly cap is reached (the caller answers the same either way).
 */
async function createPasswordResetCode(db, { userId }) {
  const [[recent]] = await db.execute(
    'SELECT COUNT(*) AS n FROM password_reset_codes WHERE user_id = ? AND created_at > NOW() - INTERVAL 1 HOUR',
    [userId]
  );
  if (Number(recent.n) >= RESET_CODES_PER_HOUR) return null;

  await db.execute(
    'UPDATE password_reset_codes SET consumed_at = NOW() WHERE user_id = ? AND consumed_at IS NULL',
    [userId]
  );
  const id = crypto.randomUUID();
  const code = generateCode();
  await db.execute(
    `INSERT INTO password_reset_codes (id, user_id, code_hash, expires_at)
     VALUES (?, ?, ?, NOW() + INTERVAL ? MINUTE)`,
    [id, userId, hashCode(id, code), RESET_CODE_TTL_MINUTES]
  );
  return { code, expiresInMinutes: RESET_CODE_TTL_MINUTES };
}

/**
 * Checks a code against the user's newest open code and consumes it on a match. Pass the pool, NOT a
 * transaction: a wrong guess must stay counted even when the request fails afterwards, and a rolled-back
 * transaction would hand the attempt back (unlimited guesses again).
 * @returns {Promise<'ok'|'invalid'|'expired'>}
 */
async function verifyPasswordResetCode(db, { userId, code }) {
  const [rows] = await db.execute(
    `SELECT id FROM password_reset_codes
     WHERE user_id = ? AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId]
  );
  if (rows.length === 0) return 'expired';
  const result = await spendAttemptAndVerify(db, {
    table: CODE_TABLES.PASSWORD_RESET, rowId: rows[0].id, code, maxAttempts: RESET_CODE_MAX_ATTEMPTS,
  });
  return result.status;
}

module.exports = {
  RESET_CODE_TTL_MINUTES,
  RESET_CODE_MAX_ATTEMPTS,
  RESET_CODES_PER_HOUR,
  createPasswordResetCode,
  verifyPasswordResetCode,
};
