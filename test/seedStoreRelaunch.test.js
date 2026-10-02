const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateConfig,
  evaluatePreflight,
  passwordProblems,
  maskEmail,
  maskAccountNumber,
  openingClientRef,
} = require('../scripts/seedStoreRelaunch');

const EXAMPLE_PATH = path.join(__dirname, '..', 'scripts', 'store-relaunch.config.example.json');
const NOW = new Date('2026-10-02T00:00:00Z');
const loadExample = () => JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
const problemsFor = (mutate) => {
  const config = loadExample();
  mutate(config);
  return validateConfig(config, NOW);
};

test('the committed example config is valid', () => {
  assert.deepEqual(validateConfig(loadExample(), NOW), []);
});

test('the example config contains no real-looking personal data', () => {
  const text = fs.readFileSync(EXAMPLE_PATH, 'utf8');
  assert.doesNotMatch(text, /@(gmail|yahoo|outlook|hotmail)\./i);
  for (const email of text.match(/[\w.+-]+@[\w.-]+/g) || []) assert.match(email, /@example\.com$/);
});

test('non-object configs are rejected outright', () => {
  for (const bad of [null, undefined, 'x', 42, []]) assert.deepEqual(validateConfig(bad, NOW), ['config must be a JSON object']);
});

test('every problem is reported at once, naming the field and not the value', () => {
  const problems = problemsFor((config) => {
    config.superAdmin.email = 'not-an-email';
    config.opening.quantity = 0;
    config.opening.expiry = '2020-01-01';
    config.centers[0].staff[0].email = 'also-bad';
    delete config.influencer.slug;
  });
  assert.equal(problems.length, 5, problems.join(' | '));
  assert.ok(problems.some((p) => p.startsWith('superAdmin.email')));
  assert.ok(problems.some((p) => p.startsWith('opening.quantity')));
  assert.ok(problems.some((p) => p.startsWith('opening.expiry')));
  assert.ok(problems.some((p) => p.startsWith('centers[0].staff[0].email')));
  assert.ok(problems.some((p) => p.startsWith('influencer.slug')));
  for (const problem of problems) assert.doesNotMatch(problem, /not-an-email|also-bad/);
});

test('missing top-level sections are each reported', () => {
  const problems = validateConfig({}, NOW);
  for (const section of ['superAdmin', 'product', 'opening', 'centers', 'influencer']) {
    assert.ok(problems.some((p) => p.startsWith(section)), `${section} missing from ${problems.join(' | ')}`);
  }
});

test('opening quantity must be a positive whole number within the receive limit', () => {
  for (const quantity of [0, -1, 1.5, '10000', null, 1000001]) {
    assert.ok(problemsFor((c) => { c.opening.quantity = quantity; }).some((p) => p.startsWith('opening.quantity')), String(quantity));
  }
  assert.deepEqual(problemsFor((c) => { c.opening.quantity = 1; }), []);
});

test('opening expiry must be a future ISO date', () => {
  for (const expiry of ['2026-10-02', '2026-10-01', '2027-02-30', '23/07/2027', undefined]) {
    assert.ok(problemsFor((c) => { c.opening.expiry = expiry; }).some((p) => p.startsWith('opening.expiry')), String(expiry));
  }
});

test('product needs a sku or a nameMatch', () => {
  assert.ok(problemsFor((c) => { c.product = {}; }).some((p) => p.startsWith('product')));
  assert.deepEqual(problemsFor((c) => { c.product = { sku: 'NKT-BND-001' }; }), []);
});

test('center keys, names, emails and accounts must be unique', () => {
  assert.ok(problemsFor((c) => { c.centers[1].key = c.centers[0].key; }).some((p) => /key duplicates/.test(p)));
  assert.ok(problemsFor((c) => { c.centers[1].businessName = c.centers[0].businessName.toUpperCase(); }).some((p) => /businessName duplicates/.test(p)));
  assert.ok(problemsFor((c) => { c.centers[1].staff[0].email = c.centers[0].staff[0].email.toUpperCase(); }).some((p) => /duplicates another email/.test(p)));
  assert.ok(problemsFor((c) => { c.centers[0].staff[0].email = c.superAdmin.email; }).some((p) => /duplicates another email/.test(p)));
  assert.ok(problemsFor((c) => { c.centers[0].paymentAccounts.push({ ...c.centers[0].paymentAccounts[0] }); }).some((p) => /duplicates another payment account/.test(p)));
});

test('center field, coordinate and staff rules', () => {
  assert.ok(problemsFor((c) => { c.centers[0].key = 'bad key'; }).some((p) => p.startsWith('centers[0].key')));
  assert.ok(problemsFor((c) => { delete c.centers[0].contactPhone; }).some((p) => p.startsWith('centers[0].contactPhone')));
  assert.ok(problemsFor((c) => { delete c.centers[0].lng; }).some((p) => /given together/.test(p)));
  assert.ok(problemsFor((c) => { c.centers[0].lat = 91; }).some((p) => p.startsWith('centers[0].lat')));
  assert.ok(problemsFor((c) => { c.centers[0].staff[0].passwordEnv = 'lower-case'; }).some((p) => p.startsWith('centers[0].staff[0].passwordEnv')));
  assert.ok(problemsFor((c) => { c.centers = []; }).some((p) => p.startsWith('centers')));
  assert.deepEqual(problemsFor((c) => { c.centers[0].staff = []; c.centers[0].paymentAccounts = []; }), []);
});

