const crypto = require('crypto');
const pool = require('../config/db');
const env = require('../config/env');
const { sendEmail, EMAIL } = require('./emailService');
const { insertNotification } = require('../utils/notificationWriter');
const { LOGIN_FLAGS } = require('./loginRisk');

// login_events records every sign-in attempt for a known account. A flagged attempt also starts a
// Super Admin alert: an in-app notification written in the same transaction, and an email that the
// alert cron delivers from this table (alert_* columns) with a lease claim and bounded retries.

const FLAG_LABELS = Object.freeze({
  [LOGIN_FLAGS.FOREIGN_COUNTRY]: 'outside the Philippines',
  [LOGIN_FLAGS.QUIET_HOURS]: 'between midnight and 5am (Manila time)',
  [LOGIN_FLAGS.FAILED_ATTEMPTS]: 'after several wrong passwords',
  [LOGIN_FLAGS.NEW_COUNTRY]: 'from a country this account has not used before',
});

const describeFlags = (flags) => flags.map((flag) => FLAG_LABELS[flag] || flag).join('; ');

/** Inserts one login_events row and returns its id. A flagged row is queued for the alert email. */
async function recordLoginEvent(db, {
  userId, outcome, flags = [], ip = null, country = null, hour = null, userAgent = null, sessionId = null,
}) {
  const alert = flags.length > 0;
  const [result] = await db.execute(
    `INSERT INTO login_events
       (user_id, outcome, flags, ip, country, manila_hour, user_agent, session_id, alert_status, alert_available_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${alert ? 'NOW()' : 'NULL'})`,
    [userId, outcome, alert ? flags.join(',') : null, ip, country, hour,
      userAgent ? String(userAgent).slice(0, 255) : null, sessionId, alert ? 'pending' : 'none']
  );
  return result.insertId;
}

/**
 * The history evaluateLoginRisk needs, in one round trip. "Since the last good sign-in" is decided by
 * row id, not created_at: ids only grow, while timestamps go backwards when the server clock is
 * corrected, which would hide recent failures behind a "future" success.
 */
async function loadRiskHistory(db, userId) {
  const [rows] = await db.execute(
    `SELECT
       (SELECT COUNT(*) FROM login_events f
         WHERE f.user_id = ? AND f.outcome = 'bad_password'
           AND f.created_at > NOW() - INTERVAL ? MINUTE
           AND f.id > COALESCE(
             (SELECT MAX(s.id) FROM login_events s WHERE s.user_id = ? AND s.outcome IN ('success', 'code_passed')),
             0)) AS recent_failures,
       (SELECT GROUP_CONCAT(DISTINCT c.country) FROM login_events c
         WHERE c.user_id = ? AND c.outcome IN ('success', 'code_passed') AND c.country IS NOT NULL) AS known_countries,
       (SELECT COUNT(*) FROM login_events g
         WHERE g.user_id = ? AND g.outcome IN ('success', 'code_passed')) AS successful_logins`,
    [userId, env.LOGIN_FAILED_WINDOW_MINUTES, userId, userId, userId]
  );
  const row = rows[0] || {};
  return {
    recentFailures: Number(row.recent_failures || 0),
    knownCountries: row.known_countries ? String(row.known_countries).split(',') : [],
    successfulLogins: Number(row.successful_logins || 0),
  };
}

/** In-app alert for every active Super Admin; pass the transaction connection so it commits with the event. */
async function notifySuperAdminsInApp(db, { loginEventId, userName, country, flags }) {
  const [admins] = await db.execute(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.status = 'active' AND u.is_deleted = 0`
  );
  const where = country ? ` from ${country}` : '';
  for (const admin of admins) {
    await insertNotification(db, {
      userId: admin.id,
      type: 'system',
      title: 'Unusual sign-in',
      message: `${userName} signed in${where} ${describeFlags(flags)}. A verification code was emailed to the account.`,
      entityType: 'login_event',
      entityId: loginEventId,
    });
  }
  return admins.length;
}

/**
 * Emails pending alerts to the active Super Admins. Each row is claimed with a lease (conditional
 * UPDATE) so two workers never send the same alert; failures retry with backoff and end as 'failed'
 * after maxAttempts.
 */
async function processSecurityAlerts({ batchSize = 25, maxAttempts = 5, db = pool, sendEmailFn = sendEmail } = {}) {
  const [jobs] = await db.execute(
    `SELECT e.id, e.flags, e.country, e.ip, e.created_at, e.alert_attempts, u.name AS user_name, u.email AS user_email
     FROM login_events e JOIN users u ON u.id = e.user_id
     WHERE e.alert_attempts < ?
       AND ((e.alert_status IN ('pending', 'retry') AND e.alert_available_at <= NOW())
         OR (e.alert_status = 'processing' AND e.alert_locked_at < NOW() - INTERVAL 15 MINUTE))
     ORDER BY e.id LIMIT ?`,
    [maxAttempts, batchSize]
  );
  if (jobs.length === 0) return 0;

  const [admins] = await db.execute(
    `SELECT u.email, u.name FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.slug = 'super_admin' AND u.status = 'active' AND u.is_deleted = 0 AND u.email IS NOT NULL`
  );

  let sent = 0;
  for (const job of jobs) {
    const lease = crypto.randomUUID();
    const [claimed] = await db.execute(
      `UPDATE login_events SET alert_status = 'processing', alert_attempts = alert_attempts + 1,
              alert_locked_at = NOW(), alert_lease_token = ?
       WHERE id = ? AND alert_attempts < ?
         AND ((alert_status IN ('pending', 'retry') AND alert_available_at <= NOW())
           OR (alert_status = 'processing' AND alert_locked_at < NOW() - INTERVAL 15 MINUTE))`,
      [lease, job.id, maxAttempts]
    );
    if (claimed.affectedRows !== 1) continue;

    try {
      if (admins.length === 0) throw new Error('No active Super Admin to alert');
      const flags = String(job.flags || '').split(',').filter(Boolean);
      const template = EMAIL.suspiciousLogin({
        userName: job.user_name, userEmail: job.user_email, country: job.country, ip: job.ip,
        at: job.created_at, reasons: describeFlags(flags),
      });
      await sendEmailFn({ to: admins.map((a) => a.email), ...template, throwOnFailure: true });
      await db.execute(
        `UPDATE login_events SET alert_status = 'sent', alert_locked_at = NULL, alert_lease_token = NULL, alert_last_error = NULL
         WHERE id = ? AND alert_lease_token = ?`,
        [job.id, lease]
      );
      sent += 1;
    } catch (error) {
      const terminal = Number(job.alert_attempts) + 1 >= maxAttempts;
      await db.execute(
        `UPDATE login_events
         SET alert_status = ?, alert_available_at = NOW() + INTERVAL LEAST(60 * POW(2, alert_attempts), 3600) SECOND,
             alert_last_error = ?, alert_locked_at = NULL, alert_lease_token = NULL
         WHERE id = ? AND alert_lease_token = ?`,
        [terminal ? 'failed' : 'retry', String(error.message || error).slice(0, 255), job.id, lease]
      );
    }
  }
  return sent;
}

module.exports = {
  FLAG_LABELS,
  describeFlags,
  recordLoginEvent,
  loadRiskHistory,
  notifySuperAdminsInApp,
  processSecurityAlerts,
};
