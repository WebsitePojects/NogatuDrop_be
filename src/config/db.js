const mysql = require('mysql2/promise');
const env = require('./env');

const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: env.DB_POOL_SIZE,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: '+08:00',
  dateStrings: true,
});

// Force every pooled connection to Asia/Manila (+08:00) so NOW(),
// CURRENT_TIMESTAMP, and DEFAULT timestamp columns store PH time regardless of
// the VPS server's system timezone. Without this, a foreign-TZ host would write
// non-Manila times. Mirrors the timezone handling used in the NogatuMLM system.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+08:00'");
});

module.exports = pool;
