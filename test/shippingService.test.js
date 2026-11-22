// Weight-and-zone shipping fee (Sir Dino, 2026-11-10; PROPOSAL_0026_SHIPPING_FEES). Pure parts only; the
// database path is covered by shippingCheckout.integration.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickShippingRate, shippingTier, philippineToday, addCalendarDays } = require('../src/services/shippingService');
const { assertWithinPublicItemLimit, PUBLIC_ORDER_MAX_ITEMS } = require('../src/services/publicOrderLimits');
const { ZONES, BRACKET_MAX_GRAMS, PRODUCT_WEIGHTS, PROVINCE_ZONES } = require('../scripts/addShippingRates');

const ratesFor = (zoneCode) => {
  const fees = ZONES.find(([code]) => code === zoneCode)[4];
  return BRACKET_MAX_GRAMS.map((max, i) => ({ max_weight_grams: max, fee: fees[i] }));
};
const cartGrams = (lines) => lines.reduce((sum, [sku, qty]) => sum + PRODUCT_WEIGHTS[sku] * qty, 0);

test('the proposal worked examples price exactly as the brief says', () => {
  // 5 Berry NAD+ + 2 Max Fuel + 3 Coffee Mix = 3.143 kg, Luzon -> 335
  const dino = cartGrams([['NOG-109', 5], ['NOG-108', 2], ['NOG-104', 3]]);
  assert.equal(dino, 3143);
  assert.equal(pickShippingRate(ratesFor('LUZON'), dino).fee, 335);
  // 5 Berry NAD+ = 1.45 kg, Visayas -> 240
  assert.equal(pickShippingRate(ratesFor('VISAYAS'), cartGrams([['NOG-109', 5]])).fee, 240);
  // 7 Chocolate Mix = 3.339 kg, NCR -> 240
  assert.equal(pickShippingRate(ratesFor('NCR'), cartGrams([['NOG-103', 7]])).fee, 240);
  // 10 Chocolate Mix = 4.77 kg (heaviest legal cart), Mindanao -> 445
  assert.equal(pickShippingRate(ratesFor('MINDANAO'), cartGrams([['NOG-103', 10]])).fee, 445);
});

test('NCR first bracket follows the proposal: 185 (Sir Dino, 2026-11-23)', () => {
  assert.equal(pickShippingRate(ratesFor('NCR'), 290).fee, 185);
});

test('bracket edges: exactly 3.000 kg is the first bracket, 3.001 kg the second, over 5 kg has no rate', () => {
  const ncr = ratesFor('NCR');
  assert.equal(pickShippingRate(ncr, 3000).max_weight_grams, 3000);
  assert.equal(pickShippingRate(ncr, 3001).max_weight_grams, 4000);
  assert.equal(pickShippingRate(ncr, 5000).max_weight_grams, 5000);
  assert.equal(pickShippingRate(ncr, 5001), null);
});

test('no 10-item cart of any mix can pass the 5 kg table', () => {
  const heaviest = Math.max(...Object.values(PRODUCT_WEIGHTS));
  assert.ok(heaviest * PUBLIC_ORDER_MAX_ITEMS <= 5000);
});

test('Palawan uses the Island rate with its own 5-24 day window', () => {
  const palawan = ZONES.find(([code]) => code === 'PALAWAN');
  const island = ZONES.find(([code]) => code === 'ISLAND');
  assert.deepEqual(palawan[4], island[4]);
  assert.deepEqual([palawan[2], palawan[3]], [5, 24]);
});

test('delivery dates are Philippine calendar days, whatever the server time zone', () => {
  // 2026-11-15 17:30 UTC is already 2026-11-16 01:30 in Manila.
  assert.equal(philippineToday(new Date('2026-11-15T17:30:00Z')), '2026-11-16');
  assert.equal(philippineToday(new Date('2026-11-15T15:59:00Z')), '2026-11-15');
  assert.equal(addCalendarDays('2026-11-16', 6), '2026-11-22');
  assert.equal(addCalendarDays('2026-12-28', 10), '2027-01-07');
  assert.equal(addCalendarDays('2028-02-27', 2), '2028-02-29');
});

