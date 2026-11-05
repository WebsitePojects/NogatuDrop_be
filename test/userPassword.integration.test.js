// Real-database proof for the Users screen password fixes (management, 2026-11-05):
//   - Edit User saves a new password; blank keeps the current one; a short one is refused.
//   - Reset Password emails a reset code and leaves the password alone (it used to replace it with a random
//     password nobody was shown, locking the user out).
// Run: NCDMS_DB_TESTS=1 node --env-file=<env> --test --test-force-exit test/userPassword.integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const enabled = process.env.NCDMS_DB_TESTS === '1';
const opts = { skip: !enabled && 'set NCDMS_DB_TESTS=1 (needs the local database)' };

let pool;
let users;
let redis;
let env;
let userId;
const realFetch = global.fetch;
let savedEnv;

const adminUser = { id: 0, role_slug: 'super_admin', partner_id: null };

function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handler(req, res, (err) => resolve({ status: err?.statusCode || 500, body: { message: err?.message } }));
  });
}

async function storedHash() {
  const [[row]] = await pool.execute('SELECT password FROM users WHERE id = ?', [userId]);
  return row.password;
}

/** Pretends to be Resend: answers every send with `status`. */
function fakeResend(status) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => (status < 300 ? { id: 'test-mail' } : { name: 'application_error' }) };
  };
  return calls;
}

test.before(async () => {
  if (!enabled) return;
  pool = require('../src/config/db');
  users = require('../src/controllers/userController');
  redis = require('../src/config/redis');
  env = require('../src/config/env');
  savedEnv = { EMAIL_PROVIDER: env.EMAIL_PROVIDER, RESEND_API_KEY: env.RESEND_API_KEY, EMAIL_ALLOWLIST: env.EMAIL_ALLOWLIST };
  Object.assign(env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_ALLOWLIST: [] });
  const [[admin]] = await pool.execute(
    "SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.slug = 'super_admin' AND u.is_deleted = 0 LIMIT 1"
  );
  adminUser.id = admin.id;
  const [[role]] = await pool.execute("SELECT id FROM roles WHERE slug = 'super_admin' LIMIT 1");
  const stamp = Date.now();
  const [created] = await pool.execute(
    `INSERT INTO users (name, email, username, password, role_id, level, location, status)
     VALUES ('Password Test', ?, ?, ?, ?, 'main', 'Test', 'active')`,
    [`pwtest.${stamp}@gmail.com`, `pwtest${stamp}`, await bcrypt.hash('OldPass123', 12), role.id]
  );
  userId = created.insertId;
});

test.after(async () => {
  if (!enabled) return;
  global.fetch = realFetch;
  Object.assign(env, savedEnv);
  // Test fixture only.
  await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
  await pool.end();
});

const editReq = (body) => ({ params: { id: String(userId) }, body, user: adminUser });

test('Edit User: a new password is saved; blank keeps it; a short one is refused', opts, async () => {
  const saved = await call(users.updateUser, editReq({ password: 'NewPass456' }));
  assert.equal(saved.status, 200, saved.body.message);
  assert.equal(await bcrypt.compare('NewPass456', await storedHash()), true);

  const before = await storedHash();
  assert.equal((await call(users.updateUser, editReq({ name: 'Password Test 2', password: '' }))).status, 200);
  assert.equal(await storedHash(), before, 'blank password keeps the current one');

  const short = await call(users.updateUser, editReq({ password: 'short' }));
  assert.equal(short.status, 400);
  assert.equal(await storedHash(), before);
});

test('Reset Password emails a code and does not change the password', opts, async () => {
  const before = await storedHash();
  const calls = fakeResend(200);
  const res = await call(users.resetUserPassword, { params: { id: String(userId) }, user: adminUser });
  assert.equal(res.status, 200, res.body.message);
  assert.equal(res.body.data, undefined, 'no password comes back');
  assert.equal(await storedHash(), before, 'password unchanged');
  const code = await redis.get(`otp:reset:${userId}`);
  assert.match(String(code), /^\d{6}$/);
  assert.equal(calls.length, 1);
  assert.ok(JSON.parse(calls[0].init.body).html.includes(String(code)), 'the emailed code is the stored one');
});

test('Reset Password tells the admin when the email cannot be sent, and changes nothing', opts, async () => {
  const before = await storedHash();
  fakeResend(422);
  const res = await call(users.resetUserPassword, { params: { id: String(userId) }, user: adminUser });
  assert.equal(res.status, 502);
  assert.match(res.body.message, /could not be sent/);
  assert.equal(await storedHash(), before);
});
