const cron = require('node-cron');
const env = require('../config/env');
const { runWithCronLeaderLock } = require('./cronLeaderLock');
const { processSecurityAlerts } = require('./loginSecurityService');

// Delivers the Super Admin email for flagged sign-ins queued in login_events (lease claim and
// bounded retries live in processSecurityAlerts).
async function runSecurityAlerts() {
  try {
    const sent = await processSecurityAlerts({ batchSize: 25, maxAttempts: 5 });
    if (sent > 0) {
      console.log(`[SecurityAlertCron] Sent ${sent} unusual sign-in alert(s)`);
    }
  } catch (err) {
    console.error('[SecurityAlertCron] Error:', err.message);
  }
}

function startSecurityAlertCron() {
  cron.schedule(env.SECURITY_ALERT_CRON, async () => {
    await runWithCronLeaderLock({
      lockKey: 'security-alerts',
      task: runSecurityAlerts,
    });
  });
  console.log(`[SecurityAlertCron] Started — schedule: ${env.SECURITY_ALERT_CRON}`);
}

module.exports = {
  startSecurityAlertCron,
  runSecurityAlerts,
};
