const env = require('../config/env');
const { deliver } = require('./email/transport');
const { EMAIL } = require('./email/templates');

/** True when EMAIL_ALLOWLIST is empty, or lists this address or its @domain. */
function isAllowedRecipient(email, allowlist = env.EMAIL_ALLOWLIST) {
  if (!allowlist || allowlist.length === 0) return true;
  const address = String(email || '').trim().toLowerCase();
  return allowlist.some((entry) => (entry.startsWith('@') ? address.endsWith(entry) : address === entry));
}

/**
 * Sends one transactional email through the configured provider (services/email/transport.js).
 * Returns { sent: true }, { sent: false, skipped: true } when EMAIL_ALLOWLIST filtered out every recipient
 * (final, not a failure), or { sent: false } on a failure that was not thrown.
 *
 * @param {object}  message
 * @param {string|string[]} message.to
 * @param {string}  [message.toName]
 * @param {string}  message.subject
 * @param {string}  message.html
 * @param {string}  [message.text]            plain-text part (templates provide one)
 * @param {string}  [message.idempotencyKey]  the same key for every retry of one email (outbox row id)
 * @param {boolean} [message.throwOnFailure]  callers that retry (the outbox) want the error
 */
async function sendEmail({ to, toName, subject, html, text, idempotencyKey, throwOnFailure = false }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter((address) => address && isAllowedRecipient(address));
  if (recipients.length === 0) {
    console.log(`[Email] Skipped (recipient not on EMAIL_ALLOWLIST): ${subject}`);
    return { sent: false, skipped: true };
  }
  try {
    return await deliver({ to: recipients, toName, subject, html, text, idempotencyKey });
  } catch (err) {
    if (throwOnFailure) throw err;
    if (err.code === 'not_configured') {
      console.log(`[Email] No email provider configured - skipping: ${subject}`);
    } else {
      console.error('[Email] Failed to send:', err.message);
    }
    return { sent: false };
  }
}

module.exports = { sendEmail, isAllowedRecipient, EMAIL };
