const crypto = require('crypto');

// The 6-digit code a flagged sign-in must enter. Only a salted SHA-256 of the code is stored.
// Every guess consumes an attempt through a conditional UPDATE before the code is compared, so
// parallel guesses can never exceed CODE_MAX_ATTEMPTS, and the winning guess consumes the
// challenge with a second conditional UPDATE, so one code yields at most one session.
const CODE_TTL_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;

const hashCode = (challengeId, code) => crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex');

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

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
  const [claimed] = await db.execute(
    `UPDATE login_challenges SET attempts = attempts + 1
     WHERE id = ? AND consumed_at IS NULL AND attempts < ? AND expires_at > NOW()`,
    [challengeId, CODE_MAX_ATTEMPTS]
  );
  if (claimed.affectedRows !== 1) return { status: 'expired' };

  const [rows] = await db.execute(
    'SELECT user_id, login_event_id, code_hash FROM login_challenges WHERE id = ? LIMIT 1',
    [challengeId]
  );
  const challenge = rows[0];
  const expected = Buffer.from(challenge.code_hash, 'hex');
  const given = Buffer.from(hashCode(challengeId, String(code)), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) return { status: 'invalid' };

  const [consumed] = await db.execute(
    'UPDATE login_challenges SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL',
    [challengeId]
  );
  if (consumed.affectedRows !== 1) return { status: 'expired' }; // a concurrent correct guess already used it

  return { status: 'ok', userId: challenge.user_id, loginEventId: challenge.login_event_id };
}

module.exports = {
  CODE_TTL_MINUTES,
  CODE_MAX_ATTEMPTS,
  createLoginChallenge,
  verifyLoginChallenge,
};
