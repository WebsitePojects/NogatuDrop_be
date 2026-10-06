// The route tests below load the real orders router, which loads the Redis client. Use its in-memory
// fallback so the test never opens a network connection.
process.env.REDIS_ENABLED = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { validationResult } = require('express-validator');

const {
  addressPartsValidators,
  coordinatePairValidator,
  readCoordinates,
  hasAddressParts,
  composeAddressText,
  resolveAddress,
} = require('../src/services/addressInput');
const { addressPartsJoins, addressPartsSelect } = require('../src/utils/addressPartsSql');
const { OUTSIDE_PH_MESSAGE } = require('../src/utils/phBounds');

const QUEZON_CITY_BARANGAY = '137404001';

/** Runs validator chains over a body and returns { field: message } for each failing field. */
async function validationErrors(chains, body) {
  const req = { body, headers: {}, query: {}, params: {}, cookies: {} };
  await Promise.all(chains.flat().map((chain) => chain.run(req)));
  return Object.fromEntries(validationResult(req).array().map((e) => [e.path, e.msg]));
}

const goodAddress = { address_line: '12 Rizal St.', barangay_code: QUEZON_CITY_BARANGAY, postal_code: '1100' };

// ---- composeAddressText ----------------------------------------------------------------------

test('composeAddressText joins street, barangay, city, province-or-region and postal code in order', () => {
  assert.equal(
    composeAddressText({ addressLine: '12 Rizal St.', barangay: 'Alicia', city: 'Quezon City', provinceOrRegion: 'NCR', postalCode: '1100' }),
    '12 Rizal St., Alicia, Quezon City, NCR, 1100'
  );
});

test('composeAddressText skips parts that are not set', () => {
  assert.equal(
    composeAddressText({ addressLine: 'Stall 4', barangay: 'Amihan', city: 'Quezon City', provinceOrRegion: 'NCR', postalCode: null }),
    'Stall 4, Amihan, Quezon City, NCR'
  );
});

test('composeAddressText shortens the street, never the place names, when the text must fit a column', () => {
  const text = composeAddressText(
    { addressLine: 'A very long street description '.repeat(10), barangay: 'Alicia', city: 'Quezon City', provinceOrRegion: 'NCR', postalCode: '1100' },
    { maxLength: 100 }
  );
  assert.equal(text.length, 100);
  assert.ok(text.endsWith(', Alicia, Quezon City, NCR, 1100'), text);
  assert.ok(text.includes('…'));
});

test('composeAddressText leaves text that already fits untouched', () => {
  const parts = { addressLine: '1 Main', barangay: 'B', city: 'C', provinceOrRegion: 'P', postalCode: '1000' };
  assert.equal(composeAddressText(parts, { maxLength: 200 }), '1 Main, B, C, P, 1000');
});

// ---- resolveAddress --------------------------------------------------------------------------

const fakeDb = (rows) => {
  const calls = [];
  return { calls, async execute(sql, params) { calls.push({ sql, params }); return [rows]; } };
};

test('resolveAddress composes the legacy text and region name from the PSGC names, binding the code as a parameter', async () => {
  const db = fakeDb([{ barangay: 'Alicia', city: 'Quezon City', province: null, region: 'NCR' }]);
  const address = await resolveAddress(db, { address_line: '  12   Rizal St. ', barangay_code: QUEZON_CITY_BARANGAY, postal_code: '1100' });
  assert.deepEqual(address, {
    addressLine: '12 Rizal St.',
    barangayCode: QUEZON_CITY_BARANGAY,
    postalCode: '1100',
    text: '12 Rizal St., Alicia, Quezon City, NCR, 1100',
    regionName: 'NCR',
  });
  assert.deepEqual(db.calls[0].params, [QUEZON_CITY_BARANGAY]);
  assert.ok(!db.calls[0].sql.includes(QUEZON_CITY_BARANGAY));
});

