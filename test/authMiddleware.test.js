const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { createAuthMiddleware } = require('../src/middleware/authMiddleware');
const env = require('../src/config/env');

function runAuth(tokenPayload, { sessionIsActive = async () => true } = {}) {
  const authMiddleware = createAuthMiddleware({ sessionIsActive });
  return new Promise((resolve, reject) => {
    const token = jwt.sign(tokenPayload, env.JWT_SECRET);
    const req = {
      headers: {
        authorization: `Bearer ${token}`,
      },
    };

    authMiddleware(req, {}, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(req.user);
    });
  });
}

test('auth middleware normalizes legacy admin slug into stockist role', async () => {
  const user = await runAuth({
    id: 99,
    sid: 'session-99',
    role: 2,
    role_slug: 'admin',
    partner_id: 4,
    email: 'admin@nogatu.com',
  });

  assert.equal(user.role_slug, 'provincial_stockist');
});

test('auth middleware keeps modern stockist role slugs unchanged', async () => {
  const user = await runAuth({
    id: 100,
    sid: 'session-100',
    role: 5,
    role_slug: 'city_stockist',
    partner_id: 4,
    email: 'city@nogatu.com',
  });

  assert.equal(user.role_slug, 'city_stockist');
});

test('an access token without a session id is rejected (issued before sessions existed)', async () => {
  await assert.rejects(runAuth({ id: 1, role_slug: 'staff', partner_id: 4 }), /expired/);
});

test('an ended session is rejected even though the access token itself is still valid', async () => {
  const seen = [];
  await assert.rejects(
    runAuth({ id: 7, sid: 'ended', role_slug: 'staff' }, { sessionIsActive: async (owner) => { seen.push(owner); return false; } }),
    /session has ended/
  );
  assert.deepEqual(seen, [{ sessionId: 'ended', userId: 7 }]);
});

test('a live session passes and exposes the session id on req.user', async () => {
  const user = await runAuth({ id: 8, sid: 'live', role_slug: 'staff', partner_id: 2 });
  assert.equal(user.sid, 'live');
  assert.equal(user.id, 8);
});
