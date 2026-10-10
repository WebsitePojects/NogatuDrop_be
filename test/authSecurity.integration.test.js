// Real-database proof for sign-in sessions, emailed codes and Super Admin alerts. The conditional
// UPDATEs are the safety mechanism here, so they are exercised against MySQL/MariaDB, concurrently.
// Run: NCDMS_DB_TESTS=1 node --env-file=.env.dev --test --test-force-exit test/authSecurity.integration.test.js
// Stop the local API first: its alert cron would otherwise race this test for the queued alerts.
const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs the local database)' };

let pool;
let sessions;
let challenges;
let security;
let resets;
let userId;

test.before(async () => {
  if (!enabled) return;
  pool = require('../src/config/db');
  sessions = require('../src/services/sessionService');
  challenges = require('../src/services/loginChallengeService');
  security = require('../src/services/loginSecurityService');
  resets = require('../src/services/passwordResetService');

  const [[role]] = await pool.execute("SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1");
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [result] = await pool.execute(
    "INSERT INTO users (name, email, password, role_id, level, location, status) VALUES (?, ?, 'x', ?, 'main', 'Test', 'active')",
    [`QA Session ${stamp}`, `qa.session.${stamp}@example.com`, role.id]
  );
  userId = result.insertId;
});

test.after(async () => {
  if (!enabled) return;
  await pool.execute("UPDATE users SET is_deleted = 1, status = 'inactive' WHERE id = ?", [userId]);
  await pool.end();
});

test('a session refreshes concurrently without signing itself out, and only its own token works', opts, async () => {
  const mine = await sessions.createSession(pool, { userId, ip: '112.198.0.1', country: 'PH', userAgent: 'test' });
  const other = await sessions.createSession(pool, { userId });

  const results = await Promise.all(Array.from({ length: 5 }, () => sessions.touchSession(pool, mine.refreshToken)));
  assert.ok(results.every((r) => r && r.sessionId === mine.sessionId), 'every concurrent refresh succeeds');

  await sessions.revokeSession(pool, { sessionId: other.sessionId, reason: 'logout' });
  assert.equal(await sessions.touchSession(pool, other.refreshToken), null, 'a signed-out device cannot refresh');
  assert.ok(await sessions.touchSession(pool, mine.refreshToken), 'signing out one device leaves the other signed in');
  assert.equal(await sessions.touchSession(pool, `${mine.refreshToken}x`), null, 'a tampered token is refused');
});

test('revoking the same session twice at once ends it exactly once', opts, async () => {
  const s = await sessions.createSession(pool, { userId });
  const outcomes = await Promise.all([1, 2, 3].map(() => sessions.revokeSession(pool, { sessionId: s.sessionId, reason: 'revoked_by_admin' })));
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(await sessions.isSessionActive(pool, { sessionId: s.sessionId, userId }), false);
});

test('a session ends after a day idle and after 7 days regardless of activity', opts, async () => {
  const idle = await sessions.createSession(pool, { userId });
  await pool.execute('UPDATE user_sessions SET idle_expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?', [idle.sessionId]);
  assert.equal(await sessions.touchSession(pool, idle.refreshToken), null);
  assert.equal(await sessions.isSessionActive(pool, { sessionId: idle.sessionId, userId }), false);

  const old = await sessions.createSession(pool, { userId });
  await pool.execute('UPDATE user_sessions SET expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?', [old.sessionId]);
  assert.equal(await sessions.touchSession(pool, old.refreshToken), null);

  const fresh = await sessions.createSession(pool, { userId });
  await pool.execute('UPDATE user_sessions SET expires_at = NOW() + INTERVAL 1 HOUR WHERE id = ?', [fresh.sessionId]);
  await sessions.touchSession(pool, fresh.refreshToken);
  const [[row]] = await pool.execute('SELECT idle_expires_at <= expires_at AS capped FROM user_sessions WHERE id = ?', [fresh.sessionId]);
  assert.equal(Number(row.capped), 1, 'activity never extends a session past its 7-day limit');
});

