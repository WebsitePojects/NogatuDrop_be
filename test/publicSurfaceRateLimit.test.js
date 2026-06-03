const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const appSource = readFileSync(join(__dirname, '../src/app.js'), 'utf8');

test('public order creation has a tighter abuse limit than the shared API budget', () => {
  assert.equal(appSource.includes('Too many public order attempts, please try again later.'), true);
  assert.equal(appSource.includes("app.use('/api/v1/orders/public', publicOrderLimiter);"), true);
  assert.match(appSource, /const publicOrderLimiter = createRateLimiter\(\{[\s\S]*max:\s*10,/);
});

test('public tracking lookups have a dedicated limiter to reduce enumeration pressure', () => {
  assert.equal(appSource.includes('Too many tracking lookups, please try again later.'), true);
  assert.equal(appSource.includes("app.use('/api/v1/tracking/public', publicTrackingLimiter);"), true);
  assert.match(appSource, /const publicTrackingLimiter = createRateLimiter\(\{[\s\S]*max:\s*60,/);
});

test('rate limiter creation keeps redis prefixes isolated per limiter family', () => {
  assert.equal(appSource.includes("function createRateLimiter(options, redisPrefix)"), true);
  assert.equal(appSource.includes("}, 'rl:api:');"), true);
  assert.equal(appSource.includes("}, 'rl:auth:');"), true);
  assert.equal(appSource.includes("}, 'rl:public-order:');"), true);
  assert.equal(appSource.includes("}, 'rl:public-tracking:');"), true);
});
