const { renderEmail, siteUrl } = require('./email/layout');
const { ORDER_STEPS } = require('./email/templates');
const { courierTrackingUrl } = require('../utils/courierTracking');
const { orderCustomerJoins, orderCustomerNameSql, orderIsPublicSql } = require('../utils/orderCustomerSql');

// Status emails to store buyers (management, 2026-10-14). Each one is queued in order_notification_outbox
// inside the same transaction as the status change, by the request that won that change, so a double
// click or a retry queues it once (unique key order_id + event_type + recipient_email). The outbox cron
// sends it with a lease claim and bounded retries.
const BUYER_EVENTS = Object.freeze({
  PLACED: 'buyer_order_placed',
  APPROVED: 'buyer_order_approved',
  PAID: 'buyer_payment_confirmed',
  ON_THE_WAY: 'buyer_on_the_way',
  COURIER: 'buyer_courier_tracking',
  DELIVERED: 'buyer_delivered',
  CANCELLED: 'buyer_order_cancelled',
});
const BUYER_EVENT_SET = new Set(Object.values(BUYER_EVENTS));

/**
 * Queues one buyer email for an order. Only store orders with a buyer email get one; otherwise nothing is
 * queued. Pass the transaction connection of the status change.
 */
async function enqueueBuyerEmail(conn, { orderId, eventType }) {
  if (!BUYER_EVENT_SET.has(eventType)) throw new Error(`Unknown buyer email event "${eventType}"`);
  await conn.execute(
    `INSERT INTO order_notification_outbox (order_id, user_id, recipient_email, event_type, order_number, status, available_at)
     SELECT o.id, NULL, o.customer_email, ?, o.order_number, 'pending', NOW()
     FROM orders o
     WHERE o.id = ? AND o.customer_email IS NOT NULL AND o.customer_email <> '' AND ${orderIsPublicSql('o')}
     ON DUPLICATE KEY UPDATE order_notification_outbox.id = order_notification_outbox.id`,
    [eventType, orderId]
  );
}

