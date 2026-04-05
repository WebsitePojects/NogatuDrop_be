const http = require('http');
const app = require('./app');
const env = require('./config/env');
const pool = require('./config/db');
const { startReplenishmentCron } = require('./services/replenishmentCron');
const { startPaymentDeadlineCron } = require('./services/paymentDeadlineCron');
const { startExpiryAlertCron } = require('./services/expiryAlertCron');
const { startTokenCleanupCron } = require('./services/tokenCleanupCron');

const server = http.createServer(app);

async function start() {
  try {
    // Test database connection
    const conn = await pool.getConnection();
    console.log(`[DB] Connected to MySQL — ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);
    conn.release();

    // Start cron jobs
    startReplenishmentCron();
    startPaymentDeadlineCron();
    startExpiryAlertCron();
    startTokenCleanupCron();

    // Start server
    server.listen(env.PORT, () => {
      console.log(`[Server] Nogatu NCDMS API running on port ${env.PORT} (${env.NODE_ENV})`);
    });
  } catch (err) {
    if (err && err.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error(
        `[Server] Failed to start: MySQL access denied for ${env.DB_USER}@${env.DB_HOST}. ` +
          `Update DB_USER/DB_PASSWORD in .env.dev to match a valid local MySQL account.`
      );
    } else {
      console.error('[Server] Failed to start:', err.message);
    }
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  server.close(() => { pool.end(); process.exit(0); });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down...');
  server.close(() => { pool.end(); process.exit(0); });
});

start();
