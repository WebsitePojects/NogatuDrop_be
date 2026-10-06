const crypto = require('crypto');
const pool = require('../config/db');
const env = require('../config/env');
const ApiError = require('./ApiError');

const LOCK_WAIT_SECONDS = 5;

/**
 * GET_LOCK names are global to the MySQL server, not to a database, and production and staging share
 * one server. The name is hashed together with the database name so the two never block each other,
 * and the hash keeps it under the 64-character limit however long the key is.
 */
function advisoryLockName(scope, key, databaseName = env.DB_NAME) {
  const digest = crypto.createHash('sha1').update(`${databaseName}|${key}`).digest('hex');
  return `nogatu:${scope}:${digest}`;
}

/**
 * Runs `work(connection)` while holding a named MySQL lock, so a check-then-insert on a table with no
 * unique index cannot be raced by a double-click or a retry. A caller that cannot get the lock in
 * time receives a 409 and may retry.
 */
async function withAdvisoryLock(scope, key, work) {
  const conn = await pool.getConnection();
  const lockName = advisoryLockName(scope, key);
  let lockHeld = false;
  try {
    const [[lock]] = await conn.execute('SELECT GET_LOCK(?, ?) AS acquired', [lockName, LOCK_WAIT_SECONDS]);
    if (Number(lock.acquired) !== 1) {
      throw ApiError.conflict('Another change to this record is in progress. Please retry.');
    }
    lockHeld = true;
    return await work(conn);
  } finally {
    try {
      if (lockHeld) await conn.execute('SELECT RELEASE_LOCK(?)', [lockName]);
      conn.release();
    } catch (releaseErr) {
      // A connection that may still hold the lock must not return to the pool.
      conn.destroy();
      console.error('[advisory-lock] failed to release lock:', releaseErr.message);
    }
  }
}

module.exports = { advisoryLockName, withAdvisoryLock };
