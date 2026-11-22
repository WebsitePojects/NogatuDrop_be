// Member discount needs a signed pass from a real nogatualliance.com sign-in, never a bare username (2026-11-23).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret-unit-test-secret-1234';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const env = require('../src/config/env');
const { signMemberPass, readMemberPass } = require('../src/services/memberDiscount');

test('a pass we signed reads back as that member', () => {
  const pass = signMemberPass({ uid: '123', username: 'juan01' });
  assert.deepEqual(readMemberPass(pass), { uid: '123', username: 'juan01' });
});

test('a staff login token, a forged pass and an expired pass are all refused', () => {
  const staffToken = jwt.sign({ id: 1, role_slug: 'super_admin', uid: '1', username: 'x' }, env.JWT_SECRET);
  const forged = jwt.sign({ uid: '9', username: 'someone' }, 'guessed-key', { audience: 'nogatu-store-member-discount' });
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"uid":"9","username":"a"}').toString('base64url')}.`;
  for (const bad of [staffToken, forged, unsigned, 'juan01', '']) {
    assert.throws(() => readMemberPass(bad), (err) => err.statusCode === 400 && /member sign-in has expired/.test(err.message));
  }
});

test('the order route refuses a bare member username', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/routes/orders.js'), 'utf8');
  assert.match(source, /bodyValidator\('member_username'\)\.not\(\)\.exists\(\)/);
});
