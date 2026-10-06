const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cache = require('../src/services/cacheService');
const { getRoadRoute, estimateArrival } = require('../src/services/routeService');
const { isInsidePhilippines } = require('../src/utils/phBounds');

const CALOOCAN = { lat: 14.7445793, lng: 121.0634213 };
const BUYER = { lat: 14.7487, lng: 121.0495 };

function osrmResponse() {
  return {
    ok: true,
    json: async () => ({
      code: 'Ok',
      routes: [{ distance: 2107.3, duration: 339.4, geometry: { coordinates: [[121.0634, 14.7444], [121.0601, 14.7444], [121.0495, 14.7487]] } }],
    }),
  };
}

test('a road route comes back as [lat, lng] points along the road and is cached', async (t) => {
  const store = new Map();
  t.mock.method(cache, 'get', async (key) => store.get(key) ?? null);
  t.mock.method(cache, 'set', async (key, value) => { store.set(key, value); });
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; assert.match(url, /\/route\/v1\/driving\/121\.0634,14\.7446;121\.0495,14\.7487\?/); return osrmResponse(); };

  const first = await getRoadRoute(CALOOCAN, BUYER, { fetchImpl });
  assert.equal(first.source, 'road');
  assert.deepEqual(first.coordinates[0], [14.7444, 121.0634], 'GeoJSON [lng,lat] is flipped for Leaflet');
  assert.equal(first.distance_m, 2107);
  const second = await getRoadRoute({ lat: 14.74458, lng: 121.06342 }, BUYER, { fetchImpl });
  assert.equal(calls, 1, 'a nearby start (same ~11 m cell) reuses the cached route');
  assert.deepEqual(second, first);
});

test('when routing is down the map still gets a straight, clearly approximate line, and it is not cached', async (t) => {
  const store = new Map();
  t.mock.method(cache, 'get', async () => null);
  t.mock.method(cache, 'set', async (key, value) => { store.set(key, value); });
  const route = await getRoadRoute(CALOOCAN, BUYER, { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(route.source, 'approximate');
  assert.equal(route.coordinates.length, 2);
  assert.ok(route.distance_m > 1000 && route.duration_s > 0);
  assert.equal(store.size, 0, 'a failure is retried next time, not remembered');
});

test('a cache outage costs a routing call, never an error', async (t) => {
  t.mock.method(cache, 'get', async () => { throw new Error('redis down'); });
  t.mock.method(cache, 'set', async () => { throw new Error('redis down'); });
  const route = await getRoadRoute(CALOOCAN, BUYER, { fetchImpl: async () => osrmResponse() });
  assert.equal(route.source, 'road');
});

test('arrival windows widen with traffic and depend on the vehicle', () => {
  const moto = estimateArrival(600, 'motorcycle');
  const truck = estimateArrival(600, 'truck');
  assert.ok(moto.min_minutes < moto.max_minutes);
  assert.ok(truck.min_minutes > moto.min_minutes, 'a truck is slower than a motorcycle in the city');
  assert.deepEqual(estimateArrival(600, 'hovercraft'), moto, 'unknown vehicles are treated as motorcycles');
  assert.equal(estimateArrival(0).min_minutes, 1, 'never promises zero minutes');
});

test('the Philippines check accepts the whole archipelago and refuses common bad pins', () => {
  for (const [name, lat, lng] of [['Manila', 14.5995, 120.9842], ['Batanes', 20.45, 121.97], ['Puerto Princesa', 9.74, 118.73],
    ['Tawi-Tawi', 5.05, 119.77], ['Davao', 7.07, 125.61], ['Balabac', 7.98, 117.06]]) {
    assert.equal(isInsidePhilippines(lat, lng), true, name);
  }
  for (const [name, lat, lng] of [['null island', 0, 0], ['lat/lng swapped', 121.0, 14.6], ['Kota Kinabalu (Sabah)', 5.98, 116.07],
    ['Taipei', 25.03, 121.56], ['Ho Chi Minh', 10.82, 106.63], ['not a number', 'abc', 121]]) {
    assert.equal(isInsidePhilippines(lat, lng), false, name);
  }
});

test('rider pings: outside-PH points are refused and a fast phone cannot flood the table', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/trackingController.js'), 'utf8');
  const block = source.slice(source.indexOf('const postPingByToken'), source.indexOf('const postPing ='));
  assert.match(block, /if \(!isInsidePhilippines\(lat, lng\)\) throw ApiError\.badRequest\(OUTSIDE_PH_MESSAGE\)/);
  assert.match(block, /pinged_at > NOW\(\) - INTERVAL \? SECOND/);
  assert.match(block, /if \(recent\.length === 0\)/);
});

test('creating a Rider Link twice at once yields one link: the order row is locked and re-checked', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/deliveryTokenController.js'), 'utf8');
  const block = source.slice(source.indexOf('const generateDeliveryLink'), source.indexOf('const getLatestDeliveryLinkForOrder'));
  const lock = block.indexOf("SELECT id FROM orders WHERE id = ? FOR UPDATE");
  const recheck = block.indexOf('getLatestActiveToken(order_id, conn)');
  const insert = block.indexOf('INSERT INTO delivery_tokens');
  assert.ok(lock > 0 && recheck > lock && insert > recheck, 'lock, then re-check, then insert');
});

test('public tracking never sends the road line to the buyer (it ends at their door)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/controllers/trackingController.js'), 'utf8');
  const block = source.slice(source.indexOf('const getPublicTracking'), source.indexOf('function isPaymentDue'));
  assert.doesNotMatch(block, /(remaining|planned|travelled|destination):|\.coordinates/);
  assert.match(block, /eta_window: arrivalWindow/);
});

test('a rider ping with no speed or accuracy reading (null) is accepted', async () => {
  const { validationResult } = require('express-validator');
  const router = require('../src/routes/tracking');
  const layer = router.stack.find((l) => l.route?.path === '/ping/:token' && l.route.methods.post);
  const chains = layer.route.stack.map((s) => s.handle).filter((h) => typeof h.run === 'function');
  const req = { params: { token: 'abc' }, body: { lat: 14.6, lng: 121.0, speed_kmh: null, accuracy_meters: null } };
  for (const chain of chains) await chain.run(req);
  assert.deepEqual(validationResult(req).array(), []);
  const bad = { params: { token: 'abc' }, body: { lat: 14.6, lng: 121.0, speed_kmh: 'fast' } };
  for (const chain of chains) await chain.run(bad);
  assert.equal(validationResult(bad).array()[0].msg, 'speed_kmh must be a number');
});
