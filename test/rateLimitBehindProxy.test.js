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
