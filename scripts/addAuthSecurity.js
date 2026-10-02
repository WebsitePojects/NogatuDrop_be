// Sign-in security tables:
//   user_sessions     one row per signed-in device; replaces the single Redis refresh slot per user.
//                     Enforces the 7-day absolute and 1-day idle limits and lets an admin end a session.
//   login_events      every sign-in attempt with its risk flags; flagged rows double as the outbox for
//                     the Super Admin alert email (alert_* columns, lease-claimed by the alert cron).
//   login_challenges  the 6-digit code emailed when a sign-in is flagged (hash only, 10-minute TTL).
//
// Additive and idempotent (CREATE TABLE IF NOT EXISTS). Refuses to run without an env file.
// Run: node --env-file=.env.dev scripts/addAuthSecurity.js
const mysql = require('mysql2/promise');

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS user_sessions (
     id CHAR(36) NOT NULL,
     user_id BIGINT UNSIGNED NOT NULL,
     refresh_hash CHAR(64) NOT NULL,
     ip VARCHAR(45) NULL,
     country CHAR(2) NULL,
     user_agent VARCHAR(255) NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     idle_expires_at DATETIME NOT NULL,
     expires_at DATETIME NOT NULL,
     revoked_at DATETIME NULL,
     revoke_reason VARCHAR(40) NULL,
     PRIMARY KEY (id),
     KEY idx_user_sessions_user_active (user_id, revoked_at, expires_at),
     KEY idx_user_sessions_expires (expires_at),
     CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users(id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS login_events (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     user_id BIGINT UNSIGNED NOT NULL,
     outcome ENUM('success','bad_password','code_required','code_passed','code_failed','code_unsent') NOT NULL,
     flags VARCHAR(120) NULL,
     ip VARCHAR(45) NULL,
     country CHAR(2) NULL,
     manila_hour TINYINT UNSIGNED NULL,
     user_agent VARCHAR(255) NULL,
     session_id CHAR(36) NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     alert_status ENUM('none','pending','processing','retry','sent','failed') NOT NULL DEFAULT 'none',
     alert_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
     alert_available_at DATETIME NULL,
     alert_locked_at DATETIME NULL,
     alert_lease_token CHAR(36) NULL,
     alert_last_error VARCHAR(255) NULL,
     PRIMARY KEY (id),
     KEY idx_login_events_user_time (user_id, created_at),
     KEY idx_login_events_time (created_at),
     KEY idx_login_events_alert (alert_status, alert_available_at),
     CONSTRAINT fk_login_events_user FOREIGN KEY (user_id) REFERENCES users(id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS login_challenges (
     id CHAR(36) NOT NULL,
     user_id BIGINT UNSIGNED NOT NULL,
     login_event_id BIGINT UNSIGNED NOT NULL,
     code_hash CHAR(64) NOT NULL,
     attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
     expires_at DATETIME NOT NULL,
     consumed_at DATETIME NULL,
     created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     KEY idx_login_challenges_user (user_id, created_at),
     CONSTRAINT fk_login_challenges_user FOREIGN KEY (user_id) REFERENCES users(id),
     CONSTRAINT fk_login_challenges_event FOREIGN KEY (login_event_id) REFERENCES login_events(id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function main() {
  if (!process.env.DB_NAME) {
    throw new Error('DB_NAME is not set. Run with --env-file=<.env.dev|.env.prod>.');
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });
  try {
    for (const sql of STATEMENTS) {
      const table = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql)[1];
      const [existing] = await conn.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
        [table]
      );
      await conn.query(sql);
      console.log(existing.length ? `${table} already exists — skipping` : `Created ${table}`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  console.error('ERR', error.message);
  process.exit(1);
});
