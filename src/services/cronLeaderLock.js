const pool = require('../config/db');

function buildCronLockName(lockKey) {
  return `nogatu:cron:${lockKey}`;
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
