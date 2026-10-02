const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readPublicCustomer, assertBarangayExists, PERSON_NAME_PATTERN, NAME_SUFFIXES,
} = require('../src/services/publicCustomerInput');
const {
  orderCustomerJoins, orderCustomerNameSql, orderCustomerAddressSql, orderIsPublicSql,
} = require('../src/utils/orderCustomerSql');
const { listProvinces, listBarangays, listRegions, NCR_REGION_CODE } = require('../src/services/phLocationService');
const { chunk } = require('../scripts/addPhLocations');

const regions = require('../data/psgc/regions.json');
const provinces = require('../data/psgc/provinces.json');
const cities = require('../data/psgc/cities.json');
const barangays = require('../data/psgc/barangays.json');

test('readPublicCustomer trims parts, collapses spaces and stores blank optional parts as NULL', () => {
  const customer = readPublicCustomer({
    customer_first_name: '  Maria   Clara ',
    customer_middle_name: '   ',
    customer_last_name: 'Dela Cruz',
    customer_name_suffix: '',
    customer_address_line: ' 12  Rizal St. ',
    customer_barangay_code: '137501001',
    customer_postal_code: undefined,
  });
  assert.deepEqual(customer, {
    firstName: 'Maria Clara',
    middleName: null,
    lastName: 'Dela Cruz',
    suffix: null,
    addressLine: '12 Rizal St.',
    barangayCode: '137501001',
    postalCode: null,
  });
});

test('person names accept Filipino spellings and refuse digits and markup', () => {
  for (const name of ['José', 'Ñiño', "D'Souza", 'Dela Cruz-Santos', 'Ma. Teresa', 'O’Neil']) {
    assert.ok(PERSON_NAME_PATTERN.test(name), `${name} should be accepted`);
  }
  for (const name of ['QA123', '<script>', '-Leading', ' ', '', 'a@b']) {
    assert.ok(!PERSON_NAME_PATTERN.test(name), `${name} should be refused`);
  }
  assert.deepEqual(NAME_SUFFIXES, ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V']);
});

test('assertBarangayExists fails closed on an unknown code and binds the code as a parameter', async () => {
  const calls = [];
  const db = (rows) => ({ async execute(sql, params) { calls.push({ sql, params }); return [rows]; } });
  await assert.doesNotReject(assertBarangayExists(db([{ code: '137501001' }]), '137501001'));
  await assert.rejects(assertBarangayExists(db([]), '999999999'), (err) => err.statusCode === 400);
  assert.ok(calls.every((c) => !c.sql.includes('9999') && c.params.length === 1));
});

test('order customer SQL composes from parts and falls back to the old single-text columns', () => {
  const name = orderCustomerNameSql('o');
  const address = orderCustomerAddressSql('o');
  assert.match(name, /WHEN o\.customer_last_name IS NOT NULL/);
  assert.match(name, /ELSE o\.customer_name END/);
  assert.match(address, /WHEN o\.customer_barangay_code IS NOT NULL/);
  assert.match(address, /COALESCE\(cust_prov\.name, cust_reg\.name\)/, 'cities outside a province show their region');
  assert.match(address, /ELSE o\.customer_address END/);
  assert.match(orderCustomerJoins('o'), /COALESCE\(cust_prov\.region_code, cust_city\.region_code\)/);
  assert.match(orderIsPublicSql('o'), /o\.customer_last_name IS NOT NULL/, 'new orders without customer_name still count as public');
});

test('order customer SQL refuses anything but a plain alias', () => {
  for (const alias of ['o; DROP TABLE orders', 'o.x', '1o', '']) {
    assert.throws(() => orderCustomerNameSql(alias), /invalid table alias/);
    assert.throws(() => orderCustomerJoins(alias), /invalid table alias/);
  }
});

test('Metro Manila has no provinces, so the picker offers its cities under "Metro Manila"', async () => {
  const db = {
    async execute(sql) {
      if (sql.includes('FROM ph_provinces')) return [[]];
      return [[{ independent: 17 }]];
    },
  };
  assert.deepEqual(await listProvinces(db, NCR_REGION_CODE), {
    provinces: [], independent_cities: 17, independent_label: 'Metro Manila',
  });
  const other = await listProvinces(db, '090000000');
  assert.equal(other.independent_label, 'Cities not under a province');
});

test('barangays sort by number, not by text', async () => {
  const db = { async execute() { return [[{ name: 'Barangay 10' }, { name: 'Barangay 2' }, { name: 'Barangay 1' }, { name: 'Bagong Silang' }]]; } };
  assert.deepEqual((await listBarangays(db, '137501000')).map((b) => b.name), ['Bagong Silang', 'Barangay 1', 'Barangay 2', 'Barangay 10']);
});

test('regions list asks the database for Metro Manila first', async () => {
  let seen;
  await listRegions({ async execute(sql, params) { seen = { sql, params }; return [[]]; } });
  assert.match(seen.sql, /ORDER BY code = \? DESC, name/);
  assert.deepEqual(seen.params, [NCR_REGION_CODE]);
});

test('seed batches never exceed the batch size and keep every row', () => {
  const rows = Array.from({ length: 2501 }, (_, i) => [i]);
  const batches = chunk(rows, 1000);
  assert.deepEqual(batches.map((b) => b.length), [1000, 1000, 501]);
  assert.equal(batches.flat().length, rows.length);
});

test('vendored PSGC data is internally consistent', () => {
  const regionCodes = new Set(regions.map((r) => r[0]));
  const provinceCodes = new Set(provinces.map((p) => p[0]));
  const cityCodes = new Set(cities.map((c) => c[0]));
  assert.equal(regions.length, 17);
  for (const [code, name, regionCode] of provinces) {
    assert.ok(/^\d{9}$/.test(code) && name && regionCodes.has(regionCode), `province ${code}`);
  }
  for (const [code, name, provinceCode, regionCode] of cities) {
    assert.ok(/^\d{9}$/.test(code) && name, `city ${code}`);
    assert.ok((provinceCode === null) !== (regionCode === null), `city ${code} must have exactly one parent`);
    assert.ok(provinceCode === null || provinceCodes.has(provinceCode), `city ${code} province`);
    assert.ok(regionCode === null || regionCodes.has(regionCode), `city ${code} region`);
  }
  const brgyCodes = new Set();
  for (const [code, name, cityCode] of barangays) {
    assert.ok(/^\d{9}$/.test(code) && name && cityCodes.has(cityCode), `barangay ${code}`);
    brgyCodes.add(code);
  }
  assert.equal(brgyCodes.size, barangays.length, 'barangay codes are unique');
  assert.ok(cities.some((c) => c[1] === 'City of Caloocan' && c[3] === NCR_REGION_CODE));
});
