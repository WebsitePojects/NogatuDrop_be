const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AFFILIATION_HIERARCHY_FIXTURE,
  flattenHierarchyAccounts,
} = require('../scripts/affiliationHierarchyFixture');

test('affiliation hierarchy fixture defines two provincial branches with two city and one mobile child each', () => {
  assert.equal(AFFILIATION_HIERARCHY_FIXTURE.length, 2);

  for (const branch of AFFILIATION_HIERARCHY_FIXTURE) {
    assert.equal(branch.cities.length, 2);
    for (const unit of branch.cities) {
      assert.ok(unit.city.email);
      assert.ok(unit.mobile.email);
    }
  }
});

test('flattened hierarchy accounts preserve parent references for city and mobile users', () => {
  const accounts = flattenHierarchyAccounts();
  const provincialAccounts = accounts.filter((account) => account.role === 'provincial_stockist');
  const cityAccounts = accounts.filter((account) => account.role === 'city_stockist');
  const mobileAccounts = accounts.filter((account) => account.role === 'mobile_stockist');

  assert.equal(provincialAccounts.length, 2);
  assert.equal(cityAccounts.length, 4);
  assert.equal(mobileAccounts.length, 4);

  for (const city of cityAccounts) {
    assert.ok(city.parentEmail, `City ${city.email} should preserve its provincial parent email`);
  }

  for (const mobile of mobileAccounts) {
    assert.ok(mobile.parentEmail, `Mobile ${mobile.email} should preserve its city parent email`);
  }
});

test('production hierarchy seed has a role bootstrap migration preflight', () => {
  const packageJson = require('../package.json');
  const seedSource = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'seedAffiliationHierarchy.js'),
    'utf8'
  );

  assert.equal(
    packageJson.scripts['migrate:city-mobile-logins:prod'],
    'node --env-file=.env.prod scripts/runSqlFile.js sql/add_city_and_mobile_logins_2026_05_07.sql'
  );
  assert.match(seedSource, /Missing required Stockist roles/);
  assert.match(seedSource, /migrate:city-mobile-logins:prod/);
});
