const env = require('../../config/env');

// Sends one message through the configured provider. Resend is the provider (management, 2026-10-14);
// Brevo stays as the fallback while the nogatu.store domain is being verified in Resend.
//
// Errors carry `retryable`: rate limits, quota and server errors are retried by the outbox; bad requests,
// an unverified domain or a revoked key are not (retrying cannot fix them).

const RESEND_URL = 'https://api.resend.com/emails';
const REQUEST_TIMEOUT_MS = 15000;

const usable = (key) => {
  const k = String(key || '').trim();
  return Boolean(k) && !k.toLowerCase().startsWith('your_');
};

/** 'resend', 'brevo' or null when nothing is configured. EMAIL_PROVIDER wins; otherwise Resend if keyed. */
function activeProvider() {
  const chosen = String(env.EMAIL_PROVIDER || '').toLowerCase();
  if (chosen === 'resend') return usable(env.RESEND_API_KEY) ? 'resend' : null;
  if (chosen === 'brevo') return usable(env.BREVO_API_KEY) ? 'brevo' : null;
  if (usable(env.RESEND_API_KEY)) return 'resend';
  if (usable(env.BREVO_API_KEY)) return 'brevo';
  return null;
}

function providerError(message, { status = null, retryable = false, code = null } = {}) {
  const err = new Error(message);
  err.status = status;
  err.retryable = retryable;
  err.code = code;
  return err;
}

/**
 * Resend. The idempotency key (24h on Resend's side) makes a retried send a no-op; if the earlier attempt
 * went through and the body changed since, Resend answers 409 invalid_idempotent_request, which means
 * "already sent" and is reported as such, not re-sent.
 */
async function sendWithResend({ to, subject, html, text, idempotencyKey }) {
  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);
  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from: `${env.EMAIL_FROM_NAME} <${env.EMAIL_FROM}>`, to, subject, html, text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw providerError(`Resend unreachable: ${err.message}`, { retryable: true });
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { sent: true, id: body.id || null };
  const code = body.name || body.type || null;
  if (res.status === 409 && code === 'invalid_idempotent_request') return { sent: true, duplicate: true };
  const retryable = res.status === 429 || res.status >= 500 || (res.status === 409 && code !== 'invalid_idempotent_request');
  throw providerError(`Resend ${res.status} ${code || ''}: ${body.message || 'request failed'}`.trim(), { status: res.status, retryable, code });
}

let brevoClient = null;
async function sendWithBrevo({ to, toName, subject, html }) {
  if (!brevoClient) {
    const { BrevoClient } = require('@getbrevo/brevo');
    brevoClient = new BrevoClient({ apiKey: env.BREVO_API_KEY });
  }
  const recipients = to.map((email, i) => (i === 0 && toName ? { email, name: toName } : { email }));
  try {
    await brevoClient.transactionalEmails.sendTransacEmail({
      sender: { name: env.EMAIL_FROM_NAME, email: env.EMAIL_FROM }, to: recipients, subject, htmlContent: html,
    });
    return { sent: true };
  } catch (err) {
    throw providerError(`Brevo: ${err?.message || err}`, { retryable: true });
  }
}

/** @param {{ to: string[], toName?: string, subject: string, html: string, text?: string, idempotencyKey?: string }} message */
async function deliver(message) {
  const provider = activeProvider();
  if (provider === 'resend') return sendWithResend(message);
  if (provider === 'brevo') return sendWithBrevo(message);
  throw providerError('Email transport is not configured', { retryable: false, code: 'not_configured' });
}

module.exports = { deliver, activeProvider };
