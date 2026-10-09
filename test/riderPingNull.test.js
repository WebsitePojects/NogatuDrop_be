const test = require('node:test');
const assert = require('node:assert/strict');
const { validationResult } = require('express-validator');

// Phones report no speed/accuracy when standing still; the rider page sends null. Those pings were refused.
test('a rider ping with null speed and accuracy passes validation; a non-number does not', async () => {
  const router = require('../src/routes/tracking');
  const layer = router.stack.find((l) => l.route?.path === '/ping/:token' && l.route.methods.post);
  const chains = layer.route.stack.map((s) => s.handle).filter((h) => typeof h.run === 'function');
  const ok = { params: { token: 'abc' }, body: { lat: 14.6, lng: 121.0, speed_kmh: null, accuracy_meters: null } };
  for (const chain of chains) await chain.run(ok);
  assert.deepEqual(validationResult(ok).array(), []);
  const bad = { params: { token: 'abc' }, body: { lat: 14.6, lng: 121.0, speed_kmh: 'fast' } };
  for (const chain of chains) await chain.run(bad);
  assert.equal(validationResult(bad).array()[0].msg, 'speed_kmh must be a number');
});
