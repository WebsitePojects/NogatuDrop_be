// Login usernames (e.g. "rbere"): lowercase, 3–50 chars, letters/digits plus . _ -, starting with a
// letter or digit. Stored lowercase so the UNIQUE index on users.username is case-insensitive in effect.
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,49}$/;

/** Trimmed, lowercased username, or null when the value is empty. */
function normalizeUsername(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '' ? null : normalized;
}

function isValidUsername(value) {
  return typeof value === 'string' && USERNAME_PATTERN.test(value);
}

/**
 * Username derived from an email's local part ("Golden.Stars1316@gmail.com" -> "golden.stars1316"),
 * or null when the local part cannot form a valid username. Callers must still check uniqueness.
 */
function usernameFromEmail(email) {
  const localPart = String(email || '').split('@')[0].trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return isValidUsername(localPart) ? localPart : null;
}

module.exports = {
  USERNAME_PATTERN,
  normalizeUsername,
  isValidUsername,
  usernameFromEmail,
};
