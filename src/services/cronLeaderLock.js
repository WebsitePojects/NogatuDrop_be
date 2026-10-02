const pool = require('../config/db');
const env = require('../config/env');

// MySQL/MariaDB reject GET_LOCK names longer than this.
const MYSQL_LOCK_NAME_MAX_LENGTH = 64;

/**
 * GET_LOCK names are global to the MySQL server, not scoped to a database. Production (BLUE)
 * and staging (GREEN) share one server and run the same schedules, so the name carries the
 * database: without it, a staging cron holding the lock makes the matching production cron
 * skip its run (e.g. expired orders stay reserved for another 5 minutes).
 */
function buildCronLockName(lockKey, databaseName = env.DB_NAME) {
  const lockName = `nogatu:cron:${databaseName}:${lockKey}`;
  if (lockName.length > MYSQL_LOCK_NAME_MAX_LENGTH) {
    throw new Error(`Cron lock name "${lockName}" exceeds ${MYSQL_LOCK_NAME_MAX_LENGTH} characters; shorten the lock key`);
  }
  return lockName;
}

async function runWithCronLeaderLock({
  lockKey,
  task,
  connectionFactory = () => pool.getConnection(),
  waitTimeoutSeconds = 0,
  logger = console,
}) {
  const lockName = buildCronLockName(lockKey);
  const conn = await connectionFactory();
  let lockAcquired = false;

  try {
    const [lockRows] = await conn.execute(
      'SELECT GET_LOCK(?, ?) AS acquired_lock',
      [lockName, waitTimeoutSeconds]
    );
    lockAcquired = Number(lockRows?.[0]?.acquired_lock || 0) === 1;

    if (!lockAcquired) {
      logger.warn(`[CronLeaderLock] Skipping ${lockKey}; lock is already held by another worker`);
      return false;
    }

    await task();
    return true;
  } finally {
    try {
      if (lockAcquired) {
        await conn.execute('SELECT RELEASE_LOCK(?) AS released_lock', [lockName]);
      }
    } catch (releaseError) {
      logger.error(`[CronLeaderLock] Failed to release ${lockKey} lock:`, releaseError.message);
    }

    conn.release();
  }
}

module.exports = {
  buildCronLockName,
  runWithCronLeaderLock,
};