test('a password reset ends every session of the user', opts, async () => {
  const a = await sessions.createSession(pool, { userId });
  const b = await sessions.createSession(pool, { userId });
  assert.ok(await sessions.revokeAllSessions(pool, userId, 'password_reset') >= 2);
  assert.equal(await sessions.touchSession(pool, a.refreshToken), null);
  assert.equal(await sessions.touchSession(pool, b.refreshToken), null);
});

async function newChallenge() {
  const eventId = await security.recordLoginEvent(pool, { userId, outcome: 'code_required', flags: ['quiet_hours'] });
  return challenges.createLoginChallenge(pool, { userId, loginEventId: eventId });
}

test('parallel wrong guesses never exceed 5 attempts, and the code is dead afterwards', opts, async () => {
  const { challengeId, code } = await newChallenge();
  const wrong = code === '000000' ? '111111' : '000000';
  const results = await Promise.all(Array.from({ length: 8 }, () => challenges.verifyLoginChallenge(pool, { challengeId, code: wrong })));
  assert.equal(results.filter((r) => r.status === 'invalid').length, 5);
  assert.equal(results.filter((r) => r.status === 'expired').length, 3);
  assert.equal((await challenges.verifyLoginChallenge(pool, { challengeId, code })).status, 'expired', 'even the right code is refused now');
});

test('the right code submitted three times at once yields exactly one sign-in', opts, async () => {
  const { challengeId, code } = await newChallenge();
  const results = await Promise.all([1, 2, 3].map(() => challenges.verifyLoginChallenge(pool, { challengeId, code })));
  assert.equal(results.filter((r) => r.status === 'ok').length, 1);
  assert.equal((await challenges.verifyLoginChallenge(pool, { challengeId, code })).status, 'expired', 'a used code cannot be reused');
});

test('an expired code is refused', opts, async () => {
  const { challengeId, code } = await newChallenge();
  await pool.execute('UPDATE login_challenges SET expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?', [challengeId]);
  assert.equal((await challenges.verifyLoginChallenge(pool, { challengeId, code })).status, 'expired');
});

test('failed passwords count until the next good sign-in; countries come from good sign-ins', opts, async () => {
  for (let i = 0; i < 5; i += 1) await security.recordLoginEvent(pool, { userId, outcome: 'bad_password', country: 'EG' });
  let history = await security.loadRiskHistory(pool, userId);
  assert.equal(history.recentFailures, 5);
  assert.deepEqual(history.knownCountries, [], 'failed attempts do not make a country "known"');

  await security.recordLoginEvent(pool, { userId, outcome: 'success', country: 'PH' });
  history = await security.loadRiskHistory(pool, userId);
  assert.equal(history.recentFailures, 0);
  assert.deepEqual(history.knownCountries, ['PH']);
  assert.ok(history.successfulLogins >= 1);
});

test('a server clock correction cannot hide failed passwords behind a "future" good sign-in', opts, async () => {
  // A good sign-in stamped while the clock ran 14 hours fast (seen on the dev machine, 2026-10-02).
  const futureId = await security.recordLoginEvent(pool, { userId, outcome: 'success', country: 'PH' });
  await pool.execute('UPDATE login_events SET created_at = NOW() + INTERVAL 14 HOUR WHERE id = ?', [futureId]);
  for (let i = 0; i < 5; i += 1) await security.recordLoginEvent(pool, { userId, outcome: 'bad_password' });
  assert.equal((await security.loadRiskHistory(pool, userId)).recentFailures, 5);
});