test('resolveAddress prefers the province name over the region name', async () => {
  const db = fakeDb([{ barangay: 'Cabadiangan', city: 'Alcantara', province: 'Cebu', region: 'Central Visayas' }]);
  const address = await resolveAddress(db, { address_line: 'Road 5', barangay_code: '072201001' });
  assert.equal(address.text, 'Road 5, Cabadiangan, Alcantara, Cebu');
  assert.equal(address.postalCode, null);
});

test('resolveAddress fails closed on a barangay that is not in the PSGC list', async () => {
  await assert.rejects(
    resolveAddress(fakeDb([]), { address_line: 'Road 5', barangay_code: '999999999' }),
    (err) => err.statusCode === 400 && /choose the barangay/i.test(err.message)
  );
});

// ---- validators ------------------------------------------------------------------------------

test('create validators accept a complete address and reject each bad part with its own message', async () => {
  const create = addressPartsValidators({ required: true });
  assert.deepEqual(await validationErrors(create, goodAddress), {});
  assert.match((await validationErrors(create, { ...goodAddress, barangay_code: '12345' })).barangay_code, /choose the barangay/i);
  assert.match((await validationErrors(create, { ...goodAddress, barangay_code: undefined })).barangay_code, /choose the barangay/i);
  assert.match((await validationErrors(create, { ...goodAddress, postal_code: '11A0' })).postal_code, /4 digits/);
  assert.match((await validationErrors(create, { ...goodAddress, postal_code: '110' })).postal_code, /4 digits/);
  assert.match((await validationErrors(create, { ...goodAddress, address_line: 'ab' })).address_line, /street/i);
  assert.match((await validationErrors(create, { ...goodAddress, address_line: 'x'.repeat(201) })).address_line, /street/i);
  assert.match((await validationErrors(create, { ...goodAddress, address_line: undefined })).address_line, /street/i);
});

test('a blank postal code is allowed', async () => {
  assert.deepEqual(await validationErrors(addressPartsValidators({ required: true }), { ...goodAddress, postal_code: '' }), {});
});

test('update validators allow leaving the address alone but not sending half of it', async () => {
  const update = addressPartsValidators({ required: false });
  assert.deepEqual(await validationErrors(update, { manager_name: 'Only this' }), {});
  assert.deepEqual(await validationErrors(update, goodAddress), {});
  assert.match((await validationErrors(update, { address_line: '12 Rizal St.' })).barangay_code, /together/i);
  assert.match((await validationErrors(update, { barangay_code: QUEZON_CITY_BARANGAY })).barangay_code, /together/i);
  assert.match((await validationErrors(update, { ...goodAddress, barangay_code: 'abc' })).barangay_code, /choose the barangay/i);
});

test('the pin must be a pair, inside the Philippines, and numeric', async () => {
  const pin = [coordinatePairValidator('lat', 'lng')];
  assert.deepEqual(await validationErrors(pin, {}), {}, 'no pin is fine');
  assert.deepEqual(await validationErrors(pin, { lat: null, lng: null }), {}, 'explicit nulls clear the pin');
  assert.deepEqual(await validationErrors(pin, { lat: '', lng: '' }), {});
  assert.deepEqual(await validationErrors(pin, { lat: 14.65, lng: 121.05 }), {});
  assert.deepEqual(await validationErrors(pin, { lat: '10.3157', lng: '123.8854' }), {}, 'numeric strings are fine');
  assert.equal((await validationErrors(pin, { lat: 0, lng: 0 })).lat, OUTSIDE_PH_MESSAGE);
  assert.equal((await validationErrors(pin, { lat: 48.85, lng: 2.35 })).lat, OUTSIDE_PH_MESSAGE);
  assert.equal((await validationErrors(pin, { lat: 121.05, lng: 14.65 })).lat, OUTSIDE_PH_MESSAGE, 'swapped lat/lng');
  assert.match((await validationErrors(pin, { lat: 14.65 })).lat, /both latitude and longitude/i);
  assert.match((await validationErrors(pin, { lng: 121.05 })).lat, /both latitude and longitude/i);
  assert.match((await validationErrors(pin, { lat: 'abc', lng: 'def' })).lat, /must be numbers/i);
});

