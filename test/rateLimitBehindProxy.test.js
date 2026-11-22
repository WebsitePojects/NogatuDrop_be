// Boots the real app with rate limiting on (in-memory store) and calls it the way nginx does:
// from loopback, with X-Forwarded-For carrying the client address. Public order POSTs use an
// empty body, so validation rejects them before any database write.
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_ENABLED = 'true';
process.env.REDIS_ENABLED = 'false';
delete process.env.TRUST_PROXY;

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');

const PUBLIC_ORDER_LIMIT = 10;
let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  // fetch keeps connections alive; close them or server.close() waits forever.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  // The DB pool is created when the app loads (GET routes query it); release it so the run exits.
  await require('../src/config/db').end();
});

function viaNginx(path, forwardedFor, method = 'POST') {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
}

async function statuses(count, request) {
  const result = [];
  for (let i = 0; i < count; i += 1) result.push((await request(i)).status);
  return result;
}

test('trust proxy defaults to loopback so req.ip is the client nginx forwarded', () => {
  assert.equal(app.get('trust proxy'), 'loopback');
});

test('each shopper gets their own public order allowance', async () => {
  const first = await statuses(PUBLIC_ORDER_LIMIT + 1, () => viaNginx('/api/v1/orders/public', '203.0.113.10'));
  assert.equal(first.slice(0, PUBLIC_ORDER_LIMIT).includes(429), false, `blocked early: ${first}`);
  assert.equal(first[PUBLIC_ORDER_LIMIT], 429, 'the 11th submission from one shopper is limited');

  const other = await viaNginx('/api/v1/orders/public', '203.0.113.20');
  assert.notEqual(other.status, 429, 'a different shopper is not blocked by the first one');
});

test('a spoofed X-Forwarded-For prefix cannot reset the allowance', async () => {
  // nginx appends the real address, so the client controls only the left part of the chain.
  const results = await statuses(PUBLIC_ORDER_LIMIT + 1, (i) => viaNginx('/api/v1/orders/public', `198.51.100.${i}, 203.0.113.30`));
  assert.equal(results[PUBLIC_ORDER_LIMIT], 429, `spoofing bypassed the limit: ${results}`);
});

test('browsing the influencer page and payment options does not spend the order allowance', async () => {
  const shopper = '203.0.113.40';
  const views = await statuses(PUBLIC_ORDER_LIMIT + 2, (i) => viaNginx(
    i % 2 ? '/api/v1/orders/public/payment-options' : '/api/v1/orders/public/influencer/kawoodee',
    shopper,
    'GET',
  ));
  assert.equal(views.includes(429), false, `GETs were limited: ${views}`);

  const order = await viaNginx('/api/v1/orders/public', shopper);
  assert.notEqual(order.status, 429, 'shopper can still submit an order after browsing');
});

// Working-day budgets (2026-11-23): staff counted per user, riders per Rider Link, member sign-in per username.
function call(path, { forwardedFor, method = 'GET', token, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': forwardedFor,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
  });
}

test('signed-in staff in one office each get their own budget, separate from the office IP', async () => {
  const jwt = require('jsonwebtoken');
  const env = require('../src/config/env');
  const office = '203.0.113.60';
  const anonymous = await statuses(601, () => call('/api/health', { forwardedFor: office }));
  assert.equal(anonymous.slice(0, 600).includes(429), false, 'anonymous callers get 600 per window');
  assert.equal(anonymous[600], 429, 'the 601st anonymous call from one IP is limited');

  const staff = jwt.sign({ id: 990001, role_slug: 'staff' }, env.JWT_SECRET, { expiresIn: '5m' });
  const res = await call('/api/health', { forwardedFor: office, token: staff });
  assert.equal(res.status, 200, 'a signed-in user behind the same IP is not blocked by it');
  assert.equal(res.headers.get('ratelimit-limit'), '900');

  const forged = await call('/api/health', { forwardedFor: office, token: `${staff}x` });
  assert.equal(forged.status, 429, 'a forged token counts against the IP');
});

test('rider pings are counted per Rider Link, not per (shared mobile) IP', async () => {
  const carrier = '203.0.113.70';
  const first = await statuses(121, () => call('/api/v1/tracking/ping/link-aaaaaaaa', { forwardedFor: carrier, method: 'POST' }));
  assert.equal(first.slice(0, 120).includes(429), false);
  assert.equal(first[120], 429, 'the 121st ping for one link is limited');
  const otherRider = await call('/api/v1/tracking/ping/link-bbbbbbbb', { forwardedFor: carrier, method: 'POST' });
  assert.notEqual(otherRider.status, 429, 'another rider on the same carrier IP still pings');
});

test('member sign-in: five failed tries lock that username, not the next member', async () => {
  const tries = await statuses(6, (i) => call('/api/v1/members/verify', {
    forwardedFor: `203.0.113.${80 + i}`, method: 'POST', body: { username: 'Juan01', password: `guess${i}` },
  }));
  assert.equal(tries.slice(0, 5).includes(429), false, `limited early: ${tries}`);
  assert.equal(tries[5], 429, 'a 6th try for the same username from any IP is limited');
  const other = await call('/api/v1/members/verify', { forwardedFor: '203.0.113.90', method: 'POST', body: { username: 'maria02', password: 'x' } });
  assert.notEqual(other.status, 429);
});
