const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOGIN_FLAGS, countryForIp, manilaHour, parseHourWindow, isInHourWindow, evaluateLoginRisk,
} = require('../src/services/loginRisk');

const policy = { homeCountries: ['PH'], quietHours: { start: 0, end: 5 }, failedAttemptsThreshold: 5 };
const normal = { country: 'PH', hour: 14, recentFailures: 0, knownCountries: ['PH'], successfulLogins: 3 };

test('an ordinary daytime sign-in from the Philippines raises no flag', () => {
  assert.deepEqual(evaluateLoginRisk(normal, policy), []);
});

test('a 3am sign-in from Egypt by an account that only ever used PH raises country, hour and new-country flags', () => {
  assert.deepEqual(
    evaluateLoginRisk({ ...normal, country: 'EG', hour: 3 }, policy),
    [LOGIN_FLAGS.FOREIGN_COUNTRY, LOGIN_FLAGS.QUIET_HOURS, LOGIN_FLAGS.NEW_COUNTRY]
  );
});

test('quiet hours cover midnight to 4:59 and not 5am', () => {
  assert.deepEqual(evaluateLoginRisk({ ...normal, hour: 0 }, policy), [LOGIN_FLAGS.QUIET_HOURS]);
  assert.deepEqual(evaluateLoginRisk({ ...normal, hour: 4 }, policy), [LOGIN_FLAGS.QUIET_HOURS]);
  assert.deepEqual(evaluateLoginRisk({ ...normal, hour: 5 }, policy), []);
});

test('five wrong passwords before a good one flag it; four do not', () => {
  assert.deepEqual(evaluateLoginRisk({ ...normal, recentFailures: 5 }, policy), [LOGIN_FLAGS.FAILED_ATTEMPTS]);
  assert.deepEqual(evaluateLoginRisk({ ...normal, recentFailures: 4 }, policy), []);
});

test('an unknown country (private network) raises no country flag; a first-ever sign-in is never "new country"', () => {
  assert.deepEqual(evaluateLoginRisk({ ...normal, country: null }, policy), []);
  assert.deepEqual(evaluateLoginRisk({ ...normal, knownCountries: [], successfulLogins: 0 }, policy), []);
});

test('quiet hour windows can wrap past midnight', () => {
  const window = parseHourWindow('22-5');
  assert.equal(isInHourWindow(23, window), true);
  assert.equal(isInHourWindow(2, window), true);
  assert.equal(isInHourWindow(12, window), false);
});

test('a malformed quiet-hours setting fails loudly instead of disabling the check', () => {
  for (const bad of ['', 'midnight', '5-5', '25-3', '0-25']) {
    assert.throws(() => parseHourWindow(bad), /LOGIN_QUIET_HOURS/, bad);
  }
});

test('country lookup is offline and returns null for private and loopback addresses', () => {
  assert.equal(countryForIp('112.198.0.1'), 'PH');
  assert.equal(countryForIp('41.33.0.1'), 'EG');
  assert.equal(countryForIp('::ffff:112.198.0.1'), 'PH');
  assert.equal(countryForIp('127.0.0.1'), null);
  assert.equal(countryForIp('192.168.1.5'), null);
  assert.equal(countryForIp(null), null);
});

test('Manila hour is UTC+8 regardless of the server clock zone', () => {
  assert.equal(manilaHour(new Date('2026-10-03T19:30:00Z')), 3);
  assert.equal(manilaHour(new Date('2026-10-03T06:00:00Z')), 14);
});