// ---- small readers ---------------------------------------------------------------------------

test('readCoordinates returns numbers for a pin and nulls for none', () => {
  assert.deepEqual(readCoordinates({ lat: '14.5', lng: '121.0' }), { lat: 14.5, lng: 121 });
  assert.deepEqual(readCoordinates({ lat: null, lng: null }), { lat: null, lng: null });
  assert.deepEqual(readCoordinates({}), { lat: null, lng: null });
  assert.deepEqual(readCoordinates({ customer_lat: 1.5, customer_lng: 2.5 }, 'customer_lat', 'customer_lng'), { lat: 1.5, lng: 2.5 });
});

test('hasAddressParts is true only when both the street and the barangay are sent', () => {
  assert.equal(hasAddressParts(goodAddress), true);
  assert.equal(hasAddressParts({ address_line: 'x' }), false);
  assert.equal(hasAddressParts({ barangay_code: QUEZON_CITY_BARANGAY }), false);
  assert.equal(hasAddressParts({}), false);
});

// ---- read-side SQL ---------------------------------------------------------------------------

test('address SQL fragments return the picker codes and compose the display text with a legacy fallback', () => {
  const select = addressPartsSelect('w', 'location');
  assert.match(select, /w\.address_line, w\.barangay_code, w\.postal_code/);
  assert.match(select, /AS address_region_code/);
  assert.match(select, /AS address_province_code/);
  assert.match(select, /AS address_city_code/);
  assert.match(select, /WHEN w\.barangay_code IS NOT NULL/);
  assert.match(select, /ELSE w\.location END AS address_display/);
  assert.match(addressPartsJoins('w'), /ph_barangays addr_brgy ON addr_brgy\.code = w\.barangay_code/);
});

test('address SQL fragments refuse anything but plain identifiers', () => {
  assert.throws(() => addressPartsSelect('w; DROP TABLE x', 'location'), /invalid identifier/);
  assert.throws(() => addressPartsSelect('w', 'location) --'), /invalid identifier/);
  assert.throws(() => addressPartsJoins("w' OR '1'='1"), /invalid identifier/);
});

// ---- the real public checkout route ----------------------------------------------------------

/** The real /orders router with the app's error handler; validation fails before any database call. */
async function withOrdersRouter(run) {
  const ordersRouter = require('../src/routes/orders');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/orders', ordersRouter);
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/v1/orders/public`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const publicOrder = {
  customer_first_name: 'Maria',
  customer_last_name: 'Cruz',
  customer_address_line: '12 Rizal St.',
  customer_barangay_code: QUEZON_CITY_BARANGAY,
  items: [{ product_id: 1, quantity: 1 }],
};
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('public checkout refuses a pin outside the Philippines with the shared message', async () => {
  await withOrdersRouter(async (url) => {
    for (const pin of [{ lat: 51.5, lng: -0.12 }, { lat: 0, lng: 0 }, { lat: 25.03, lng: 121.56 }]) {
      const res = await post(url, { ...publicOrder, customer_lat: pin.lat, customer_lng: pin.lng });
      const json = await res.json();
      assert.equal(res.status, 400, `pin ${JSON.stringify(pin)}`);
      assert.match(json.message, new RegExp(OUTSIDE_PH_MESSAGE));
    }
  });
});

test('public checkout refuses half a pin and non-numeric pins', async () => {
  await withOrdersRouter(async (url) => {
    const half = await post(url, { ...publicOrder, customer_lat: 14.65 });
    assert.equal(half.status, 400);
    assert.match((await half.json()).message, /both latitude and longitude/i);

    const text = await post(url, { ...publicOrder, customer_lat: 'north', customer_lng: 'east' });
    assert.equal(text.status, 400);
    assert.match((await text.json()).message, /must be numbers/i);
  });
});
