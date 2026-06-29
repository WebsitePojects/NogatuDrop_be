const cron = require('node-cron');
const pool = require('../config/db');
const env = require('../config/env');
const { runWithCronLeaderLock } = require('./cronLeaderLock');

async function runTokenCleanup() {
  // Never delete a token that a proof_of_delivery row still references — POD is a
  // permanent delivery record (FK proof_of_delivery.token_id -> delivery_tokens.id).
  // Deleting referenced tokens triggers a FK constraint error and aborts the sweep.
  const guardedDelete = `DELETE FROM delivery_tokens
       WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
         AND id NOT IN (SELECT token_id FROM proof_of_delivery WHERE token_id IS NOT NULL)`;
  const plainDelete = `DELETE FROM delivery_tokens
       WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`;

  try {
    let result;
    try {
      [result] = await pool.execute(guardedDelete);
    } catch (err) {
      // proof_of_delivery table absent on older schemas -> fall back to plain delete.
      if (err && err.code === 'ER_NO_SUCH_TABLE') {
        [result] = await pool.execute(plainDelete);
      } else {
        throw err;
      }
    }
    if (result.affectedRows > 0) {
      console.log(`[TokenCleanupCron] Deleted ${result.affectedRows} expired delivery token(s)`);
    }
  } catch (err) {
    console.error('[TokenCleanupCron] Error:', err.message);
  }
}

function startTokenCleanupCron() {
  cron.schedule(env.TOKEN_CLEANUP_CRON, async () => {
    await runWithCronLeaderLock({
      lockKey: 'token-cleanup',
      task: runTokenCleanup,
    });
  });
  console.log(`[TokenCleanupCron] Started â€” schedule: ${env.TOKEN_CLEANUP_CRON}`);
}

module.exports = {
  startTokenCleanupCron,
  runTokenCleanup,
};
