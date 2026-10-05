const crypto = require('crypto');

/**
 * A Philippine mobile number reduced to its last 10 digits (9XXXXXXXXX), so "0917 123 4567",
 * "09171234567" and "+63 917 123 4567" are the same number. Null when there are fewer than 10 digits.
 */
function phoneKey(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * True when two phone numbers are the same. The phone is the only secret a public buyer has for their
 * order, so the comparison runs in constant time.
 */
function phonesMatch(provided, stored) {
  const a = phoneKey(provided);
  const b = phoneKey(stored);
  if (!a || !b) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { phoneKey, phonesMatch };
