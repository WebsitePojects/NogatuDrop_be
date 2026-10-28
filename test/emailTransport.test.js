const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../src/config/env');
const { deliver, activeProvider } = require('../src/services/email/transport');
const { EMAIL } = require('../src/services/email/templates');
const { sendEmail, isUndeliverableAddress } = require('../src/services/emailService');

const realFetch = global.fetch;
const saved = {
  EMAIL_PROVIDER: env.EMAIL_PROVIDER, RESEND_API_KEY: env.RESEND_API_KEY, BREVO_API_KEY: env.BREVO_API_KEY,
  EMAIL_ALLOWLIST: env.EMAIL_ALLOWLIST, EMAIL_SUBJECT_PREFIX: env.EMAIL_SUBJECT_PREFIX,
};
test.afterEach(() => { global.fetch = realFetch; Object.assign(env, saved); });

function fakeResend(status, body) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}
const message = { to: ['buyer@example.com'], subject: 'Hi', html: '<p>x</p>', text: 'x', idempotencyKey: 'ncdms-outbox-7' };

test('provider: Resend when keyed, Brevo as fallback, EMAIL_PROVIDER wins, none when unkeyed', () => {
  Object.assign(env, { EMAIL_PROVIDER: '', RESEND_API_KEY: 're_123', BREVO_API_KEY: 'xkeysib-1' });
  assert.equal(activeProvider(), 'resend');
  Object.assign(env, { EMAIL_PROVIDER: 'brevo' });
  assert.equal(activeProvider(), 'brevo');
  Object.assign(env, { EMAIL_PROVIDER: '', RESEND_API_KEY: '' });
  assert.equal(activeProvider(), 'brevo');
  Object.assign(env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: '' });
  assert.equal(activeProvider(), null, 'asked for Resend without a key: nothing, not a silent Brevo send');
});

test('Resend: sends from Nogatu with the bearer key and the idempotency key', async () => {
  Object.assign(env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' });
  const calls = fakeResend(200, { id: 'abc' });
  assert.deepEqual(await deliver(message), { sent: true, id: 'abc' });
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.headers.Authorization, 'Bearer re_test');
  assert.equal(init.headers['Idempotency-Key'], 'ncdms-outbox-7');
  const body = JSON.parse(init.body);
  assert.match(body.from, /^Nogatu Alliance <noreply@nogatu\.store>$/);
  assert.deepEqual(body.to, ['buyer@example.com']);
  assert.equal(body.text, 'x');
});

test('Resend: a reused key with a changed body means it was already sent, not a resend', async () => {
  Object.assign(env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' });
  fakeResend(409, { name: 'invalid_idempotent_request', message: 'changed' });
  assert.deepEqual(await deliver(message), { sent: true, duplicate: true });
});

test('Resend: rate limits and server errors are retried; bad requests and domain errors are not', async () => {
  Object.assign(env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' });
  for (const [status, name, retryable] of [[429, 'rate_limit_exceeded', true], [500, 'application_error', true],
    [409, 'concurrent_idempotent_requests', true], [422, 'missing_required_field', false], [403, 'validation_error', false]]) {
    fakeResend(status, { name, message: 'no' });
    await assert.rejects(deliver(message), (err) => err.status === status && err.retryable === retryable, `${status} ${name}`);
  }
  global.fetch = async () => { throw new Error('socket hang up'); };
  await assert.rejects(deliver(message), (err) => err.retryable === true);
});

test('no provider configured fails with a clear, non-retryable error', async () => {
  Object.assign(env, { EMAIL_PROVIDER: '', RESEND_API_KEY: '', BREVO_API_KEY: '' });
  await assert.rejects(deliver(message), (err) => err.code === 'not_configured' && err.retryable === false);
});

test('every staff email renders with subject, HTML and text, and escapes names', () => {
  const samples = {
    orderPlaced: ['ORD-1', '<b>Shop</b>'], orderApproved: ['ORD-1', 24, 'BDO · Nogatu · 0065'], paymentProofUploaded: ['ORD-1', 'City'],
    paymentVerified: ['ORD-1'], riderDispatched: ['ORD-1', 'J&T', 'JT1'], orderDelivered: ['ORD-1'], orderCancelledDeadline: ['ORD-1'],
    orderRejected: ['ORD-1', 'Out of stock'], lowStock: ['Berry', 'TYCOON', 4], autoPO: ['PO-1', 'Berry'], grnDiscrepancy: ['G-1', 'Berry', 10, 8],
    batchExpiry: ['Berry', '2026-11-01', 'TYCOON'], dtaReceived: ['Ana', 'Ana Store'], dtaApproved: ['Ana', 'ana@example.com', 'Temp#123'],
    passwordReset: ['123456'],
  };
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(EMAIL).sort(), 'a sample for every template');
  for (const [name, args] of Object.entries(samples)) {
    const email = EMAIL[name](...args);
    assert.ok(email.subject && email.html.startsWith('<!DOCTYPE html>') && email.text, name);
  }
  assert.doesNotMatch(EMAIL.orderPlaced('ORD-1', '<b>Shop</b>').html, /<b>Shop<\/b>/);
  assert.match(EMAIL.passwordReset('123456').text, /123456/);
});

test('placeholder and malformed addresses are never sent to, on any environment', () => {
  for (const address of ['demo.admin@example.com', 'x@example.org', 'a@shop.test', 'b@foo.invalid', 'c@host.localhost', 'not-an-email', '']) {
    assert.equal(isUndeliverableAddress(address), true, address);
  }
  for (const address of ['dyno.erfe@gmail.com', 'ana@nogatu.store', 'sam@examples.com', 'kim@example.com.ph']) {
    assert.equal(isUndeliverableAddress(address), false, address);
  }
});

test('with no allowlist everyone gets mail, the staging prefix leads the subject, placeholders are skipped', async () => {
  Object.assign(env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_ALLOWLIST: [], EMAIL_SUBJECT_PREFIX: '[TEST]' });
  const calls = fakeResend(200, { id: 'm1' });
  assert.deepEqual(await sendEmail({ to: 'buyer@gmail.com', subject: 'Order #1 delivered', html: '<p>x</p>', text: 'x' }), { sent: true, id: 'm1' });
  assert.equal(JSON.parse(calls[0].init.body).subject, '[TEST] Order #1 delivered');

  const skipped = await sendEmail({ to: 'demo.admin@example.com', subject: 'Hi', html: '<p>x</p>', text: 'x' });
  assert.deepEqual(skipped, { sent: false, skipped: true, reason: 'placeholder or invalid address' });
  assert.equal(calls.length, 1, 'nothing sent to a placeholder address');

  // A mix sends only to the real address.
  await sendEmail({ to: ['demo@example.com', 'ana@nogatu.store'], subject: 'Hi', html: '<p>x</p>', text: 'x' });
  assert.deepEqual(JSON.parse(calls[1].init.body).to, ['ana@nogatu.store']);
});

test('live keeps the subject as written when no prefix is set', async () => {
  Object.assign(env, { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_ALLOWLIST: [], EMAIL_SUBJECT_PREFIX: '' });
  const calls = fakeResend(200, { id: 'm2' });
  await sendEmail({ to: 'buyer@gmail.com', subject: 'Order #1 delivered', html: '<p>x</p>', text: 'x' });
  assert.equal(JSON.parse(calls[0].init.body).subject, 'Order #1 delivered');
});