test('a store order holds at most 10 items in total, any mix', () => {
  assert.equal(assertWithinPublicItemLimit([{ quantity: 5 }, { quantity: 2 }, { quantity: 3 }]), 10);
  assert.throws(
    () => assertWithinPublicItemLimit([{ quantity: 5 }, { quantity: 6 }]),
    (err) => err.statusCode === 400 && /at most 10 items in total \(this one has 11\)/.test(err.message)
  );
});

// Places as the database returns them: region_zone is the region's island group.
const NCR = { province_code: null, region_code: '130000000', region_zone: 'LUZON' };
const CALABARZON = { province_code: '041000000', region_code: '040000000', region_zone: 'LUZON' };
const CEBU = { province_code: '072200000', region_code: '070000000', region_zone: 'VISAYAS' };
const DAVAO_NORTE = { province_code: '112300000', region_code: '110000000', region_zone: 'MINDANAO' };
const DAVAO_SUR = { province_code: '112400000', region_code: '110000000', region_zone: 'MINDANAO' };
const COTABATO = { province_code: '124700000', region_code: '120000000', region_zone: 'MINDANAO' };
const SIQUIJOR = { province_code: '076100000', region_code: '070000000', region_zone: 'VISAYAS', province_zone: 'ISLAND' };
const PALAWAN = { province_code: '175300000', region_code: '170000000', region_zone: 'LUZON', province_zone: 'PALAWAN' };

test('from the NCR hubs the tiers are exactly the proposal table', () => {
  assert.equal(shippingTier(NCR, NCR), 'NCR');
  assert.equal(shippingTier(NCR, CALABARZON), 'LUZON');
  assert.equal(shippingTier(NCR, CEBU), 'VISAYAS');
  assert.equal(shippingTier(NCR, DAVAO_SUR), 'MINDANAO');
  assert.equal(shippingTier(NCR, SIQUIJOR), 'ISLAND');
  assert.equal(shippingTier(NCR, PALAWAN), 'PALAWAN');
  assert.equal(shippingTier(null, DAVAO_SUR), 'MINDANAO', 'a warehouse with no address is priced from NCR');
});

test('a Davao Stockist charges its neighbours the local rate, not the Mindanao rate', () => {
  assert.equal(shippingTier(DAVAO_NORTE, DAVAO_SUR), 'NCR', 'same region: local (185 up to 3 kg)');
  assert.equal(shippingTier(DAVAO_NORTE, COTABATO), 'LUZON', 'same island group: 230');
  assert.equal(shippingTier(DAVAO_NORTE, CEBU), 'VISAYAS', 'one island group away: 240');
  assert.equal(shippingTier(DAVAO_NORTE, NCR), 'MINDANAO', 'two island groups away: 265');
  assert.equal(shippingTier(CEBU, DAVAO_SUR), 'VISAYAS', 'Visayas to Mindanao is one group away');
  assert.equal(shippingTier(DAVAO_NORTE, SIQUIJOR), 'ISLAND');
  assert.equal(shippingTier(SIQUIJOR, SIQUIJOR), 'NCR', 'inside its own island province it is local');
});

test('an area with no zone has no tier (fail closed)', () => {
  assert.equal(shippingTier(NCR, { province_code: 'x', region_code: 'y', region_zone: null }), null);
});

test("Island provinces are J&T's list (2026-10-23 calculator), Palawan is Island by decision", () => {
  const island = Object.entries(PROVINCE_ZONES).filter(([, zone]) => zone === 'ISLAND').map(([code]) => String(code).padStart(9, '0')).sort();
  assert.deepEqual(island, ['020900000', '067900000', '076100000', '101800000', '144400000', '148100000',
    '150700000', '156600000', '157000000', '168500000', '175900000']);
  assert.equal(PROVINCE_ZONES[175300000], 'PALAWAN');
  for (const luzon of [174000000, 175100000, 175200000, '054100000', '052000000']) {
    assert.equal(PROVINCE_ZONES[luzon], undefined, `${luzon} is Luzon for J&T`);
  }
});
