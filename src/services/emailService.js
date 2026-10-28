const env = require('../config/env');
const { deliver } = require('./email/transport');
const { EMAIL } = require('./email/templates');

// Domains reserved for examples and tests (RFC 2606 / 6761). Demo accounts use them; mail sent there bounces,
// and bounces count against the sender's reputation, so they are never sent to, on any environment.
const RESERVED_DOMAIN = /@(example\.(com|net|org)|[^@]+\.(test|example|invalid|localhost))$/i;

/** True for an address that cannot receive mail: malformed, or on a reserved example/test domain. */
function isUndeliverableAddress(email) {
  const address = String(email || '').trim();
  return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || RESERVED_DOMAIN.test(address);
}

/** True when EMAIL_ALLOWLIST is empty, or lists this address or its @domain. */
function isAllowedRecipient(email, allowlist = env.EMAIL_ALLOWLIST) {
  if (!allowlist || allowlist.length === 0) return true;
  const address = String(email || '').trim().toLowerCase();
  return allowlist.some((entry) => (entry.startsWith('@') ? address.endsWith(entry) : address === entry));
}

/**
 * Sends one transactional email through the configured provider (services/email/transport.js).
 * Returns { sent: true }; { sent: false, skipped: true, reason } when every recipient was filtered out (a
 * placeholder address, or not on EMAIL_ALLOWLIST: final, not a failure); or { sent: false } on a failure that
 * was not thrown. EMAIL_SUBJECT_PREFIX, when set, goes in front of the subject.
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
  const deliverable = (Array.isArray(to) ? to : [to]).filter((address) => address && !isUndeliverableAddress(address));
  const recipients = deliverable.filter((address) => isAllowedRecipient(address));
  if (recipients.length === 0) {
    const reason = deliverable.length === 0 ? 'placeholder or invalid address' : 'recipient not on EMAIL_ALLOWLIST';
    console.log(`[Email] Skipped (${reason}): ${subject}`);
    return { sent: false, skipped: true, reason };
  }
  const fullSubject = env.EMAIL_SUBJECT_PREFIX ? `${env.EMAIL_SUBJECT_PREFIX} ${subject}` : subject;
  try {
    return await deliver({ to: recipients, toName, subject: fullSubject, html, text, idempotencyKey });
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

module.exports = { sendEmail, isAllowedRecipient, isUndeliverableAddress, EMAIL };
