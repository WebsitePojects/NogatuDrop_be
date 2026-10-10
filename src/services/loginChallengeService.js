const crypto = require('crypto');
const { CODE_TABLES, hashCode, generateCode, spendAttemptAndVerify } = require('../utils/oneTimeCode');

// The 6-digit code a flagged sign-in must enter (attempt and single-use rules: utils/oneTimeCode.js).
const CODE_TTL_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;

/** Creates a challenge for a flagged sign-in. Returns the plaintext code exactly once, for the email. */
async function createLoginChallenge(db, { userId, loginEventId }) {
  const challengeId = crypto.randomUUID();
  const code = generateCode();
  await db.execute(
    `INSERT INTO login_challenges (id, user_id, login_event_id, code_hash, expires_at)
     VALUES (?, ?, ?, ?, NOW() + INTERVAL ? MINUTE)`,
    [challengeId, userId, loginEventId, hashCode(challengeId, code), CODE_TTL_MINUTES]
  );
  return { challengeId, code, expiresInSeconds: CODE_TTL_MINUTES * 60 };
}

/**
 * @returns {Promise<{status:'ok', userId:number, loginEventId:number} | {status:'invalid'} | {status:'expired'}>}
 *   'invalid'  wrong code, attempts remain
 *   'expired'  unknown, consumed, timed out, or out of attempts — the person must sign in again
 */
async function verifyLoginChallenge(db, { challengeId, code }) {
  const result = await spendAttemptAndVerify(db, {
    table: CODE_TABLES.LOGIN, rowId: challengeId, code, maxAttempts: CODE_MAX_ATTEMPTS,
  });
  if (result.status !== 'ok') return result;
  return { status: 'ok', userId: result.row.user_id, loginEventId: result.row.login_event_id };
}

module.exports = {
  CODE_TTL_MINUTES,
  CODE_MAX_ATTEMPTS,
  createLoginChallenge,
  verifyLoginChallenge,
};
