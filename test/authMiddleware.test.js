const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const authMiddleware = require('../src/middleware/authMiddleware');
const env = require('../src/config/env');

function runAuth(tokenPayload) {
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
    role: 5,
    role_slug: 'city_stockist',
    partner_id: 4,
    email: 'city@nogatu.com',
  });

  assert.equal(user.role_slug, 'city_stockist');
});
