const cron = require('node-cron');
const pool = require('../config/db');
const env = require('../config/env');

async function runTokenCleanup() {
  try {
    const [result] = await pool.execute(
      `DELETE FROM delivery_tokens
       WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`
    );
    if (result.affectedRows > 0) {
      console.log(`[TokenCleanupCron] Deleted ${result.affectedRows} expired delivery token(s)`);
    }
  } catch (err) {
    console.error('[TokenCleanupCron] Error:', err.message);
  }
}

function startTokenCleanupCron() {
  cron.schedule(env.TOKEN_CLEANUP_CRON, runTokenCleanup);
  console.log(`[TokenCleanupCron] Started — schedule: ${env.TOKEN_CLEANUP_CRON}`);
}

module.exports = { startTokenCleanupCron };
