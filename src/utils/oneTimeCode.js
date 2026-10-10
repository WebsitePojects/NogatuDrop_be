const crypto = require('crypto');

// Shared rules for the 6-digit codes we email (sign-in check, password reset). Only a salted
// SHA-256 of a code is stored. Every guess consumes an attempt through a conditional UPDATE BEFORE
// the code is compared, so parallel guesses can never exceed the attempt limit; the winning guess
// then consumes the row with a second conditional UPDATE, so one code is used at most once.

// Fixed list, so a table name can never come from a request.
const CODE_TABLES = Object.freeze({
  LOGIN: 'login_challenges',
  PASSWORD_RESET: 'password_reset_codes',
});

const hashCode = (rowId, code) => crypto.createHash('sha256').update(`${rowId}:${code}`).digest('hex');

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Spends one attempt on code row `rowId`, then compares in constant time and consumes it on a match.
 *
 * @param {object} db         the pool (autocommit). Never a transaction that may roll back: that would
 *                            return the spent attempt and allow unlimited guesses.
 * @param {string} table      one of CODE_TABLES
 * @returns {Promise<{status:'ok', row:object} | {status:'invalid'} | {status:'expired'}>}
 *   'invalid'  wrong code, attempts remain
 *   'expired'  unknown, consumed, timed out, or out of attempts
 */
async function spendAttemptAndVerify(db, { table, rowId, code, maxAttempts }) {
  if (!Object.values(CODE_TABLES).includes(table)) throw new Error(`Unknown code table "${table}"`);

  const [claimed] = await db.execute(
    `UPDATE ${table} SET attempts = attempts + 1
     WHERE id = ? AND consumed_at IS NULL AND attempts < ? AND expires_at > NOW()`,
    [rowId, maxAttempts]
  );
  if (claimed.affectedRows !== 1) return { status: 'expired' };

  const [rows] = await db.execute(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`, [rowId]);
  const row = rows[0];
  const expected = Buffer.from(row.code_hash, 'hex');
  const given = Buffer.from(hashCode(rowId, String(code)), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) return { status: 'invalid' };

  const [consumed] = await db.execute(
    `UPDATE ${table} SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL`,
    [rowId]
  );
  if (consumed.affectedRows !== 1) return { status: 'expired' }; // a concurrent correct guess already used it

  return { status: 'ok', row };
}

module.exports = { CODE_TABLES, hashCode, generateCode, spendAttemptAndVerify };
