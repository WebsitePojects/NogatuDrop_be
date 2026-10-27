const test = require('node:test');
const assert = require('node:assert/strict');
const { courierTrackingUrl } = require('../src/utils/courierTracking');
const { escapeHtml } = require('../src/utils/escapeHtml');
const { isAllowedRecipient } = require('../src/services/emailService');
const { BUYER_EVENTS, buildBuyerEmail } = require('../src/services/buyerEmails');

test('courier link: the waybill fills the pattern, URL-encoded', () => {
  assert.equal(
    courierTrackingUrl('https://www.jtexpress.ph/track-and-trace?waybillNo={tracking_number}', 'JT0001234567'),
    'https://www.jtexpress.ph/track-and-trace?waybillNo=JT0001234567'
  );
  assert.equal(courierTrackingUrl('https://x.ph/t/{tracking_number}', 'A B&C'), 'https://x.ph/t/A%20B%26C');
});

test('courier link: no link without an http(s) pattern containing the placeholder, or without a waybill', () => {
  assert.equal(courierTrackingUrl(null, 'JT1'), null);
  assert.equal(courierTrackingUrl('https://x.ph/track', 'JT1'), null, 'pattern without placeholder');
  assert.equal(courierTrackingUrl('javascript:alert(1)//{tracking_number}', 'JT1'), null);
  assert.equal(courierTrackingUrl('https://x.ph/{tracking_number}', ''), null);
});

test('escapeHtml turns markup into text', () => {
  assert.equal(escapeHtml('<b>"Ana" & \'Bo\'</b>'), '&lt;b&gt;&quot;Ana&quot; &amp; &#39;Bo&#39;&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
});

test('EMAIL_ALLOWLIST: empty lets everyone through; otherwise only listed addresses or @domains', () => {
  assert.equal(isAllowedRecipient('anyone@gmail.com', []), true);
  const list = ['dino@nogatu.store', '@princeit.ph'];
  assert.equal(isAllowedRecipient('Dino@Nogatu.store', list), true);
  assert.equal(isAllowedRecipient('dev@princeit.ph', list), true);
  assert.equal(isAllowedRecipient('buyer@gmail.com', list), false);
  assert.equal(isAllowedRecipient('evil@notprinceit.ph.example.com', list), false);
});

const order = {
  order_number: 'PUB-1', customer_first_name: 'Maria', customer_name: 'Maria Santos', total_amount: 9911.96,
  payment_deadline: '2026-10-15T06:00:00Z', cancellation_reason: null, status: 'approved',
  courier_name: 'J&T Express', tracking_url_template: 'https://www.jtexpress.ph/q?bills={tracking_number}', courier_tracking_number: 'JT0001',
};

test('every buyer event has a subject, a plain-text part and a link back to the store', () => {
  for (const event of Object.values(BUYER_EVENTS)) {
    const email = buildBuyerEmail(event, order);
    assert.ok(email.subject.includes('PUB-1'), event);
    assert.match(email.html, /\/track\/PUB-1|\/shop"/, event);
    assert.ok(email.text.includes('PUB-1') && !/<[a-z]/i.test(email.text), `${event} text part`);
  }
});

test('on-its-way email shows the courier, waybill and a Track button', () => {
  const email = buildBuyerEmail(BUYER_EVENTS.ON_THE_WAY, order);
  assert.match(email.html, /JT0001/);
  assert.match(email.html, /href="https:\/\/www\.jtexpress\.ph\/q\?bills=JT0001"/);
  assert.match(email.html, /Track with J&amp;T Express/);
  const ownRider = buildBuyerEmail(BUYER_EVENTS.ON_THE_WAY, { ...order, courier_tracking_number: null });
  assert.match(ownRider.html, /Our rider has your order/);
});

test('buyer-typed text is escaped in the email', () => {
  const email = buildBuyerEmail(BUYER_EVENTS.CANCELLED, {
    ...order, customer_first_name: '<img src=x onerror=alert(1)>', cancellation_reason: '<a href="http://evil">x</a>',
  });
  assert.doesNotMatch(email.html, /<img src=x|<a href="http:\/\/evil/);
  assert.match(email.html, /&lt;img src=x/);
});

test('buyer email footer uses the wording management approved (2026-10-27)', () => {
  const footer = 'You received this email because you ordered from the Nogatu Alliance Official Store. Replies to this address are not read.';
  for (const event of Object.values(BUYER_EVENTS)) {
    const email = buildBuyerEmail(event, order);
    assert.ok(email.text.includes(footer) && email.html.includes(footer), event);
  }
});

test('an unknown event fails loudly', () => {
  assert.throws(() => buildBuyerEmail('buyer_unknown', order), /Unknown buyer email event/);
});