test('usernames from the management form are validated and unique across the config', () => {
  assert.deepEqual(problemsFor((c) => { c.superAdmin.username = '  DErfe '; }), [], 'trimmed and lowercased before checking');
  assert.ok(problemsFor((c) => { c.centers[0].staff[0].username = 'ab'; }).some((p) => p.startsWith('centers[0].staff[0].username')));
  assert.ok(problemsFor((c) => { c.centers[0].staff[0].username = 'has space'; }).some((p) => p.startsWith('centers[0].staff[0].username')));
  assert.ok(problemsFor((c) => { c.centers[0].staff[0].username = 'x@y.com'; }).some((p) => p.startsWith('centers[0].staff[0].username')));
  assert.ok(problemsFor((c) => { c.centers[1].staff[0].username = c.superAdmin.username.toUpperCase(); }).some((p) => /duplicates another username/.test(p)));
  assert.deepEqual(problemsFor((c) => { delete c.centers[0].staff[0].username; }), [], 'username stays optional');
});

test('a center may adopt an existing warehouse by id, once', () => {
  assert.deepEqual(problemsFor((c) => { c.centers[1].adoptWarehouseId = 16; }), []);
  assert.ok(problemsFor((c) => { c.centers[1].adoptWarehouseId = 0; }).some((p) => p.startsWith('centers[1].adoptWarehouseId')));
  assert.ok(problemsFor((c) => { c.centers[1].adoptWarehouseId = '16'; }).some((p) => p.startsWith('centers[1].adoptWarehouseId')));
  assert.ok(problemsFor((c) => { c.centers[0].adoptWarehouseId = 16; c.centers[1].adoptWarehouseId = 16; }).some((p) => /used by another center/.test(p)));
});

test('center key + batch must fit the 64-char client_ref column', () => {
  assert.ok(problemsFor((c) => { c.opening.batch = 'B'.repeat(50); c.centers[0].key = 'K'.repeat(20); }).some((p) => /client reference longer/.test(p)));
  assert.equal(openingClientRef('CALOOCAN', ' B01 '), 'seed-opening-CALOOCAN-B01');
});

test('schema preflight lists every missing prerequisite with the fix', () => {
  const problems = evaluatePreflight([]).problems.join('\n');
  assert.match(problems, /addStoreCenters\.js/);
  assert.match(problems, /influencer_checkout_2026_09_10\.sql/);
  assert.match(problems, /addGrnClientRef\.js/);
  assert.match(problems, /addUserWarehouse\.js/);
  assert.match(problems, /addUsername\.js/);
});

test('schema preflight passes when the center enums and tables exist, and reports optional columns', () => {
  const snapshot = [
    { tableName: 'partners', columnName: 'stockist_level', columnType: "enum('provincial_stockist','city_stockist','center')" },
    { tableName: 'warehouses', columnName: 'type', columnType: "enum('manufacturer','region','city','center')" },
    { tableName: 'goods_receipts', columnName: 'client_ref', columnType: 'varchar(64)' },
    { tableName: 'users', columnName: 'warehouse_id', columnType: 'bigint(20) unsigned' },
    { tableName: 'users', columnName: 'username', columnType: 'varchar(50)' },
    { tableName: 'influencer_links', columnName: 'slug', columnType: 'varchar(80)' },
  ];
  const result = evaluatePreflight(snapshot);
  assert.deepEqual(result.problems, []);
  assert.equal(result.hasWarehouseOperatingHours, false);
  assert.equal(result.hasInfluencerDisplayName, false);

  const withOptional = evaluatePreflight([
    ...snapshot,
    { tableName: 'warehouses', columnName: 'operating_hours', columnType: 'varchar(150)' },
    { tableName: 'influencer_links', columnName: 'display_name', columnType: 'varchar(100)' },
  ]);
  assert.equal(withOptional.hasWarehouseOperatingHours, true);
  assert.equal(withOptional.hasInfluencerDisplayName, true);
});

test('a center enum on only one of the two tables still fails preflight', () => {
  const problems = evaluatePreflight([
    { tableName: 'partners', columnName: 'stockist_level', columnType: "enum('provincial_stockist','city_stockist','center')" },
    { tableName: 'warehouses', columnName: 'type', columnType: "enum('manufacturer','region','city')" },
  ]).problems;
  assert.ok(problems.some((p) => /addStoreCenters/.test(p)));
});

test('passwords are only demanded for new users, must be set and long enough', () => {
  assert.deepEqual(passwordProblems(new Set(), {}), []);
  assert.equal(passwordProblems(new Set(['A_PASS']), {}).length, 1);
  assert.equal(passwordProblems(new Set(['A_PASS']), { A_PASS: 'short' }).length, 1);
  assert.deepEqual(passwordProblems(new Set(['A_PASS']), { A_PASS: 'long-enough-1' }), []);
  for (const message of passwordProblems(new Set(['A_PASS']), { A_PASS: 'short' })) assert.doesNotMatch(message, /short$/);
});

test('log masks never expose a full email or account number', () => {
  assert.equal(maskEmail('juan.dela.cruz@example.com'), 'ju***@example.com');
  assert.equal(maskAccountNumber('000000001234'), '****1234');
  assert.doesNotMatch(maskAccountNumber('000000001234'), /0000/);
});
