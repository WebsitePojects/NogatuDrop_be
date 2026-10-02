const geoip = require('geoip-country');
const env = require('../config/env');

// Signals that make a correct password insufficient: the person must also enter a code sent to the
// account's email, and Super Admin is alerted. Chosen by management on 2026-10-03.
const LOGIN_FLAGS = Object.freeze({
  FOREIGN_COUNTRY: 'foreign_country', // signed in from outside the home countries (default PH)
  QUIET_HOURS: 'quiet_hours', // signed in during the overnight window, Manila time
  FAILED_ATTEMPTS: 'failed_attempts', // several wrong passwords just before this one
  NEW_COUNTRY: 'new_country', // first sign-in from this country for an account with history
});

const MANILA_HOUR = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', hourCycle: 'h23' });

/** ISO country code for an IP using the bundled offline GeoLite2 data; null for private/unknown IPs. */
function countryForIp(ip) {
  if (!ip) return null;
  const match = geoip.lookup(String(ip));
  return match && match.country ? match.country : null;
}

function manilaHour(date = new Date()) {
  return Number(MANILA_HOUR.format(date));
}

/** "0-5" -> { start: 0, end: 5 }: hours 0..4 inclusive. Fails loudly on a malformed setting. */
function parseHourWindow(text) {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(String(text).trim());
  const start = match ? Number(match[1]) : NaN;
  const end = match ? Number(match[2]) : NaN;
  if (!(start >= 0 && start <= 23 && end >= 1 && end <= 24 && start !== end)) {
    throw new Error(`LOGIN_QUIET_HOURS must look like "0-5" (start-end, 24h clock); got "${text}"`);
  }
  return { start, end };
}

function isInHourWindow(hour, { start, end }) {
  return start < end ? hour >= start && hour < end : hour >= start || hour < end; // wraps past midnight
}

function loginRiskPolicy() {
  return {
    homeCountries: env.LOGIN_HOME_COUNTRIES,
    quietHours: parseHourWindow(env.LOGIN_QUIET_HOURS),
    failedAttemptsThreshold: env.LOGIN_FAILED_ATTEMPTS_THRESHOLD,
  };
}

/**
 * Flags for a sign-in whose password was correct. An unknown country (private IP, local network)
 * raises no country flag rather than guessing.
 *
 * @param {object} signal
 * @param {string|null} signal.country       ISO code of the sign-in IP
 * @param {number} signal.hour               Manila hour 0-23
 * @param {number} signal.recentFailures     wrong passwords since the last good sign-in, within the window
 * @param {string[]} signal.knownCountries   countries of this account's earlier good sign-ins
 * @param {number} signal.successfulLogins   earlier good sign-ins (0 for a brand-new account)
 */
function evaluateLoginRisk(signal, policy = loginRiskPolicy()) {
  const flags = [];
  const { country, hour, recentFailures = 0, knownCountries = [], successfulLogins = 0 } = signal;

  if (country && !policy.homeCountries.includes(country)) flags.push(LOGIN_FLAGS.FOREIGN_COUNTRY);
  if (isInHourWindow(hour, policy.quietHours)) flags.push(LOGIN_FLAGS.QUIET_HOURS);
  if (recentFailures >= policy.failedAttemptsThreshold) flags.push(LOGIN_FLAGS.FAILED_ATTEMPTS);
  // A first-ever sign-in has no history to compare with, so it cannot be "new".
  if (country && successfulLogins > 0 && !knownCountries.includes(country)) flags.push(LOGIN_FLAGS.NEW_COUNTRY);

  return flags;
}

module.exports = {
  LOGIN_FLAGS,
  countryForIp,
  manilaHour,
  parseHourWindow,
  isInHourWindow,
  loginRiskPolicy,
  evaluateLoginRisk,
};
