const crypto = require('crypto');
const ApiError = require('./ApiError');

// Every NEW password (create user, add Stockist, Edit User, reset with a code): at least 8 characters with a
// letter, a number and a symbol ("alphanumeric & characters", Sir Dino 2026-11-10). Login never checks this,
// so existing passwords keep working until their owner changes them.
// The screens show the same rule from NogatuDrop_fe/src/utils/passwordPolicy.js.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72; // bcrypt ignores every byte after 72
const PASSWORD_RULE_TEXT = `At least ${MIN_PASSWORD_LENGTH} characters, with a letter, a number and a symbol (for example ! @ # $).`;

/** What is wrong with a proposed password, or null when it is allowed. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (!/[A-Za-z]/.test(password)) return 'Password must include a letter';
  if (!/[0-9]/.test(password)) return 'Password must include a number';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Password must include a symbol, for example ! @ # $';
  return null;
}

function assertNewPasswordAllowed(password) {
  const problem = passwordProblem(password);
  if (problem) throw ApiError.badRequest(problem);
}

/** express-validator custom check with the same rule, for route chains. */
function newPasswordValidator(value) {
  const problem = passwordProblem(value);
  if (problem) throw new Error(problem);
  return true;
}

/** A random password that satisfies the rule, for accounts created before their owner picks one. */
function generateTemporaryPassword() {
  return `Ng@${crypto.randomBytes(6).toString('base64url')}${crypto.randomInt(10)}`;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULE_TEXT,
  passwordProblem,
  assertNewPasswordAllowed,
  newPasswordValidator,
  generateTemporaryPassword,
};