/** What a buyer email needs about its order, read at send time so it shows the current courier and status. */
async function loadBuyerEmailOrder(db, orderId) {
  const [rows] = await db.execute(
    `SELECT o.order_number, o.customer_first_name, ${orderCustomerNameSql('o')} AS customer_name,
            o.total_amount, o.payment_deadline, o.cancellation_reason, o.status,
            c.name AS courier_name, c.tracking_url_template, dt.courier_tracking_number
     FROM orders o
     ${orderCustomerJoins('o')}
     LEFT JOIN delivery_tracking dt ON dt.order_id = o.id
     LEFT JOIN couriers c ON c.id = dt.courier_id
     WHERE o.id = ? LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

const peso = (value) => `PHP ${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const manilaTime = (value) => (value ? new Date(value).toLocaleString('en-PH', {
  timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}) : null);

function trackingPageUrl(orderNumber) {
  return siteUrl(`/track/${encodeURIComponent(orderNumber)}`);
}

const BUYER_FOOTER = 'You received this email because you ordered from the Nogatu Alliance Official Store. Replies to this address are not read.';
const firstName = (order) => order.customer_first_name || String(order.customer_name || '').split(' ')[0] || 'there';
const trackButton = (order, label = 'Track your order') => ({ label, href: trackingPageUrl(order.order_number) });
const progress = (current, cancelled = false) => ({ steps: { labels: ORDER_STEPS, current, cancelled } });

/** Courier blocks for an order shipped with J&T/LBC/Flash; empty when our own rider delivers. */
function courierBlocks(order) {
  if (!order.courier_tracking_number) return [];
  const courier = order.courier_name || 'the courier';
  const url = courierTrackingUrl(order.tracking_url_template, order.courier_tracking_number);
  return [
    { details: [['Shipped with', courier], ['Waybill number', order.courier_tracking_number, true]] },
    { actions: [...(url ? [{ label: `Track with ${courier}`, href: url }] : []), trackButton(order, 'Our tracking page')] },
    { p: "If the courier's page asks for it, enter the waybill number above." },
  ];
}

/** Subject, HTML and text for one buyer email (shared designed layout; every value escaped there). */
function buildBuyerEmail(eventType, order) {
  const num = order.order_number;
  const base = { eyebrow: `Order #${num}`, greeting: `Hi ${firstName(order)},`, footerNote: BUYER_FOOTER };
  switch (eventType) {
    case BUYER_EVENTS.PLACED:
      return renderEmail({
        ...base, subject: `We received your order #${num}`, preheader: 'We will email you once it is approved, with how to pay.',
        heading: 'Thank you for your order',
        blocks: [progress(0), { details: [['Order', `#${num}`, true], ['Total', peso(order.total_amount)]] },
          { p: 'We will email you once the order is approved, with how to pay.' }, { actions: [trackButton(order)] }],
      });
    case BUYER_EVENTS.APPROVED: {
      const due = manilaTime(order.payment_deadline);
      return renderEmail({
        ...base, subject: `Order #${num} approved: please pay${due ? ` by ${due}` : ''}`,
        preheader: `Pay ${peso(order.total_amount)}${due ? ` by ${due}` : ''} to confirm your order.`,
        heading: 'Your order is approved',
        blocks: [progress(1), { highlight: { label: 'Amount to pay', value: peso(order.total_amount) } },
          ...(due ? [{ notice: { tone: 'warn', text: `Please pay by ${due}, or the order is cancelled.` } }] : []),
          { p: 'Open your tracking page and enter the mobile number you used at checkout. It shows the Nogatu account to pay; then upload a photo of your receipt there.' },
          { actions: [trackButton(order, 'Pay and upload receipt')] }],
      });
    }
    case BUYER_EVENTS.PAID:
      return renderEmail({
        ...base, subject: `Payment confirmed for order #${num}`, preheader: 'We are preparing your order.',
        heading: 'Payment confirmed',
        blocks: [progress(2), { p: 'We received your payment and are preparing your order. We will email you when it is on its way.' }, { actions: [trackButton(order)] }],
      });
    case BUYER_EVENTS.ON_THE_WAY:
      return renderEmail({
        ...base, subject: `Your order #${num} is on its way`,
        preheader: order.courier_name && order.courier_tracking_number ? `Shipped with ${order.courier_name}.` : 'Follow the rider on the map.',
        heading: 'Your order is on its way',
        blocks: [progress(3), ...(courierBlocks(order).length ? courierBlocks(order)
          : [{ p: 'Our rider has your order. Follow the rider on the map from your tracking page.' }, { actions: [trackButton(order, 'Follow the rider')] }])],
      });
    case BUYER_EVENTS.COURIER:
      return renderEmail({
        ...base, subject: `Track your parcel: order #${num}`, preheader: `Waybill ${order.courier_tracking_number || ''}`.trim(),
        heading: 'Track your parcel', blocks: [progress(3), ...courierBlocks(order)],
      });
    case BUYER_EVENTS.DELIVERED:
      return renderEmail({
        ...base, subject: `Order #${num} delivered`, preheader: 'Thank you for shopping with Nogatu Alliance.',
        heading: 'Your order was delivered',
        blocks: [progress(4), { p: 'Thank you for shopping with Nogatu Alliance. We hope you enjoy your order.' }, { actions: [{ label: 'Shop again', href: siteUrl('/shop') }] }],
      });
    case BUYER_EVENTS.CANCELLED:
      return renderEmail({
        ...base, subject: `Order #${num} cancelled`, preheader: 'This order will not be shipped.',
        heading: 'Your order was cancelled',
        blocks: [progress(0, true), { notice: { tone: 'bad', text: order.cancellation_reason ? `Reason: ${order.cancellation_reason}` : 'This order will not be shipped.' } },
          { p: 'If you already paid, please contact us with your order number.' }, { actions: [{ label: 'Shop again', href: siteUrl('/shop') }] }],
      });
    default:
      throw new Error(`Unknown buyer email event "${eventType}"`);
  }
}

module.exports = { BUYER_EVENTS, BUYER_EVENT_SET, enqueueBuyerEmail, loadBuyerEmailOrder, buildBuyerEmail, trackingPageUrl };