test('each flagged sign-in alert is emailed once even with two workers, and failures end as failed', opts, async () => {
  const eventId = await security.recordLoginEvent(pool, { userId, outcome: 'code_required', flags: ['foreign_country'], country: 'EG', ip: '41.33.0.1' });
  // Older queued alerts (from earlier runs) are drained by these calls too; count only ours.
  const sentFor = [];
  const stub = async ({ subject, html }) => { if (html.includes('41.33.0.1') && subject.includes('QA Session')) sentFor.push(subject); };
  await Promise.all([security.processSecurityAlerts({ sendEmailFn: stub }), security.processSecurityAlerts({ sendEmailFn: stub })]);
  const [[sent]] = await pool.execute('SELECT alert_status, alert_attempts FROM login_events WHERE id = ?', [eventId]);
  assert.equal(sent.alert_status, 'sent');
  assert.equal(Number(sent.alert_attempts), 1);
  assert.ok(sentFor.length >= 1);
  const [[mine]] = await pool.execute('SELECT COUNT(*) AS n FROM login_events WHERE id = ? AND alert_status = ?', [eventId, 'sent']);
  assert.equal(Number(mine.n), 1);

  const failingId = await security.recordLoginEvent(pool, { userId, outcome: 'code_required', flags: ['quiet_hours'] });
  const failing = async () => { throw new Error('brevo down'); };
  for (let i = 0; i < 5; i += 1) {
    await pool.execute('UPDATE login_events SET alert_available_at = NOW() WHERE id = ?', [failingId]);
    await security.processSecurityAlerts({ sendEmailFn: failing });
  }
  const [[failed]] = await pool.execute('SELECT alert_status, alert_attempts, alert_last_error FROM login_events WHERE id = ?', [failingId]);
  assert.equal(failed.alert_status, 'failed');
  assert.equal(Number(failed.alert_attempts), 5);
  assert.equal(failed.alert_last_error, 'brevo down');
});

// Password reset codes (audit AUD-08): the guess limit must hold under parallel requests.
async function newResetCode() {
  await pool.execute('DELETE FROM password_reset_codes WHERE user_id = ?', [userId]); // test rows only: reset the hourly cap
  return resets.createPasswordResetCode(pool, { userId });
}

test('reset code: parallel wrong guesses stop at 5, then even the right code is refused', opts, async () => {
  const { code } = await newResetCode();
  const wrong = code === '000000' ? '111111' : '000000';
  const results = await Promise.all(Array.from({ length: 8 }, () => resets.verifyPasswordResetCode(pool, { userId, code: wrong })));
  assert.equal(results.filter((r) => r === 'invalid').length, 5);
  assert.equal(results.filter((r) => r === 'expired').length, 3);
  assert.equal(await resets.verifyPasswordResetCode(pool, { userId, code }), 'expired');
});

test('reset code: the right code three times at once resets the password once', opts, async () => {
  const { code } = await newResetCode();
  const results = await Promise.all([1, 2, 3].map(() => resets.verifyPasswordResetCode(pool, { userId, code })));
  assert.equal(results.filter((r) => r === 'ok').length, 1);
  assert.equal(await resets.verifyPasswordResetCode(pool, { userId, code }), 'expired', 'a used code cannot be reused');
});

test('reset code: asking again retires the earlier code; an expired code is refused', opts, async () => {
  const first = await newResetCode();
  const second = await resets.createPasswordResetCode(pool, { userId });
  if (first.code !== second.code) {
    assert.equal(await resets.verifyPasswordResetCode(pool, { userId, code: first.code }), 'invalid', 'only the newest email works');
  }
  await pool.execute('UPDATE password_reset_codes SET expires_at = NOW() - INTERVAL 1 SECOND WHERE user_id = ?', [userId]);
  assert.equal(await resets.verifyPasswordResetCode(pool, { userId, code: second.code }), 'expired');
});

test('reset code: at most 5 codes per account per hour', opts, async () => {
  await newResetCode();
  const more = [];
  for (let i = 0; i < 5; i += 1) more.push(await resets.createPasswordResetCode(pool, { userId }));
  assert.equal(more.filter(Boolean).length, 4, 'the sixth request in an hour gets no code');
  await pool.execute('DELETE FROM password_reset_codes WHERE user_id = ?', [userId]);
});
