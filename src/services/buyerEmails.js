const env = require('../config/env');
const { escapeHtml } = require('../utils/escapeHtml');
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
  return `${String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')}/track/${encodeURIComponent(orderNumber)}`;
}

function button(href, label) {
  return `<p style="margin:20px 0"><a href="${escapeHtml(href)}" style="background:#B85C00;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">${escapeHtml(label)}</a></p>`;
}

function layout(order, heading, bodyHtml) {
  const first = order.customer_first_name || String(order.customer_name || '').split(' ')[0] || 'there';
  return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:560px">
  <p>Hi ${escapeHtml(first)},</p>
  <h2 style="color:#3D1800;font-size:20px;margin:16px 0 8px">${escapeHtml(heading)}</h2>
  ${bodyHtml}
  ${button(trackingPageUrl(order.order_number), 'Track your order')}
  <p style="color:#6b7280;font-size:13px">Order #${escapeHtml(order.order_number)}. This email was sent by the Nogatu Alliance Official Store. Please do not reply to it.</p>
</div>`;
}

function courierBlock(order) {
  if (!order.courier_tracking_number) return '';
  const url = courierTrackingUrl(order.tracking_url_template, order.courier_tracking_number);
  const courier = order.courier_name || 'the courier';
  return `<p>Shipped with <strong>${escapeHtml(courier)}</strong>. Waybill number: <strong>${escapeHtml(order.courier_tracking_number)}</strong>.</p>
  ${url ? button(url, `Track with ${courier}`) : ''}
  <p style="color:#6b7280;font-size:13px">If the courier's page asks for it, enter the waybill number above.</p>`;
}

/** Subject and HTML for one buyer email. Every value from the order is escaped. */
function buildBuyerEmail(eventType, order) {
  const num = order.order_number;
  switch (eventType) {
    case BUYER_EVENTS.PLACED:
      return {
        subject: `We received your order #${num}`,
        html: layout(order, 'Thank you for your order', `<p>Your order total is <strong>${peso(order.total_amount)}</strong>. We will email you once it is approved, with how to pay.</p>`),
      };
    case BUYER_EVENTS.APPROVED: {
      const due = manilaTime(order.payment_deadline);
      return {
        subject: `Order #${num} approved: please pay${due ? ` by ${due}` : ''}`,
        html: layout(order, 'Your order is approved', `<p>Please pay <strong>${peso(order.total_amount)}</strong>${due ? ` by <strong>${escapeHtml(due)}</strong>` : ''}, or the order is cancelled.</p>
  <p>Open your tracking page, enter the mobile number you used at checkout to see the Nogatu account, then upload a photo of your receipt.</p>`),
      };
    }
    case BUYER_EVENTS.PAID:
      return { subject: `Payment confirmed for order #${num}`, html: layout(order, 'Payment confirmed', '<p>We received your payment and are preparing your order. We will email you when it is on its way.</p>') };
    case BUYER_EVENTS.ON_THE_WAY:
      return {
        subject: `Your order #${num} is on its way`,
        html: layout(order, 'Your order is on its way', `${courierBlock(order) || '<p>Our rider has your order. Follow the rider on the map from your tracking page.</p>'}`),
      };
    case BUYER_EVENTS.COURIER:
      return { subject: `Courier tracking for order #${num}`, html: layout(order, 'Track your parcel', courierBlock(order)) };
    case BUYER_EVENTS.DELIVERED:
      return { subject: `Order #${num} delivered`, html: layout(order, 'Your order was delivered', '<p>Thank you for shopping with Nogatu Alliance.</p>') };
    case BUYER_EVENTS.CANCELLED:
      return {
        subject: `Order #${num} cancelled`,
        html: layout(order, 'Your order was cancelled', `<p>${order.cancellation_reason ? `Reason: ${escapeHtml(order.cancellation_reason)}` : 'This order will not be shipped.'}</p>
  <p>If you already paid, please contact us with your order number.</p>`),
      };
    default:
      throw new Error(`Unknown buyer email event "${eventType}"`);
  }
}

module.exports = { BUYER_EVENTS, BUYER_EVENT_SET, enqueueBuyerEmail, loadBuyerEmailOrder, buildBuyerEmail, trackingPageUrl };
